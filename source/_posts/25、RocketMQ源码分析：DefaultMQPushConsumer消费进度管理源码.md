---

layout:  25、RocketMQ源码分析：DefaultMQPushConsumer消费进度管理源码

title:   25、RocketMQ源码分析：DefaultMQPushConsumer消费进度管理源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713350

abbrlink: 1739713350

date: 2025-02-16 21:42:06


--- 

# 25、RocketMQ源码分析：DefaultMQPushConsumer消费进度管理源码

分类：[RocketMQ源码分析（1）](https://cxykk.com/?cat=318)  2024-03-27 阅读(160)

DefaultMQPushConsumer的消费进度由OffsetStore这个类提供统一的API来进行管理。集群模式使用RemoteBrokerOffsetStore实现类，广播模式使用LocalFileOffsetStore实现类。

#### 文章目录

- 1 load启动加载消费偏移量
- 2 readOffset读取offset
- 3 updateOffset消费完成更新内存offset
- 4 persistAllConsumerOffset定时持久化offset
- 5 persistAll持久化所有offset
-
    - 5.1 updateConsumeOffsetToBroker上报offset到Broker
- 5.2 broker处理更新offset请求

## 1 load启动加载消费偏移量

消费者启动时，DefaultMQPushConsumer构造器中的start方法内部会调用Offset#load方法初始化消费偏移量。

LocalFileOffsetStore会加载本地磁盘中的数据，RemoteBrokerOffsetStore则是一个空实现。

LocalFileOffsetStore的load方法，从本地文件恢复offset配置，地址为{user.home}/.rocketmq_offsets/{clientId}/{groupName}/offsets.json，配置在文件中以json形式存在。

```java
/**
 * LocalFileOffsetStore
 * <p>
 * 广播消费模式下，从本地文件恢复offset配置。
 */
@Override
public void load() throws MQClientException {
   
     
    //加载本地offset文件 地址为{user.home}/.rocketmq_offsets/{clientId}/{groupName}/offsets.json
    //配置在文件中以json形式存在
    OffsetSerializeWrapper offsetSerializeWrapper = this.readLocalOffset();

    if (offsetSerializeWrapper != null && offsetSerializeWrapper.getOffsetTable() != null) {
   
     
        offsetTable.putAll(offsetSerializeWrapper.getOffsetTable());

        for (Entry<MessageQueue, AtomicLong> mqEntry : offsetSerializeWrapper.getOffsetTable().entrySet()) {
   
     
            AtomicLong offset = mqEntry.getValue();
            log.info("load consumer's offset, {} {} {}",
                    this.groupName,
                    mqEntry.getKey(),
                    offset.get());
        }
    }
}
```

RemoteBrokerOffsetStore的load方法则是一个空实现。

```java
/**
 * RemoteBrokerOffsetStore
 */
@Override
public void load() {
   
     
}
```

## 2 readOffset读取offset

负载均衡分配到新的消息队列时需要获取最新offset，以及集群模式拉取消息时都需要获取最新offset上报给broekr。

该方法获取当前消费者组的offset，有三种读取类型：

**1、** **READ_FROM_MEMORY**：仅从本地内存offsetTable读取；
**2、** **READ_FROM_STORE**：仅从存储服务中读取，可能是本地文件或者broker中读取；
**3、** **MEMORY_FIRST_THEN_STORE**：先从本地内存offsetTable读取，读不到再从存储服务中读取；

当出现异常或者是在本地或者broker没有找到对于消费者组的offset记录，则算作第一次启动该消费者组，那么返回-1。

RemoteBrokerOffsetStore的offset存储服务是broker，因此READ_FROM_STORE就是从broker中读取，该方法的源码我们在DefaultMQPushConsumer负载均衡服务部分就讲过了。

```java
/**
 * RemoteBrokerOffsetStore的方法
 * <p>
 * 获取offset
 *
 * @param mq   需要获取offset的mq
 * @param type 读取类型
 */
@Override
public long readOffset(final MessageQueue mq, final ReadOffsetType type) {
   
     
    if (mq != null) {
   
     
        switch (type) {
   
     
            /*
             * 先从本地内存offsetTable读取，读不到再从broker中读取
             */
            case MEMORY_FIRST_THEN_STORE:
                /*
                 * 仅从本地内存offsetTable读取
                 */
            case READ_FROM_MEMORY: {
   
     
                AtomicLong offset = this.offsetTable.get(mq);
                if (offset != null) {
   
     
                    //如果本地内存有关于此mq的offset，那么直接返回
                    return offset.get();
                } else if (ReadOffsetType.READ_FROM_MEMORY == type) {
   
     
                    //如果本地内存没有关于此mq的offset，但那读取类型为READ_FROM_MEMORY，那么直接返回-1
                    return -1;
                }
            }
            /*
             * 仅从broker中读取
             */
            case READ_FROM_STORE: {
   
     
                try {
   
     
                    /*
                     * 从broker中获取此消费者组的offset
                     */
                    long brokerOffset = this.fetchConsumeOffsetFromBroker(mq);
                    //更新此mq的offset，并且存入本地offsetTable缓存
                    AtomicLong offset = new AtomicLong(brokerOffset);
                    this.updateOffset(mq, offset.get(), false);
                    return brokerOffset;
                }
                // No offset in broker
                catch (MQBrokerException e) {
   
     
                    //broker中没有关于此消费者组的offset，返回-1
                    return -1;
                }
                //Other exceptions
                catch (Exception e) {
   
     
                    log.warn("fetchConsumeOffsetFromBroker exception, " + mq, e);
                    return -2;
                }
            }
            default:
                break;
        }
    }

    return -1;
}
```

LocalFileOffsetStore的offset存储服务是本地文件，因此READ_FROM_STORE就是从本地文件中读取。

```java
/**
 * LocalFileOffsetStore的方法
 * <p>
 * 获取offset
 *
 * @param mq   需要获取offset的mq
 * @param type 读取类型
 */
@Override
public long readOffset(final MessageQueue mq, final ReadOffsetType type) {
   
     
    if (mq != null) {
   
     
        switch (type) {
   
     
            /*
             * 先从本地内存offsetTable读取，读不到再从broker中读取
             */
            case MEMORY_FIRST_THEN_STORE:
                /*
                 * 仅从本地内存offsetTable读取
                 */
            case READ_FROM_MEMORY: {
   
     
                AtomicLong offset = this.offsetTable.get(mq);
                if (offset != null) {
   
     
                    //如果本地内存有关于此mq的offset，那么直接返回
                    return offset.get();
                } else if (ReadOffsetType.READ_FROM_MEMORY == type) {
   
     
                    //如果本地内存没有关于此mq的offset，但那读取类型为READ_FROM_MEMORY，那么直接返回-1
                    return -1;
                }
            }
            /*
             * 仅从本地文件中读取
             */
            case READ_FROM_STORE: {
   
     
                OffsetSerializeWrapper offsetSerializeWrapper;
                try {
   
     
                    //加载本地offset文件 地址为{user.home}/.rocketmq_offsets/{clientId}/{groupName}/offsets.json
                    //配置在文件中以json形式存在
                    offsetSerializeWrapper = this.readLocalOffset();
                } catch (MQClientException e) {
   
     
                    return -1;
                }
                //获取对应mq的偏移量
                if (offsetSerializeWrapper != null && offsetSerializeWrapper.getOffsetTable() != null) {
   
     
                    AtomicLong offset = offsetSerializeWrapper.getOffsetTable().get(mq);
                    if (offset != null) {
   
     
                        //更新此mq的offset，并且存入本地offsetTable缓存
                        this.updateOffset(mq, offset.get(), false);
                        return offset.get();
                    }
                }
            }
            default:
                break;
        }
    }

    return -1;
}
```

## 3 updateOffset消费完成更新内存offset

消费者在成功之后将会调用该方法更新内存中的offsetTable的最新offset，RemoteBrokerOffsetStore和LocalFileOffsetStore方法的源码是一致的。

```java
/**
 * RemoteBrokerOffsetStore的方法
 * 更新内存中的offset
 *
 * @param mq           消息队列
 * @param offset       偏移量
 * @param increaseOnly 是否仅单调增加offset，顺序消费为false，并发消费为true
 */
@Override
public void updateOffset(MessageQueue mq, long offset, boolean increaseOnly) {
   
     
    if (mq != null) {
   
     
        //获取已存在的offset
        AtomicLong offsetOld = this.offsetTable.get(mq);
        //如果没有老的offset，那么将新的offset存进去
        if (null == offsetOld) {
   
     
            offsetOld = this.offsetTable.putIfAbsent(mq, new AtomicLong(offset));
        }
        //如果有老的offset，那么尝试更新offset
        if (null != offsetOld) {
   
     
            //如果仅单调增加offset，顺序消费为false，并发消费为true
            if (increaseOnly) {
   
     
                //如果新的offset大于已存在offset，则尝试在循环中CAS的更新为新offset
                MixAll.compareAndIncreaseOnly(offsetOld, offset);
            } else {
   
     
                //直接设置为新offset，可能导致offset变小
                offsetOld.set(offset);
            }
        }
    }
}
```

## 4 persistAllConsumerOffset定时持久化offset

消费者除了在拉取消息的时候，会上报上一次的消费点位进行持久化（集群模式），同时在Consumer启动过程中也会启动一个定时任务，每5秒钟进行一次offset的持久化（广播模式和集群模式）。

Consumer的启动过程中，在MQClientInstance的startScheduledTask方法中会去启动各种定时延迟任务，其中一个定时任务，会每5秒钟进行一次offset的持久化。

```java
/**
 * 4 每隔5S尝试持久化消费者偏移量，即消费进度
 * 广播消费模式下持久化到本地，集群消费模式下推送到broker端
 */
this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

    @Override
    public void run() {
   
     
        try {
   
     
            MQClientInstance.this.persistAllConsumerOffset();
        } catch (Exception e) {
   
     
            log.error("ScheduledTask persistAllConsumerOffset exception", e);
        }
    }
}, 1000 * 10, this.clientConfig.getPersistConsumerOffsetInterval(), TimeUnit.MILLISECONDS);
```

persistAllConsumerOffset用于持久化所有consumer的offset。集群模式持久化到broker，广播模式持久化到本地。

```java
/**
 * MQClientInstance的方法
 * <p>
 * 每隔5S尝试持久化消费者偏移量，即消费进度
 * 广播消费模式下持久化到本地，集群消费模式下推送到broker端
 */
private void persistAllConsumerOffset() {
   
     
    //遍历所有consumer集合
    Iterator<Entry<String, MQConsumerInner>> it = this.consumerTable.entrySet().iterator();
    while (it.hasNext()) {
   
     
        Entry<String, MQConsumerInner> entry = it.next();
        MQConsumerInner impl = entry.getValue();
        //依次调用DefaultMQPushConsumerImpl#persistConsumerOffset方法持久化
        impl.persistConsumerOffset();
    }
}
```

persistConsumerOffset方法获取所有的mq集合，然后调用**offsetStore#persistAll**方法，持久化所有mq的offset到本地文件或者远程broker。

```java
/**
 * DefaultMQPushConsumerImpl的方法
 * 持久化消费偏移量
 */
@Override
public void persistConsumerOffset() {
   
     
    try {
   
     
        //确定此consumer的服务状态正常，如果服务状态不是RUNNING，那么抛出异常
        this.makeSureStateOK();
        //获取所有的mq集合
        Set<MessageQueue> mqs = new HashSet<MessageQueue>();
        Set<MessageQueue> allocateMq = this.rebalanceImpl.getProcessQueueTable().keySet();
        mqs.addAll(allocateMq);
        //持久化所有mq的offset到本地文件或者远程broker
        this.offsetStore.persistAll(mqs);
    } catch (Exception e) {
   
     
        log.error("group: " + this.defaultMQPushConsumer.getConsumerGroup() + " persistConsumerOffset exception", e);
    }
}
```

## 5 persistAll持久化所有offset

该方法持久化所有mq的offset到本地文件或者远程broker。

RemoteBrokerOffsetStore方法，持久化所有mq的offset到远程broker。

```java
/**
 * RemoteBrokerOffsetStore的方法
 * <p>
 * 持久化所有mq的offset到远程broker
 *
 * @param mqs 所有的mq
 */
@Override
public void persistAll(Set<MessageQueue> mqs) {
   
     
    if (null == mqs || mqs.isEmpty())
        return;
    //未上报的mq集合
    final HashSet<MessageQueue> unusedMQ = new HashSet<MessageQueue>();
    //偏移量集合
    for (Map.Entry<MessageQueue, AtomicLong> entry : this.offsetTable.entrySet()) {
   
     
        MessageQueue mq = entry.getKey();
        AtomicLong offset = entry.getValue();
        if (offset != null) {
   
     
            //mq集合中包含该mq
            if (mqs.contains(mq)) {
   
     
                try {
   
     
                    /*
                     * 上报消费位点到Broker
                     */
                    this.updateConsumeOffsetToBroker(mq, offset.get());
                    log.info("[persistAll] Group: {} ClientId: {} updateConsumeOffsetToBroker {} {}",
                            this.groupName,
                            this.mQClientFactory.getClientId(),
                            mq,
                            offset.get());
                } catch (Exception e) {
   
     
                    log.error("updateConsumeOffsetToBroker exception, " + mq.toString(), e);
                }
            } else {
   
     
                //没有持久化的mq加入到未上报的mq集合中
                unusedMQ.add(mq);
            }
        }
    }
    //对于未上报的mq，从offsetTable中进行移除
    if (!unusedMQ.isEmpty()) {
   
     
        for (MessageQueue mq : unusedMQ) {
   
     
            this.offsetTable.remove(mq);
            log.info("remove unused mq, {}, {}", mq, this.groupName);
        }
    }
}
```

### 5.1 updateConsumeOffsetToBroker上报offset到Broker

该方法向master的broker发送一个更新offset的请求，请求Code为UPDATE_CONSUMER_OFFSET。这是一个单向请求，即发送之后马上返回，不管broker是否真正的更新成功，可能导致重复消费。

```java
/**
 * RemoteBrokerOffsetStore的方法
 * <p>
 * 更新消费偏移量
 */
private void updateConsumeOffsetToBroker(MessageQueue mq, long offset) throws RemotingException,
        MQBrokerException, InterruptedException, MQClientException {
   
     
    //调用另一个updateConsumeOffsetToBroker方法
    updateConsumeOffsetToBroker(mq, offset, true);
}

/**
 * RemoteBrokerOffsetStore的方法
 * <p>
 * 更新消费偏移量
 *
 * @param mq       消息队列
 * @param offset   偏移量
 * @param isOneway 是否是单向请求，自动提交offset请求为true
 */
@Override
public void updateConsumeOffsetToBroker(MessageQueue mq, long offset, boolean isOneway) throws RemotingException,
        MQBrokerException, InterruptedException, MQClientException {
   
     
    //获取指定brokerName的master地址。
    FindBrokerResult findBrokerResult = this.mQClientFactory.findBrokerAddressInSubscribe(mq.getBrokerName(), MixAll.MASTER_ID, true);
    if (null == findBrokerResult) {
   
     
        //从nameServer拉取并更新topic的路由信息
        this.mQClientFactory.updateTopicRouteInfoFromNameServer(mq.getTopic());
        //获取指定brokerName的master地址
        findBrokerResult = this.mQClientFactory.findBrokerAddressInSubscribe(mq.getBrokerName(), MixAll.MASTER_ID, false);
    }

    if (findBrokerResult != null) {
   
     
        //构建请求头
        UpdateConsumerOffsetRequestHeader requestHeader = new UpdateConsumerOffsetRequestHeader();
        requestHeader.setTopic(mq.getTopic());
        requestHeader.setConsumerGroup(this.groupName);
        requestHeader.setQueueId(mq.getQueueId());
        requestHeader.setCommitOffset(offset);
        //是否是单向请求，自动提交offset请求为true，发送七个球即返回，不管最终是否持久化成功
        if (isOneway) {
   
     
            //发送更新offset的单向请求
            this.mQClientFactory.getMQClientAPIImpl().updateConsumerOffsetOneway(
                    findBrokerResult.getBrokerAddr(), requestHeader, 1000 * 5);
        } else {
   
     
            this.mQClientFactory.getMQClientAPIImpl().updateConsumerOffset(
                    findBrokerResult.getBrokerAddr(), requestHeader, 1000 * 5);
        }
    } else {
   
     
        throw new MQClientException("The broker[" + mq.getBrokerName() + "] not exist", null);
    }
}
/**
 * MQClientAPIImpl的方法
 * <p>
 * 更新消费偏移量单向情求
 *
 * @param addr          broker地址
 * @param requestHeader 请求头
 * @param timeoutMillis 超时时间
 */
public void updateConsumerOffsetOneway(
        final String addr,
        final UpdateConsumerOffsetRequestHeader requestHeader,
        final long timeoutMillis
) throws RemotingConnectException, RemotingTooMuchRequestException, RemotingTimeoutException, RemotingSendRequestException,
        InterruptedException {
   
     
    //请求Code为UPDATE_CONSUMER_OFFSET
    RemotingCommand request = RemotingCommand.createRequestCommand(RequestCode.UPDATE_CONSUMER_OFFSET, requestHeader);
    //单向调用，可以走vip通道
    this.remotingClient.invokeOneway(MixAll.brokerVIPChannel(this.clientConfig.isVipChannelEnabled(), addr), request, timeoutMillis);
}
```

### 5.2 broker处理更新offset请求

broker接收到请求Code为UPDATE_CONSUMER_OFFSET的请求之后，将会进行offset更新。该请求的处理器是ConsumerManageProcessor。

```java
/**
 * ConsumerManageProcessor的方法
 */
@Override
public RemotingCommand processRequest(ChannelHandlerContext ctx, RemotingCommand request)
        throws RemotingCommandException {
   
     
    switch (request.getCode()) {
   
     
        case RequestCode.GET_CONSUMER_LIST_BY_GROUP:
            //返回指定group的所有客户端id集合
            return this.getConsumerListByGroup(ctx, request);
        case RequestCode.UPDATE_CONSUMER_OFFSET:
            //更新消费偏移量
            return this.updateConsumerOffset(ctx, request);
        case RequestCode.QUERY_CONSUMER_OFFSET:
            //查询消费偏移量
            return this.queryConsumerOffset(ctx, request);
        default:
            break;
    }
    return null;
}
```

这里提交偏移量实际上就是将新的偏移量存入ConsumerOffsetManager内部的offsetTable中。该缓存对应着磁盘上的{user.home}/store/config/consumerOffset.json文件。这里实际上是存入到内存中的，并没有持久化。

```java
/**
 * ConsumerOffsetManager的方法
 * 提交偏移量
 *
 * @param clientHost 客户端地址
 * @param group      消费者组
 * @param topic      消费topic
 * @param queueId    队列id
 * @param offset     提交的偏移量
 */
public void commitOffset(final String clientHost, final String group, final String topic, final int queueId,
                         final long offset) {
   
     
    // topic@group
    String key = topic + TOPIC_GROUP_SEPARATOR + group;
    this.commitOffset(clientHost, key, queueId, offset);
}

/**
 * ConsumerOffsetManager的方法
 * 提交偏移量
 *
 * @param clientHost 客户端地址
 * @param key        缓存key
 * @param queueId    队列id
 * @param offset     提交的偏移量
 */
private void commitOffset(final String clientHost, final String key, final int queueId, final long offset) {
   
     
    //获取topic@group对应的所有queue的消费偏移量map
    ConcurrentMap<Integer, Long> map = this.offsetTable.get(key);
    if (null == map) {
   
     
        map = new ConcurrentHashMap<Integer, Long>(32);
        //存入map，key为queueId value为offSet
        map.put(queueId, offset);
        this.offsetTable.put(key, map);
    } else {
   
     
        //存入map，key为queueId value为offSet
        Long storeOffset = map.put(queueId, offset);
        if (storeOffset != null && offset < storeOffset) {
   
     
            log.warn("[NOTIFYME]update consumer offset less than store. clientHost={}, key={}, queueId={}, requestOffset={}, storeOffset={}", clientHost, key, queueId, offset, storeOffset);
        }
    }
}
```

broker启动过程中，在BrokerController#initialize方法中会启动一些定时调度任务，其中有一个任务每隔5s将消费者offset进行持久化（offsetTable中的数据），存入consumerOffset.json文件中。
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162138159.png)
broker在shutdown的时候也会调用consumerOffsetManager#persist()持久化offset到consumerOffset.json文件中。