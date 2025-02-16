---

layout: 16、RocketMQ源码分析：消费者负载均衡服务RebalanceService入口源码

title:  16、RocketMQ源码分析：消费者负载均衡服务RebalanceService入口源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713341

abbrlink: 1739713341

date: 2025-02-16 21:42:06


--- 

# 16、RocketMQ源码分析：消费者负载均衡服务RebalanceService入口源码

上一篇文章我们学习了[RocketMQ源码(15)—消费者DefaultMQPushConsumer启动主要流程源码](https://blog.csdn.net/weixin_43767015/article/details/127746676)。

*
*RocketMQ一个消费者组中可以有多个消费者，在集群模式下他们共同消费topic下的所有消息，RocketMQ规定一个消息队列仅能被一个消费者消费，但一个消费者可以同时消费多个消息队列。这就涉及到如何将多个消息队列分配给等多个消费者的问题。
**

**RocketMQ中使用负载均衡服务RebalanceService来专门处理多个消息队列和消费者的对应关系，并且提供了多个不同的消费者负载均衡策略，即如何分配消息队列给这些消费者。
**

**另外，当消费者正常退出，异常关闭通道，或者新加入的时候，同样需要负载均衡服务RebalanceService来进行消息队列分配的重平衡。**

**更重要的是，一个消费者启动之后，其消费消息的触发并不是pullMessageService消息拉取服务，而真正的源头正是负载均衡服务RebalanceService。因此我们有必要先学习RebalanceService的原理和源码。
**

#### 文章目录

- 1 负载均衡or重平衡的触发
-
    - 1.1 RebalanceService自动重平衡
- 1.2 Consumer启动重平衡
- 1.3 Broker请求重平衡
-
    - 1.3.1 Broker处理心跳请求
    -
        - 1.3.1.1 registerConsumer注册消费者
        -
            - 1.3.1.1.1 updateChannel更新连接
            - 1.3.1.1.2 updateSubscription更新订阅信息
            - 1.3.1.1.3 consumerIdsChangeListener.handle监听器通知
        - 1.3.1.2 notifyConsumerIdsChanged通知消费者变更
    - 1.3.2 客户端处理重平衡请求
    -
        - 1.3.2.1 notifyConsumerIdsChanged客户端重平衡
- 2 小结

## 1 负载均衡or重平衡的触发

**有三种情况会触发Consumer进行负载均衡或者说重平衡：**

**1、** RebalanceService服务是一个线程任务，由MQClientInstance启动，其**每隔20s自动进行一次自动负载均衡**；
**2、** **Broker触发的重平衡**：；

**1、** Broker收到心跳请求之后如果发现消息中**有新的consumer连接或者consumer订阅了新的topic或者移除了topic的订阅**
，则Broker发送Code为NOTIFY_CONSUMER_IDS_CHANGED的请求给该group下面的所有Consumer，要求进行一次负载均衡；
**2、** 如果**某个客户端连接出现连接异常事件EXCEPTION、连接断开事件CLOSE、或者连接闲置事件IDLE**
，则Broker同样会发送重平衡请求给消费者组下面的所有消费者；
**3、** **新的Consumer服务启动**的时候，主动调用rebalanceImmediately唤醒负载均衡服务rebalanceService，进行重平衡；

### 1.1 RebalanceService自动重平衡

**RebalanceService#run方法，也就是负载均衡服务运行的任务，最多每隔20s执行一次重平衡。主要逻辑是在mqClientFactory#doRebalance方法中实现的。
**

```java
/**
 * RebalanceServicede 方法
 */
@Override
public void run() {
   
     
    log.info(this.getServiceName() + " service started");
    /*
     * 运行时逻辑
     * 如果服务没有停止，则在死循环中执行负载均衡
     */
    while (!this.isStopped()) {
   
     
        //等待运行，默认最多等待20s，可以被唤醒
        this.waitForRunning(waitInterval);
        //执行重平衡操作
        this.mqClientFactory.doRebalance();
    }

    log.info(this.getServiceName() + " service end");
}
```

### 1.2 Consumer启动重平衡

**新的Consumer服务启动的时候，主动调用rebalanceImmediately唤醒负载均衡服务rebalanceService，进行重平衡。**

```java
/**
 * MQClientInstance的方法
 * 立即重平衡
 */
public void rebalanceImmediately() {
   
     
    //唤醒重平衡服务，立即重平衡
    this.rebalanceService.wakeup();
}
```

### 1.3 Broker请求重平衡

broker触发的重平衡有两种情况：

**1、**
Broker收到心跳请求之后如果发现消息中有新的consumer连接，或者consumer订阅了新的topic，或者移除了topic的订阅，则Broker发送Code为NOTIFY_CONSUMER_IDS_CHANGED的请求给该group下面的所有Consumer，要求进行一次负载均衡；

2. 如果某个客户端连接出现连接异常事件EXCEPTION、连接断开事件CLOSE、或者连接闲置事件IDLE，则Broker同样会发送重平衡请求给消费者组下面的所有消费者。处理入口方法为ClientHousekeepingService#
   doChannelCloseEvent方法。

*
*新的Consumer和Producer启动的时候，就会发送心跳信息给Broker，MQClientInstance内部的服务也会定时30s发送心跳信息给Broker。关于发送心跳请求sendHeartbeatToAllBrokerWithLock方法的源码，我们在Producer启动的部分就讲过了，我们现在来看看Broker处理心跳请求的源码。
**

**心跳请求的Code为HEART_BEAT，该请求最终被Broker的ClientManageProcessor处理器处理。**

```java
/**
 * ClientManageProcessor的方法
 */
@Override
public RemotingCommand processRequest(ChannelHandlerContext ctx, RemotingCommand request)
        throws RemotingCommandException {
   
     
    switch (request.getCode()) {
   
     
        //客户端心跳请求
        case RequestCode.HEART_BEAT:
            //客户端心跳请求
            return this.heartBeat(ctx, request);
        case RequestCode.UNREGISTER_CLIENT:
            return this.unregisterClient(ctx, request);
        case RequestCode.CHECK_CLIENT_CONFIG:
            return this.checkClientConfig(ctx, request);
        default:
            break;
    }
    return null;
}
```

#### 1.3.1 Broker处理心跳请求

Broker的ClientManageProcessor#heartBeat该方法用于Broker处理来自客户端（包括consumer和producer）的心跳请求。主要流程就是：

**1、** 解码消息中的信息成为HeartbeatData对象，该对象的结构我们在在Producer启动的部分就讲过了；
**2、**
循环遍历处理consumerDataSet集合，对ConsumerData信息进行注册或者更改，如果consumer信息发生了改变，Broker会发送NOTIFY_CONSUMER_IDS_CHANGED请求给同组的所有consumer客户端，要求进行重平衡操作；
**3、** 循环遍历处理consumerDataSet集合，对ProducerData信息进行注册或者更改；

```java
/**
 * ClientManageProcessor的方法
 * <p>
 * 处理客户端心跳请求
 */
public RemotingCommand heartBeat(ChannelHandlerContext ctx, RemotingCommand request) {
   
     
    //构建响应命令对象
    RemotingCommand response = RemotingCommand.createResponseCommand(null);
    //解码
    HeartbeatData heartbeatData = HeartbeatData.decode(request.getBody(), HeartbeatData.class);
    //构建客户端连接信息对象
    ClientChannelInfo clientChannelInfo = new ClientChannelInfo(
            ctx.channel(),
            heartbeatData.getClientID(),
            request.getLanguage(),
            request.getVersion()
    );
    /*
     * 1 循环遍历处理consumerDataSet，即处理consumer的心跳信息
     */
    for (ConsumerData data : heartbeatData.getConsumerDataSet()) {
   
     
        //查找broker缓存的当前消费者组的订阅组配置
        SubscriptionGroupConfig subscriptionGroupConfig =
                this.brokerController.getSubscriptionGroupManager().findSubscriptionGroupConfig(
                        data.getGroupName());
        boolean isNotifyConsumerIdsChangedEnable = true;
        //如果已存在订阅组
        if (null != subscriptionGroupConfig) {
   
     
            //当consumer发生改变的时候是否支持通知同组的所有consumer，默认true，即支持
            isNotifyConsumerIdsChangedEnable = subscriptionGroupConfig.isNotifyConsumerIdsChangedEnable();
            int topicSysFlag = 0;
            if (data.isUnitMode()) {
   
     
                topicSysFlag = TopicSysFlag.buildSysFlag(false, true);
            }
            //尝试创建重试topic
            String newTopic = MixAll.getRetryTopic(data.getGroupName());
            this.brokerController.getTopicConfigManager().createTopicInSendMessageBackMethod(
                    newTopic,
                    subscriptionGroupConfig.getRetryQueueNums(),
                    PermName.PERM_WRITE | PermName.PERM_READ, topicSysFlag);
        }
        /*
         * 注册consumer，返回consumer信息是否已发生改变
         * 如果发生了改变，Broker会发送NOTIFY_CONSUMER_IDS_CHANGED请求给同组的所有consumer客户端，要求进行重平衡操作
         */
        boolean changed = this.brokerController.getConsumerManager().registerConsumer(
                data.getGroupName(),
                clientChannelInfo,
                data.getConsumeType(),
                data.getMessageModel(),
                data.getConsumeFromWhere(),
                data.getSubscriptionDataSet(),
                isNotifyConsumerIdsChangedEnable
        );

        if (changed) {
   
     
            //如果consumer信息发生了改变，打印日志
            log.info("registerConsumer info changed {} {}",
                    data.toString(),
                    RemotingHelper.parseChannelRemoteAddr(ctx.channel())
            );
        }
    }
    /*
     * 2 循环遍历处理producerDataSet，即处理producer的心跳信息
     */
    for (ProducerData data : heartbeatData.getProducerDataSet()) {
   
     
        /*
         * 注册producer
         */
        this.brokerController.getProducerManager().registerProducer(data.getGroupName(),
                clientChannelInfo);
    }
    //返回响应
    response.setCode(ResponseCode.SUCCESS);
    response.setRemark(null);
    return response;
}
```

##### 1.3.1.1 registerConsumer注册消费者

注册consumer，返回consumer信息是否已发生改变，如果发生了改变，Broker会发送NOTIFY_CONSUMER_IDS_CHANGED请求给同组的所有consumer客户端，要求进行重平衡操作。

```java
/**
 * ConsumerManager的方法
 * <p>
 * 注册consumer，返回consumer信息是否已发生改变
 * 如果发生了改变，Broker会发送NOTIFY_CONSUMER_IDS_CHANGED请求给同组的所有consumer客户端，要求进行重平衡操作
 *
 * @param group                            消费者组
 * @param clientChannelInfo                客户端连接信息
 * @param consumeType                      消费类型，PULL or PUSH
 * @param messageModel                     消息模式，集群 or 广播
 * @param consumeFromWhere                 启动消费位置
 * @param subList                          订阅信息数据
 * @param isNotifyConsumerIdsChangedEnable 一个consumer改变时是否通知该consumergroup中的所有consumer进行重平衡
 * @return 是否重平衡
 */
public boolean registerConsumer(final String group, final ClientChannelInfo clientChannelInfo,
                                ConsumeType consumeType, MessageModel messageModel, ConsumeFromWhere consumeFromWhere,
                                final Set<SubscriptionData> subList, boolean isNotifyConsumerIdsChangedEnable) {
   
     
    //获取当前group对应的ConsumerGroupInfo
    ConsumerGroupInfo consumerGroupInfo = this.consumerTable.get(group);
    //如果为null，那么新建一个ConsumerGroupInfo并存入consumerTable
    if (null == consumerGroupInfo) {
   
     
        ConsumerGroupInfo tmp = new ConsumerGroupInfo(group, consumeType, messageModel, consumeFromWhere);
        ConsumerGroupInfo prev = this.consumerTable.putIfAbsent(group, tmp);
        consumerGroupInfo = prev != null ? prev : tmp;
    }
    /*
     * 1 更新连接
     */
    boolean r1 =
            consumerGroupInfo.updateChannel(clientChannelInfo, consumeType, messageModel,
                    consumeFromWhere);
    /*
     * 2 更新订阅信息
     */
    boolean r2 = consumerGroupInfo.updateSubscription(subList);
    /*
     * 2 如果连接或者订阅信息有更新，并且允许通知，那么通知该consumergroup中的所有consumer进行重平衡
     */
    if (r1 || r2) {
   
     
        if (isNotifyConsumerIdsChangedEnable) {
   
     
            //CHANGE事件
            this.consumerIdsChangeListener.handle(ConsumerGroupEvent.CHANGE, group, consumerGroupInfo.getAllChannel());
        }
    }
    //注册订阅信息到ConsumerFilterManager
    this.consumerIdsChangeListener.handle(ConsumerGroupEvent.REGISTER, group, subList);

    return r1 || r2;
}
```

###### 1.3.1.1.1 updateChannel更新连接

更新此ConsumerGroup组对应的ConsumerGroupInfo的一些属性，并且还会判断当前连接是否是新连接，如果Broker此前没有该连接的信息，那么表示有新的consumer连接到此broker，那么需要通知当前ConsumerGroup的所有consumer进行重平衡。

```java
/**
 * ConsumerGroupInfo的方法
 * <p>
 * 更新连接
 *
 * @param infoNew          新连接信息
 * @param consumeType      消费类型，PULL or PUSH
 * @param messageModel     消息模式，集群 or 广播
 * @param consumeFromWhere 启动消费位置
 * @return 是否通知
 */
public boolean updateChannel(final ClientChannelInfo infoNew, ConsumeType consumeType,
                             MessageModel messageModel, ConsumeFromWhere consumeFromWhere) {
   
     
    boolean updated = false;
    //更新信息
    this.consumeType = consumeType;
    this.messageModel = messageModel;
    this.consumeFromWhere = consumeFromWhere;
    //根据当前连接获取channelInfoTable缓存中的连接信息
    ClientChannelInfo infoOld = this.channelInfoTable.get(infoNew.getChannel());
    //如果缓存中的连接信息为null，说明当前连接是一个新连接
    if (null == infoOld) {
   
     
        //存入缓存
        ClientChannelInfo prev = this.channelInfoTable.put(infoNew.getChannel(), infoNew);
        //长期按没有该连接信息，那么表示有新的consumer连接到此broekr，那么需要通知
        if (null == prev) {
   
     
            log.info("new consumer connected, group: {} {} {} channel: {}", this.groupName, consumeType,
                    messageModel, infoNew.toString());
            updated = true;
        }

        infoOld = infoNew;
    } else {
   
     
        //异常情况
        if (!infoOld.getClientId().equals(infoNew.getClientId())) {
   
     
            log.error("[BUG] consumer channel exist in broker, but clientId not equal. GROUP: {} OLD: {} NEW: {} ",
                    this.groupName,
                    infoOld.toString(),
                    infoNew.toString());
            this.channelInfoTable.put(infoNew.getChannel(), infoNew);
        }
    }
    //更新更新时间
    this.lastUpdateTimestamp = System.currentTimeMillis();
    infoOld.setLastUpdateTimestamp(this.lastUpdateTimestamp);

    return updated;
}
```

###### 1.3.1.1.2 updateSubscription更新订阅信息

更新此ConsumerGroup组对应的订阅信息集合，如果存在新增订阅的topic，或者移除了对于某个topic的订阅，那么需要通知当前ConsumerGroup的所有consumer进行重平衡。

该方法的大概步骤为：

**1、** 该方法首先遍历当前请求传递的订阅信息集合，然后对于每个订阅的topic从subscriptionTable缓存中尝试获取，如果获取不到则表示新增了topic订阅信息，那么将新增的信息存入subscriptionTable；
**2、**
然后遍历subscriptionTable集合，判断每一个topic是否存在于当前请求传递的订阅信息集合中，如果不存在，表示consumer移除了对于该topic的订阅，那么当前topic的订阅信息会从subscriptionTable集合中被移除；

**这里的源码实际上很重要，他向我们传达出了什么信息呢？那就是RocketMQ需要保证组内的所有消费者订阅的topic都必须一致，否则就会出现订阅的topic被覆盖的情况。
**

**根据刚才的源码分析，假设一个消费者组groupX里面有两个消费者，A消费者先启动并且订阅topicA，A消费者向broker发送心跳，那么subscriptionTable中消费者组groupX里面仅有topicA的订阅信息。
**

**随后B消费者启动并且订阅topicB，B消费者也向broker发送心跳，那么根据该方法的源码，subscriptionTable中消费者组groupX里面的topicA的订阅信息将会被移除，而topicB的订阅信息会被存入进来。
**

**这样就导致了topic订阅信息的相互覆盖，导致其中一个消费者能够消费消息，而另一个消费者不会消费。**

```java
/**
 * ConsumerGroupInfo的方法
 * 更新订阅信息
 *
 * @param subList 订阅信息集合
 */
public boolean updateSubscription(final Set<SubscriptionData> subList) {
   
     
    boolean updated = false;
    //遍历订阅信息集合
    for (SubscriptionData sub : subList) {
   
     
        //根据订阅的topic在ConsumerGroup的subscriptionTable缓存中此前的订阅信息
        SubscriptionData old = this.subscriptionTable.get(sub.getTopic());
        //如果此前没有关于该topic的订阅信息，那么表示此topic为新增订阅
        if (old == null) {
   
     
            //存入subscriptionTable
            SubscriptionData prev = this.subscriptionTable.putIfAbsent(sub.getTopic(), sub);
            //此前没有关于该topic的订阅信息，那么表示此topic为新增订阅，那么需要通知
            if (null == prev) {
   
     
                updated = true;
                log.info("subscription changed, add new topic, group: {} {}",
                        this.groupName,
                        sub.toString());
            }
        } else if (sub.getSubVersion() > old.getSubVersion()) {
   
     
            //更新数据
            if (this.consumeType == ConsumeType.CONSUME_PASSIVELY) {
   
     
                log.info("subscription changed, group: {} OLD: {} NEW: {}",
                        this.groupName,
                        old.toString(),
                        sub.toString()
                );
            }

            this.subscriptionTable.put(sub.getTopic(), sub);
        }
    }
    /*
     * 遍历ConsumerGroup的subscriptionTable缓存
     */
    Iterator<Entry<String, SubscriptionData>> it = this.subscriptionTable.entrySet().iterator();
    while (it.hasNext()) {
   
     
        Entry<String, SubscriptionData> next = it.next();
        //获取此前订阅的topic
        String oldTopic = next.getKey();

        boolean exist = false;
        //判断当前的subList是否存在该topic的订阅信息
        for (SubscriptionData sub : subList) {
   
     
            //如果存在，则退出循环
            if (sub.getTopic().equals(oldTopic)) {
   
     
                exist = true;
                break;
            }
        }
        //当前的subList不存在该topic的订阅信息，说明consumer移除了对于该topic的订阅
        if (!exist) {
   
     
            log.warn("subscription changed, group: {} remove topic {} {}",
                    this.groupName,
                    oldTopic,
                    next.getValue().toString()
            );
            //移除数据
            it.remove();
            //那么需要通知
            updated = true;
        }
    }

    this.lastUpdateTimestamp = System.currentTimeMillis();

    return updated;
}
```

###### 1.3.1.1.3 consumerIdsChangeListener.handle监听器通知

该方法通知监听器处理对应的事件，需要进行通知的事件为ConsumerGroupEvent.CHANGE。

可以看到该方法中对于ConsumerGroupEvent.CHANGE事件的处理为：如果允许通知，则遍历该ConsumerGroup的连接集合，然后对每个连接调用notifyConsumerIdsChanged方法通知对应的客户端消费者执行负载均衡。

```java
/**
 * DefaultConsumerIdsChangeListener的方法
 * 
 * 处理监听到的事件
 * @param event 事件
 * @param group 消费者组
 * @param args 参数
 */
@Override
public void handle(ConsumerGroupEvent event, String group, Object... args) {
   
     
    if (event == null) {
   
     
        return;
    }
    switch (event) {
   
     
        //改变事件，需要通知该消费者组的每一个消费者
        case CHANGE:
            if (args == null || args.length < 1) {
   
     
                return;
            }
            //获取参数
            List<Channel> channels = (List<Channel>) args[0];
            //如果允许通知
            if (channels != null && brokerController.getBrokerConfig().isNotifyConsumerIdsChangedEnable()) {
   
     
                //遍历连接集合
                for (Channel chl : channels) {
   
     
                    //通知该消费者客户端执行负载均衡
                    this.brokerController.getBroker2Client().notifyConsumerIdsChanged(chl, group);
                }
            }
            break;
        case UNREGISTER:
            this.brokerController.getConsumerFilterManager().unRegister(group);
            break;
        case REGISTER:
            if (args == null || args.length < 1) {
   
     
                return;
            }
            Collection<SubscriptionData> subscriptionDataList = (Collection<SubscriptionData>) args[0];
            this.brokerController.getConsumerFilterManager().register(group, subscriptionDataList);
            break;
        default:
            throw new RuntimeException("Unknown event " + event);
    }
}
```

##### 1.3.1.2 notifyConsumerIdsChanged通知消费者变更

**该方法由broker向客户端发送一个单向请求，Code为NOTIFY_CONSUMER_IDS_CHANGED，这就是Broker通知客户端的重平衡请求，当客户端收到该请求之后，将会进行重平衡操作。
**

```java
/**
 * Broker2Client的方法
 * <p>
 * 通知消费者变更
 *
 * @param channel       连接
 * @param consumerGroup 消费者组
 */
public void notifyConsumerIdsChanged(
        final Channel channel,
        final String consumerGroup) {
   
     
    if (null == consumerGroup) {
   
     
        log.error("notifyConsumerIdsChanged consumerGroup is null");
        return;
    }
    //构建请求头
    NotifyConsumerIdsChangedRequestHeader requestHeader = new NotifyConsumerIdsChangedRequestHeader();
    requestHeader.setConsumerGroup(consumerGroup);
    //构建远程命令对象，请求code为NOTIFY_CONSUMER_IDS_CHANGED
    RemotingCommand request =
            RemotingCommand.createRequestCommand(RequestCode.NOTIFY_CONSUMER_IDS_CHANGED, requestHeader);

    try {
   
     
        //发送单向请求，无需等待客户端回应
        this.brokerController.getRemotingServer().invokeOneway(channel, request, 10);
    } catch (Exception e) {
   
     
        log.error("notifyConsumerIdsChanged exception. group={}, error={}", consumerGroup, e.toString());
    }
}
```

#### 1.3.2 客户端处理重平衡请求

来自broker的请求在客户端是通过ClientRemotingProcessor#processRequest处理的。

NOTIFY_CONSUMER_IDS_CHANGED请求通过客户端的ClientRemotingProcessor#notifyConsumerIdsChanged方法处理。

```java
/**
 * ClientRemotingProcessor的方法
 * <p>
 * 处理来自远程服务端的请求
 */
@Override
public RemotingCommand processRequest(ChannelHandlerContext ctx,
                                      RemotingCommand request) throws RemotingCommandException {
   
     
    switch (request.getCode()) {
   
     
        case RequestCode.CHECK_TRANSACTION_STATE:
            return this.checkTransactionState(ctx, request);
        case RequestCode.NOTIFY_CONSUMER_IDS_CHANGED:
            //处理NOTIFY_CONSUMER_IDS_CHANGED请求
            return this.notifyConsumerIdsChanged(ctx, request);
        case RequestCode.RESET_CONSUMER_CLIENT_OFFSET:
            return this.resetOffset(ctx, request);
        case RequestCode.GET_CONSUMER_STATUS_FROM_CLIENT:
            return this.getConsumeStatus(ctx, request);

        case RequestCode.GET_CONSUMER_RUNNING_INFO:
            return this.getConsumerRunningInfo(ctx, request);

        case RequestCode.CONSUME_MESSAGE_DIRECTLY:
            return this.consumeMessageDirectly(ctx, request);

        case RequestCode.PUSH_REPLY_MESSAGE_TO_CLIENT:
            return this.receiveReplyMessage(ctx, request);
        default:
            break;
    }
    return null;
}
```

##### 1.3.2.1 notifyConsumerIdsChanged客户端重平衡

客户端接口到broker的重平衡请求之后，调用该方法才理。逻辑很简单，内部仅仅是调用我们之前讲的rebalanceImmediately
方法唤醒负载均衡服务rebalanceService，进行重平衡。

```java
public RemotingCommand notifyConsumerIdsChanged(ChannelHandlerContext ctx,
                                                RemotingCommand request) throws RemotingCommandException {
   
     
    try {
   
     
        //解析请求头
        final NotifyConsumerIdsChangedRequestHeader requestHeader =
                (NotifyConsumerIdsChangedRequestHeader) request.decodeCommandCustomHeader(NotifyConsumerIdsChangedRequestHeader.class);
        //打印日志
        log.info("receive broker's notification[{}], the consumer group: {} changed, rebalance immediately",
                RemotingHelper.parseChannelRemoteAddr(ctx.channel()),
                requestHeader.getConsumerGroup());
        //熟悉的方法，立即进行重平衡
        this.mqClientFactory.rebalanceImmediately();
    } catch (Exception e) {
   
     
        log.error("notifyConsumerIdsChanged exception", RemotingHelper.exceptionSimpleDesc(e));
    }
    return null;
}
```

## 2 小结

**本文介绍了RocketMQ消费者负载均衡服务RebalanceService入口源码，下一篇文章我们将会介绍具体的负载的过程源码。**