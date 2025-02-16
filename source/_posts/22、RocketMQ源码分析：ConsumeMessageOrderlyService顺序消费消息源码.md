---

layout: 22、RocketMQ源码分析：ConsumeMessageOrderlyService顺序消费消息源码

title:  22、RocketMQ源码分析：ConsumeMessageOrderlyService顺序消费消息源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713347

abbrlink: 1739713347

date: 2025-02-16 21:42:06


--- 

# 22、RocketMQ源码分析：ConsumeMessageOrderlyService顺序消费消息源码

分类：[RocketMQ源码分析（1）](https://cxykk.com/?cat=318)  2024-03-27 阅读(124)

> 基于RocketMQ release-4.9.3，深入的介绍了ConsumeMessageOrderlyService顺序消费消息源码。

此前我们学习了consumer消息的拉取流程源码：

**1、
** [RocketMQ源码(18)—DefaultMQPushConsumer消费者发起拉取消息请求源码](https://blog.csdn.net/weixin_43767015/article/details/128563451)；
**2、
** [RocketMQ源码(19)—Broker处理DefaultMQPushConsumer发起的拉取消息请求源码【一万字】](https://blog.csdn.net/weixin_43767015/article/details/128694893)；
**3、
** [RocketMQ源码(20)—DefaultMQPushConsumer处理Broker的拉取消息响应源码](https://blog.csdn.net/weixin_43767015/article/details/128783131)；

当前DefaultMQPushConsumer拉取到消息之后，会将消息提交到对应的processQueue处理队列内部的msgTreeMap中。然后通过consumeMessageService#submitConsumeRequest方法将拉取到的消息构建为ConsumeRequest，然后通过内部的consumeExecutor线程池消费消息。

consumeMessageService有ConsumeMessageConcurrentlyService并发消费和ConsumeMessageOrderlyService顺序消费两种实现，下面我们来看看这两种实现如何消费消息，
此前我们已经学习了并发消费的源码：https://blog.csdn.net/weixin_43767015/article/details/129017181，本次我们先学习顺序消费的源码。

#### 文章目录

- 1 start启动服务定时锁定消息队列
-
    - 1.2 lockAll锁定所有消息队列
-
    - 1.1.1 lockBatchMQ批量锁定消息队列
    - 1.1.2 broker处理批量锁定请求lockBatchMQ
    -
        -
            - 1.1.1.1.1. 分布式mq锁小结
- 2 submitConsumeRequest提交消费请求
- 3 ConsumeRequest执行消费任务
-
    - 3.1 tryLockLaterAndReconsume尝试延迟加锁并重新消费
-
    - 3.1.1 submitConsumeRequestLater延迟提交消费请求
- 3.2 takeMessages拉取消息
- 4 processConsumeResult处理消费结果
-
    - 4.1 commit提交消息
- 4.2 checkReconsumeTimes检查重试次数
- 4.3 makeMessageToConsumeAgain标记消息重新消费
- 4.4 updateOffset更新offset
-
    - 4.4.1 compareAndIncreaseOnly仅增加offset
- 5 顺序消费和并发消费的总结

## 1 start启动服务定时锁定消息队列

consumeMessageService服务在DefaultMQPushConsumerImpl#start方法中被初始化并启动，即调用start方法。*
*该方法将会通过scheduledExecutorService定时任务锁定所有分配的mq，保证同时只有一个消费端可以消费。**

这个定时任务在启动1s后开始执行，后每20s执行一次，这里的20s可通过**-D rocketmq.client.rebalance.lockInterval**
属性设置。因此它的频率与负载均衡的默认频率一致，都是20s。

```java
/**
 * ConsumeMessageOrderlyService的方法
 * 启动服务
 */
public void start() {
   
     
    //如果是集群模式
    if (MessageModel.CLUSTERING.equals(ConsumeMessageOrderlyService.this.defaultMQPushConsumerImpl.messageModel())) {
   
     
        //启动一个定时任务，启动后1s执行，后续每20s执行一次
        //尝试对所有分配给当前consumer的队列请求broker端的消息队列锁，保证同时只有一个消费端可以消费。
        this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     
            @Override
            public void run() {
   
     
                try {
   
     
                    //定期锁定所有消息队列
                    ConsumeMessageOrderlyService.this.lockMQPeriodically();
                } catch (Throwable e) {
   
     
                    log.error("scheduleAtFixedRate lockMQPeriodically exception", e);
                }
            }
        }, 1000 * 1, ProcessQueue.REBALANCE_LOCK_INTERVAL, TimeUnit.MILLISECONDS);
    }
}
```

内部调用RebalanceImpl#lockAll方法锁定该客户端分配的所有消费队列。

```java
/**
 * ConsumeMessageOrderlyService的方法
 * <p>
 * 锁定所有消息队列
 */
public synchronized void lockMQPeriodically() {
   
     
    if (!this.stopped) {
   
     
        //锁定所有消息队列
        this.defaultMQPushConsumerImpl.getRebalanceImpl().lockAll();
    }
}
```

### 1.2 lockAll锁定所有消息队列

该方法尝试锁定所有消息队列。

**1、**
根据processQueueTable的数据，构建brokerName到其所有mq的map集合brokerMqs在负载均衡并为当前消费者新分配消息队列的时候，也会对新分配的消息队列申请broker加锁，加锁成功后才会创建对应的processQueue存入processQueueTable也就是说，如果是顺序消息，那么processQueueTable中的数据一定是曾经加锁成功了的；

2. 遍历brokerMqs，调用**MQClientAPIImpl#lockBatchMQ**的方法，向broker发送同步请求，Code为LOCK_BATCH_MQ，请求批量锁定消息队列，返回锁住的mq集合。

**3、** 遍历锁住的mq集合，获取对应的processQueue，设置processQueue的状态，设置locked为true，重新设置加锁的时间遍历没有锁住的mq，设置locked为false；

```java
/**
 * RebalanceImpl的方法
 * <p>
 * 定时每20s尝试锁定所有消息队列
 */
public void lockAll() {
   
     
    /*
     * 1 根据processQueueTable的数据，构建brokerName到所有mq的map集合
     * 在新分配消息队列的时候，也会对新分配的消息队列申请broker加锁，加锁成功后会创建对应的processQueue存入processQueueTable
     * 也就是说，如果是顺序消息，那么processQueueTable的数据一定是曾经加锁成功了的
     */
    HashMap<String, Set<MessageQueue>> brokerMqs = this.buildProcessQueueTableByBrokerName();

    Iterator<Entry<String, Set<MessageQueue>>> it = brokerMqs.entrySet().iterator();
    //遍历集合
    while (it.hasNext()) {
   
     
        Entry<String, Set<MessageQueue>> entry = it.next();
        final String brokerName = entry.getKey();
        final Set<MessageQueue> mqs = entry.getValue();

        if (mqs.isEmpty())
            continue;
        //获取指定brokerName的master地址。
        FindBrokerResult findBrokerResult = this.mQClientFactory.findBrokerAddressInSubscribe(brokerName, MixAll.MASTER_ID, true);
        if (findBrokerResult != null) {
   
     
            LockBatchRequestBody requestBody = new LockBatchRequestBody();
            requestBody.setConsumerGroup(this.consumerGroup);
            requestBody.setClientId(this.mQClientFactory.getClientId());
            requestBody.setMqSet(mqs);

            try {
   
     
                /*
                 * 2 向broker发送同步请求，Code为LOCK_BATCH_MQ，请求批量锁定消息队列，返回锁住的mq集合
                 */
                Set<MessageQueue> lockOKMQSet =
                        this.mQClientFactory.getMQClientAPIImpl().lockBatchMQ(findBrokerResult.getBrokerAddr(), requestBody, 1000);
                //遍历锁住的mq集合
                for (MessageQueue mq : lockOKMQSet) {
   
     
                    //获取对应的processQueue，设置processQueue的状态
                    ProcessQueue processQueue = this.processQueueTable.get(mq);
                    if (processQueue != null) {
   
     
                        if (!processQueue.isLocked()) {
   
     
                            log.info("the message queue locked OK, Group: {} {}", this.consumerGroup, mq);
                        }
                        //设置locked为true
                        processQueue.setLocked(true);
                        //设置加锁的时间
                        processQueue.setLastLockTimestamp(System.currentTimeMillis());
                    }
                }
                //遍历没有锁住的mq，设置locked为false
                for (MessageQueue mq : mqs) {
   
     
                    if (!lockOKMQSet.contains(mq)) {
   
     
                        ProcessQueue processQueue = this.processQueueTable.get(mq);
                        if (processQueue != null) {
   
     
                            processQueue.setLocked(false);
                            log.warn("the message queue locked Failed, Group: {} {}", this.consumerGroup, mq);
                        }
                    }
                }
            } catch (Exception e) {
   
     
                log.error("lockBatchMQ exception, " + mqs, e);
            }
        }
    }
}
```

#### 1.1.1 lockBatchMQ批量锁定消息队列

该方法向broker发送同步请求，Code为LOCK_BATCH_MQ，请求批量锁定消息队列，返回锁住的mq集合。

```java
/**
 * MQClientAPIImpl的方法
 *
 * 向broker发送同步请求，Code为LOCK_BATCH_MQ，请求批量锁定消息队列，返回锁住的mq集合
 * @param addr broker地址
 * @param requestBody 请求体
 * @param timeoutMillis 超时时间
 * @return
 * @throws RemotingException
 * @throws MQBrokerException
 * @throws InterruptedException
 */
public Set<MessageQueue> lockBatchMQ(
        final String addr,
        final LockBatchRequestBody requestBody,
        final long timeoutMillis) throws RemotingException, MQBrokerException, InterruptedException {
   
     
    //Code为LOCK_BATCH_MQ
    RemotingCommand request = RemotingCommand.createRequestCommand(RequestCode.LOCK_BATCH_MQ, null);

    request.setBody(requestBody.encode());
    //同步请求，调用brokerVIPChannel判断是否开启vip通道，如果开启了，那么将brokerAddr的port – 2，因为vip通道的端口为普通端口 – 2。
    RemotingCommand response = this.remotingClient.invokeSync(MixAll.brokerVIPChannel(this.clientConfig.isVipChannelEnabled(), addr),
            request, timeoutMillis);
    switch (response.getCode()) {
   
     
        case ResponseCode.SUCCESS: {
   
     
            //解码
            LockBatchResponseBody responseBody = LockBatchResponseBody.decode(response.getBody(), LockBatchResponseBody.class);
            Set<MessageQueue> messageQueues = responseBody.getLockOKMQSet();
            return messageQueues;
        }
        default:
            break;
    }

    throw new MQBrokerException(response.getCode(), response.getRemark(), addr);
}
```

#### 1.1.2 broker处理批量锁定请求lockBatchMQ

broker端通过AdminBrokerProcessor处理LOCK_BATCH_MQ请求。
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162131193.png)
lockBatchMQ方法就是broker处理批量锁定请求的方法。**broker内部使用一个ConcurrentMap<String/* group */, ConcurrentHashMap<
MessageQueue, LockEntry>> 类型的mqLockTable存储不同的consumerGroup的下面的mq到其锁定的clientId的对应关系。**大概逻辑为：

**1、** 首先将已被当前clientId锁定和未锁定的mq分别存储到不同集合然后对于未锁定的mq尝试加锁；
**2、** 获取本地锁，防止并发，这是一个ReentrantLock，所有的group的分配都获得同一个锁；
**3、** 获取该消费者组对于消息队列的加锁的情况map，存放着下面的消息队列mq到其获取了锁的消费者客户端id的映射关系*
*一个消费者组下面的一个mq只能被一个clientId锁定**；
**4、** 遍历未锁定的mq集合；

**1、** 如果mq未被任务客户端锁定，那么设置新建一个LockEntry，设置为当前clientId，表示已被当前请求的客户端锁定，内部设置锁定时间戳lastUpdateTimestamp为当前毫秒时间戳；
**2、**
如果已被被当前客户端锁定，并且没有过期那么重新设置锁定时间为当前时间戳，加入到已锁定的mq中，进行下一次循环每次锁定过期时间为REBALANCE_LOCK_MAX_LIVE_TIME，默认60s，可通过-Drocketmq.broker.rebalance.lockMaxLiveTime的broker参数设置；
**3、** 如果锁已过期，那么设置当前clientId获得了锁，进行下一次循环；
**4、** 否则，表示所没有过期并且也不是当前clientId获得的锁，仅仅输出日志，进行下一次循环；

```java
/**
 * RebalanceLockManager的方法
 * <p>
 * 尝试批量锁定，返回锁定的mq
 *
 * @param group    消费者组
 * @param mqs      需要锁定的mq集合
 * @param clientId 客户端id
 * @return 已锁定的mq集合
 */
public Set<MessageQueue> tryLockBatch(final String group, final Set<MessageQueue> mqs,
                                      final String clientId) {
   
     

    Set<MessageQueue> lockedMqs = new HashSet<MessageQueue>(mqs.size());
    Set<MessageQueue> notLockedMqs = new HashSet<MessageQueue>(mqs.size());
    //将已经锁定和未锁定的mq分别存储到不同集合
    for (MessageQueue mq : mqs) {
   
     
        if (this.isLocked(group, mq, clientId)) {
   
     
            lockedMqs.add(mq);
        } else {
   
     
            notLockedMqs.add(mq);
        }
    }
    //存在未锁定的集合，那么尝试加锁
    if (!notLockedMqs.isEmpty()) {
   
     
        try {
   
     
            //获取本地锁，是一个ReentrantLock，所有的group的分配都获得同一个锁
            this.lock.lockInterruptibly();
            try {
   
     
                //获取该消费者组对于消息队列的加锁的情况map，存放着消息队列到其获取了锁的消费者客户端id的映射关系
                ConcurrentHashMap<MessageQueue, LockEntry> groupValue = this.mqLockTable.get(group);
                if (null == groupValue) {
   
     
                    //初始化一个
                    groupValue = new ConcurrentHashMap<>(32);
                    this.mqLockTable.put(group, groupValue);
                }
                //遍历未锁定的集合
                for (MessageQueue mq : notLockedMqs) {
   
     
                    LockEntry lockEntry = groupValue.get(mq);
                    //如果该mq未锁定
                    if (null == lockEntry) {
   
     
                        //新建一个LockEntry，设置为当前clientId，表示已被当前请求的客户端锁定
                        //内部设置锁定时间戳lastUpdateTimestamp为当前毫秒时间戳
                        lockEntry = new LockEntry();
                        lockEntry.setClientId(clientId);
                        groupValue.put(mq, lockEntry);
                        log.info(
                                "tryLockBatch, message queue not locked, I got it. Group: {} NewClientId: {} {}",
                                group,
                                clientId,
                                mq);
                    }
                    //如果已被被当前客户端锁定，并且没有过期
                    //每次锁定过期时间为REBALANCE_LOCK_MAX_LIVE_TIME，默认60s，可通过-Drocketmq.broker.rebalance.lockMaxLiveTime的broker参数设置
                    if (lockEntry.isLocked(clientId)) {
   
     
                        //重新设置锁定时间为当前时间戳
                        lockEntry.setLastUpdateTimestamp(System.currentTimeMillis());
                        //加入到已锁定的mq中
                        lockedMqs.add(mq);
                        //下一次循环
                        continue;
                    }
                    //获取客户端id，此时表示不是当前clientId获得的锁，或者锁已经过期
                    String oldClientId = lockEntry.getClientId();
                    //如果锁已过期
                    if (lockEntry.isExpired()) {
   
     
                        //那么设置当前clientId获得了锁
                        lockEntry.setClientId(clientId);
                        lockEntry.setLastUpdateTimestamp(System.currentTimeMillis());
                        log.warn(
                                "tryLockBatch, message queue lock expired, I got it. Group: {} OldClientId: {} NewClientId: {} {}",
                                group,
                                oldClientId,
                                clientId,
                                mq);
                        //加入到已锁定的mq中
                        lockedMqs.add(mq);
                        //下一次循环
                        continue;
                    }
                    //到此表示mq被其他客户端锁定了
                    log.warn(
                            "tryLockBatch, message queue locked by other client. Group: {} OtherClientId: {} NewClientId: {} {}",
                            group,
                            oldClientId,
                            clientId,
                            mq);
                }
            } finally {
   
     
                //本地锁解锁
                this.lock.unlock();
            }
        } catch (InterruptedException e) {
   
     
            log.error("putMessage exception", e);
        }
    }
    //返回已锁定mq集合
    return lockedMqs;
}
```

###### 1.1.1.1.1. 分布式mq锁小结

*
*consumeMessageService服务在DefaultMQPushConsumerImpl#start方法中被初始化并启动，即调用start方法。该方法将会通过scheduledExecutorService定时任务锁定所有分配的mq，保证同时只有一个消费端可以消费。
**

*
*实际上，在之前学习的DefaultMQPushConsumer负载均衡服务的部分就知道，在集群模式加上顺序消费的情况下，一定是要向broker申请messageQueue锁成功之后，才能构建processQueue并且加入到processQueueTable，才能在随后发起拉取消息的请求，所以说，这里的定时任务，仅仅是遍历processQueueTable的所有mq并且申请锁定，起作用更多的是向broker进行分布式mq锁的续期操作。
**

*
*对于从broker锁定的mq，在客户端的过期时间默认为30s，可以通过客户端启动参数-Drocketmq.client.rebalance.lockMaxLiveTime参数设置。但是在broker端看来，这个锁的过期时间默认60s，可以通过broekr启动参数-Drocketmq.broker.rebalance.lockMaxLiveTime设置。
**

## 2 submitConsumeRequest提交消费请求

该方法首先会判断是否分发消费，即dispathToConsume是否为true，如果允许，那么将创建一个ConsumeRequest提交到ConsumeMessageOrderlyService内部的consumeExecutor线程池中进行异步消费，否则什么也不做。
**注意并没有将消息没有放进ConsumeRequest，因为消费线程会自动拉取treeMap中的消息。**

*
*什么时候dispathToConsume为true呢？当当前processQueue的内部的msgTreeMap中有消息，并且consuming=false，即还没有开始消费时，将会返回true，即新提交一个消费任务进去激活消费。如果已经在消费了，那么不会提交新的消费任务，老的消费任务会自动去msgTreeMap拉取消息。
**

注意这里的dispathToConsume应该是dispatchToConsume，这是RocketMQ中的语法错误。

```java
/**
 * ConsumeMessageOrderlyService的方法
 * 提交顺序消费请求
 *
 * @param msgs             拉取到的消息
 * @param processQueue     处理队列
 * @param messageQueue     消息队列
 * @param dispathToConsume 是否分发消费
 */
@Override
public void submitConsumeRequest(
        final List<MessageExt> msgs,
        final ProcessQueue processQueue,
        final MessageQueue messageQueue,
        final boolean dispathToConsume) {
   
     
    //如果允许分发消费
    if (dispathToConsume) {
   
     
        //构建消费请求，没有将消费放进去，消费消费会自动拉取treemap中的消息
        ConsumeRequest consumeRequest = new ConsumeRequest(processQueue, messageQueue);
        //将请求提交到consumeExecutor线程池中进行消费
        this.consumeExecutor.submit(consumeRequest);
    }
}
```

## 3 ConsumeRequest执行消费任务

ConsumeRequest作为线程任务被ConsumeMessageOrderlyService内部的consumeExecutor线程池异步的执行。

```java
/*
 * 并发消费线程池
 * 最小、最大线程数默认20，阻塞队列为无界阻塞队列LinkedBlockingQueue
 */
this.consumeExecutor = new ThreadPoolExecutor(
        this.defaultMQPushConsumer.getConsumeThreadMin(),
        this.defaultMQPushConsumer.getConsumeThreadMax(),
        1000 * 60,
        TimeUnit.MILLISECONDS,
        this.consumeRequestQueue,
        new ThreadFactoryImpl(consumeThreadPrefix));
//单线程的延迟任务线程池，用于定时执行锁定请求以及延迟提交新的消费请求
this.scheduledExecutorService = Executors.newSingleThreadScheduledExecutor(new ThreadFactoryImpl("ConsumeMessageScheduledThread_"));
```

*
*首先，我们要记住，在之前学习的DefaultMQPushConsumer负载均衡服务的部分就知道，在集群模式加上顺序消费的情况下，一定是要向broker申请messageQueue锁成功之后，才能构建processQueue并且加入到processQueueTable，才能在随后发起拉取消息的请求，所以说，能够进入到ConsumeRequest执行消息消费情况，一定是此前获得过broker的messageQueue锁。
**

ConsumeRequest的run方法，就是顺序消费的核心方法。下面我们来看看它的大概逻辑：

**1、** 如果处理队列被丢弃，那么直接返回，不再消费，例如负载均衡时该队列被分配给了其他新上线的消费者，尽量避免重复消费；
**2、** **消费消息之前先获取当前messageQueue的本地锁**，锁对象是一个Object对象，每一个mq对应一个不同的Object，采用原生的synchronized阻塞式的获取同步锁
**这将导致ConsumeMessageOrderlyService的线程池中的线程将不会同时并发的消费同一个队列**；
**3、** 如果是广播模式，或者是集群模式，并且锁定了processQueue处理队列，并且processQueue处理队列锁没有过期，那么可以消费消息p
**rocessQueue处理队列锁定实际上就是在负载均衡的时候向broker申请的消息队列分布式锁，申请成功之后将processQueue.locked属性置为true
**内部一个循环中不断的消费，直到消费超时或者条件不满足退出循环；

**1、** 如果处理队列被丢弃，那么直接返回，不再消费，例如负载均衡时该队列被分配给了其他新上线的消费者，尽量避免重复消费；
**2、**
如果是集群模式，并且没有锁定了processQueue处理队列，或者processQueue处理队列锁已经过期，那么调用tryLockLaterAndReconsume尝试延迟10ms请求broekr加锁并重新延迟提交新的消费请求；
**3、**
计算消费时间如果单次消费任务的消费时间大于默认60s，那么延迟10ms提交新的消费请求，并且结束循环，本次消费任务结束单次最大消费时间可以通过-Drocketmq.client.maxTimeConsumeContinuously配置启动参数来设置时间；
**4、**
调用getConsumeMessageBatchMaxSize方法，获取单次批量消费的数量consumeBatchSize，默认1，可以通过DefaultMQPushConsumer.consumeMessageBatchMaxSize的属性配置；
**5、** 调用takeMessages方法，从processQueue内部的msgTreeMap有序map集合中获取offset最小的consumeBatchSize条消息，按顺序从最小的offset返回，保证有序性；
**6、** 调用resetRetryAndNamespace方法，重置重试topic，当消息是重试消息的时候，将msg的topic属性从重试topic还原为真实的topic；
**7、** 如果takeMessages方法拉取到了消息，那么进行消费；

```
    1.  如果有钩子，那么执行consumeMessageBefore前置方法。我们可以通过DefaultMQPushConsumerImpl\#registerConsumeMessageHook方法注册消费钩子ConsumeMessageHook，在消费消息的前后调用。
2.  **真正消费消息之前再获取processQueue的本地消费锁，保证消息消费时，一个处理队列不会被并发消费。从这里可知，顺序消费需要获取三把锁，broker的messageQueue锁，本地的messageQueue锁，本地的processQueue锁。**
    3.  调用listener\#consumeMessage方法，进行消息消费，调用实际的业务逻辑，返回执行状态结果，有四种状态，ConsumeOrderlyStatus.SUCCESS 和 ConsumeOrderlyStatus.SUSPEND\_CURRENT\_QUEUE\_A\_MOMENT推荐使用，ConsumeOrderlyStatus.ROLLBACK和ConsumeOrderlyStatus.COMMIT已被废弃。
4.  解锁，然后对返回的执行状态结果进行判断处理。
    
    1.  如status为null，或返回了ROLLBACK或者SUSPEND\_CURRENT\_QUEUE\_A\_MOMENT状态，那么输出日志。
    2.  计算消费时间consumeRT。如果status为null，如果业务的执行抛出了异常，设置returnType为EXCEPTION，否则设置returnType为RETURNNULL。
    3.  如消费时间consumeRT大于等于consumeTimeout，**默认15min**。设置returnType为TIME\_OUT。消费超时时间可通过DefaultMQPushConsumer. consumeTimeout属性配置，默认15，单位分钟。
    4.  如status为SUSPEND\_CURRENT\_QUEUE\_A\_MOMENT，即消费失败，设置returnType为FAILED。
    5.  如status为SUCCESS，即消费成功，设置returnType为SUCCESS。
5.  如果有消费钩子，那么执行钩子函数的后置方法consumeMessageAfter。
    6.  调用**ConsumeMessageOrderlyService\#processConsumeResult**方法处理消费结果，包含重试等逻辑。
```

**8、** 如果没有拉取到消息，那么设置continueConsume为false，将会跳出循环；
**4、**
如果集群模式，但是没有锁定了processQueue处理队列，或者processQueue处理队列锁已经过期，判断如果processQueue被丢弃，则直接结束本次消费请求，否则调用tryLockLaterAndReconsume尝试延迟100ms请求borker加锁并重新延迟提交新的消费请求；

```java
class ConsumeRequest implements Runnable {
   
     
    //处理队列
    private final ProcessQueue processQueue;
    //消息队列
    private final MessageQueue messageQueue;

    public ConsumeRequest(ProcessQueue processQueue, MessageQueue messageQueue) {
   
     
        this.processQueue = processQueue;
        this.messageQueue = messageQueue;
    }

    public ProcessQueue getProcessQueue() {
   
     
        return processQueue;
    }

    public MessageQueue getMessageQueue() {
   
     
        return messageQueue;
    }

    /**
     * ConsumeMessageOrderlyService的内部类ConsumeRequest的方法
     * <p>
     * 执行顺序消费
     */
    @Override
    public void run() {
   
     
        //如果处理队列被丢弃，那么直接返回，不再消费，例如负载均衡时该队列被分配给了其他新上线的消费者，尽量避免重复消费
        if (this.processQueue.isDropped()) {
   
     
            log.warn("run, the message queue not be able to consume, because it's dropped. {}", this.messageQueue);
            return;
        }
        /*
         * 1 消费消息之前先获取当前messageQueue的本地锁，防止并发
         * 这将导致ConsumeMessageOrderlyService的线程池中的线程将不会同时并发的消费同一个队列
         */
        final Object objLock = messageQueueLock.fetchLockObject(this.messageQueue);
        /*
         * 阻塞式的获取同步锁，锁对象是一个Object对象，采用原生的synchronized锁定
         */
        synchronized (objLock) {
   
     
            /*
             * 2 如果是广播模式，或者是 （集群模式，并且锁定了processQueue处理队列，并且processQueue处理队列锁没有过期），那么可以消费消息
             * processQueue处理队列锁定实际上就是在负载均衡的时候向broker申请的消息队列分布式锁，申请成功之后将processQueue.locked属性置为true
             *
             * 当前消费者通过RebalanceImpl#rebalanceByTopic分配了新的消息队列之后，对于集群模式的顺序消费会尝试通过RebalanceImpl#lock方法请求broker获取该队列的分布式锁
             * 同理在ConsumeMessageOrderlyService启动的时候，其对于集群模式则会启动一个定时任务，默认每隔20s调用RebalanceImpl#lockAll方法，请求broker获取所有分配的队列的分布式锁
             */
            if (MessageModel.BROADCASTING.equals(ConsumeMessageOrderlyService.this.defaultMQPushConsumerImpl.messageModel())
                    || (this.processQueue.isLocked() && !this.processQueue.isLockExpired())) {
   
     
                //消费起始时间
                final long beginTime = System.currentTimeMillis();
                /*
                 * 3 循环继续消费，直到超时或者条件不满足退出循环
                 */
                for (boolean continueConsume = true; continueConsume; ) {
   
     
                    //3.1 如果处理队列被丢弃，那么直接返回，不再消费，例如负载均衡时该队列被分配给了其他新上线的消费者，尽量避免重复消费
                    if (this.processQueue.isDropped()) {
   
     
                        log.warn("the message queue not be able to consume, because it's dropped. {}", this.messageQueue);
                        //结束循环，本次消费任务结束
                        break;
                    }
                    //3.2 如果是集群模式，并且没有锁定了processQueue处理队列
                    if (MessageModel.CLUSTERING.equals(ConsumeMessageOrderlyService.this.defaultMQPushConsumerImpl.messageModel())
                            && !this.processQueue.isLocked()) {
   
     
                        log.warn("the message queue not locked, so consume later, {}", this.messageQueue);
                        //对该队列请求broker获取该队列的分布式锁，然后延迟提交消费请求
                        ConsumeMessageOrderlyService.this.tryLockLaterAndReconsume(this.messageQueue, this.processQueue, 10);
                        //结束循环，本次消费任务结束
                        break;
                    }
                    //3.3 如果是集群模式，并且processQueue处理队列锁已经过期
                    //客户端对于从broker获取的mq锁，过期时间默认30s，可以通过-Drocketmq.client.rebalance.lockMaxLiveTime参数设置
                    if (MessageModel.CLUSTERING.equals(ConsumeMessageOrderlyService.this.defaultMQPushConsumerImpl.messageModel())
                            && this.processQueue.isLockExpired()) {
   
     
                        log.warn("the message queue lock expired, so consume later, {}", this.messageQueue);
                        //对该队列请求broker获取该队列的分布式锁，然后延迟提交消费请求
                        ConsumeMessageOrderlyService.this.tryLockLaterAndReconsume(this.messageQueue, this.processQueue, 10);
                        //结束循环，本次消费任务结束
                        break;
                    }
                    //计算消费时间
                    long interval = System.currentTimeMillis() - beginTime;
                    //3.4 如果单次消费任务的消费时间大于默认60s，可以通过-Drocketmq.client.maxTimeConsumeContinuously配置启动参数来设置时间
                    if (interval > MAX_TIME_CONSUME_CONTINUOUSLY) {
   
     
                        //延迟提交新的消费请求
                        ConsumeMessageOrderlyService.this.submitConsumeRequestLater(processQueue, messageQueue, 10);
                        //结束循环，本次消费任务结束
                        break;
                    }
                    //获取单次批量消费的数量，默认1，可以通过DefaultMQPushConsumer.consumeMessageBatchMaxSize的属性配置
                    final int consumeBatchSize =
                            ConsumeMessageOrderlyService.this.defaultMQPushConsumer.getConsumeMessageBatchMaxSize();
                    /*
                     * 3.5 从processQueue内部的msgTreeMap有序map集合中获取offset最小的consumeBatchSize条消息，按顺序从最小的offset返回，保证有序性
                     */
                    List<MessageExt> msgs = this.processQueue.takeMessages(consumeBatchSize);
                    //重置重试topic，当消息是重试消息的时候，将msg的topic属性从重试topic还原为真实的topic。
                    defaultMQPushConsumerImpl.resetRetryAndNamespace(msgs, defaultMQPushConsumer.getConsumerGroup());
                    /*
                     * 4 如果拉取到了消息，那么进行消费
                     */
                    if (!msgs.isEmpty()) {
   
     
                        //顺序消费上下文
                        final ConsumeOrderlyContext context = new ConsumeOrderlyContext(this.messageQueue);
                        //消费状态
                        ConsumeOrderlyStatus status = null;

                        ConsumeMessageContext consumeMessageContext = null;
                        /*
                         * 4.1 如果有钩子，那么执行consumeMessageBefore前置方法
                         */
                        if (ConsumeMessageOrderlyService.this.defaultMQPushConsumerImpl.hasHook()) {
   
     
                            consumeMessageContext = new ConsumeMessageContext();
                            consumeMessageContext
                                    .setConsumerGroup(ConsumeMessageOrderlyService.this.defaultMQPushConsumer.getConsumerGroup());
                            consumeMessageContext.setNamespace(defaultMQPushConsumer.getNamespace());
                            consumeMessageContext.setMq(messageQueue);
                            consumeMessageContext.setMsgList(msgs);
                            consumeMessageContext.setSuccess(false);
                            // init the consume context type
                            consumeMessageContext.setProps(new HashMap<String, String>());
                            ConsumeMessageOrderlyService.this.defaultMQPushConsumerImpl.executeHookBefore(consumeMessageContext);
                        }
                        //起始时间
                        long beginTimestamp = System.currentTimeMillis();
                        //消费返回类型
                        ConsumeReturnType returnType = ConsumeReturnType.SUCCESS;
                        boolean hasException = false;
                        try {
   
     
                            /*
                             * 4.2 真正消费消息之前再获取processQueue的本地消费锁，保证消息消费时，一个处理队列不会被并发消费
                             * 从这里可知，顺序消费需要获取三把锁，broker的messageQueue锁，本地的messageQueue锁，本地的processQueue锁
                             */
                            this.processQueue.getConsumeLock().lock();
                            //如果处理队列被丢弃，那么直接返回，不再消费
                            if (this.processQueue.isDropped()) {
   
     
                                log.warn("consumeMessage, the message queue not be able to consume, because it's dropped. {}",
                                        this.messageQueue);
                                //结束循环，本次消费任务结束
                                break;
                            }
                            /*
                             * 4.3 调用listener#consumeMessage方法，进行消息消费，调用实际的业务逻辑，返回执行状态结果
                             * 有四种状态，ConsumeOrderlyStatus.SUCCESS 和 ConsumeOrderlyStatus.SUSPEND_CURRENT_QUEUE_A_MOMENT推荐使用
                             * ConsumeOrderlyStatus.ROLLBACK和ConsumeOrderlyStatus.COMMIT已被废弃
                             */
                            status = messageListener.consumeMessage(Collections.unmodifiableList(msgs), context);
                        } catch (Throwable e) {
   
     
                            log.warn(String.format("consumeMessage exception: %s Group: %s Msgs: %s MQ: %s",
                                    RemotingHelper.exceptionSimpleDesc(e),
                                    ConsumeMessageOrderlyService.this.consumerGroup,
                                    msgs,
                                    messageQueue), e);
                            //抛出异常之后，设置异常标志位
                            hasException = true;
                        } finally {
   
     
                            //解锁
                            this.processQueue.getConsumeLock().unlock();
                        }
                        /*
                         * 4.4 对返回的执行状态结果进行判断处理
                         */
                        //如status为null，或返回了ROLLBACK或者SUSPEND_CURRENT_QUEUE_A_MOMENT状态，那么输出日志
                        if (null == status
                                || ConsumeOrderlyStatus.ROLLBACK == status
                                || ConsumeOrderlyStatus.SUSPEND_CURRENT_QUEUE_A_MOMENT == status) {
   
     
                            log.warn("consumeMessage Orderly return not OK, Group: {} Msgs: {} MQ: {}",
                                    ConsumeMessageOrderlyService.this.consumerGroup,
                                    msgs,
                                    messageQueue);
                        }
                        //计算消费时间
                        long consumeRT = System.currentTimeMillis() - beginTimestamp;
                        //如status为null
                        if (null == status) {
   
     
                            //如果业务的执行抛出了异常
                            if (hasException) {
   
     
                                //设置returnType为EXCEPTION
                                returnType = ConsumeReturnType.EXCEPTION;
                            } else {
   
     
                                //设置returnType为RETURNNULL
                                returnType = ConsumeReturnType.RETURNNULL;
                            }
                        }
                        //如消费时间consumeRT大于等于consumeTimeout，默认15min
                        else if (consumeRT >= defaultMQPushConsumer.getConsumeTimeout() * 60 * 1000) {
   
     
                            //设置returnType为TIME_OUT
                            returnType = ConsumeReturnType.TIME_OUT;
                        }
                        //如status为SUSPEND_CURRENT_QUEUE_A_MOMENT，即消费失败
                        else if (ConsumeOrderlyStatus.SUSPEND_CURRENT_QUEUE_A_MOMENT == status) {
   
     
                            //设置returnType为FAILED
                            returnType = ConsumeReturnType.FAILED;
                        }
                        //如status为SUCCESS，即消费成功
                        else if (ConsumeOrderlyStatus.SUCCESS == status) {
   
     
                            //设置returnType为SUCCESS，即消费成功
                            returnType = ConsumeReturnType.SUCCESS;
                        }
                        //如果有钩子，则将returnType设置进去
                        if (ConsumeMessageOrderlyService.this.defaultMQPushConsumerImpl.hasHook()) {
   
     
                            consumeMessageContext.getProps().put(MixAll.CONSUME_CONTEXT_TYPE, returnType.name());
                        }
                        //如果status为null
                        if (null == status) {
   
     
                            //将status设置为SUSPEND_CURRENT_QUEUE_A_MOMENT，即消费失败
                            status = ConsumeOrderlyStatus.SUSPEND_CURRENT_QUEUE_A_MOMENT;
                        }
                        /*
                         * 4.5 如果有消费钩子，那么执行钩子函数的后置方法consumeMessageAfter
                         * 我们可以注册钩子ConsumeMessageHook，在消费消息的前后调用
                         */
                        if (ConsumeMessageOrderlyService.this.defaultMQPushConsumerImpl.hasHook()) {
   
     
                            consumeMessageContext.setStatus(status.toString());
                            consumeMessageContext
                                    .setSuccess(ConsumeOrderlyStatus.SUCCESS == status || ConsumeOrderlyStatus.COMMIT == status);
                            ConsumeMessageOrderlyService.this.defaultMQPushConsumerImpl.executeHookAfter(consumeMessageContext);
                        }
                        //增加消费时间
                        ConsumeMessageOrderlyService.this.getConsumerStatsManager()
                                .incConsumeRT(ConsumeMessageOrderlyService.this.consumerGroup, messageQueue.getTopic(), consumeRT);
                        /*
                         * 5 调用ConsumeMessageOrderlyService#processConsumeResult方法处理消费结果，包含重试等逻辑
                         */
                        continueConsume = ConsumeMessageOrderlyService.this.processConsumeResult(msgs, status, context, this);
                    } else {
   
     
                        //如果没有拉取到消息，那么设置continueConsume为false，将会跳出循环
                        continueConsume = false;
                    }
                }
            } else {
   
     
                //如果processQueue被丢弃，则直接结束本次消费请求
                if (this.processQueue.isDropped()) {
   
     
                    log.warn("the message queue not be able to consume, because it's dropped. {}", this.messageQueue);
                    return;
                }
                //如果是集群模式，并且没有锁定了processQueue处理队列或者processQueue处理队列锁已经过期
                //尝试延迟加锁并重新消费
                ConsumeMessageOrderlyService.this.tryLockLaterAndReconsume(this.messageQueue, this.processQueue, 100);
            }
        }
    }

}
```

### 3.1 tryLockLaterAndReconsume尝试延迟加锁并重新消费

集群模式下，尝试延迟加锁并重新消费。大概的逻辑为：

**1、** 构建一个延迟线程任务，通过延迟线程池服务在给定的延迟时间之后执行延迟时间，以及该方法的触发有两种情况：；

**1、** 如果已经在循环中，处理队列没有被丢弃，但是发现没有锁定或者锁过期，那么延迟10ms；
**2、** 如果在最开始判断的时候，处理队列没有被丢弃，但是发现没有锁定或者锁过期，那么延迟100ms；
**2、** 内部的延迟任务如下：；

**1、** 首先尝试请求broker锁定该mq；
**2、** 如果锁定成功，那么调用submitConsumeRequestLater方法延迟提交消费请求，延迟10ms；
**3、** 如果锁定失败，那么同样调用submitConsumeRequestLater方法延迟提交消费请求，但是延迟3000ms，即3s；

```java
/**
 * ConsumeMessageOrderlyService的方法
 * <p>
 * 集群模式下，尝试延迟加锁并重新消费
 *
 * @param mq           消息队列
 * @param processQueue 处理队列
 * @param delayMills   延迟时间，如果在循环中，发现没有锁定或者锁过期，那么延迟10ms；如果在最开始判断的时候，就发现处理队列没有被丢弃，但是也没有锁定或者锁过期，那么延迟100ms
 */
public void tryLockLaterAndReconsume(final MessageQueue mq, final ProcessQueue processQueue,
                                     final long delayMills) {
   
     
    //构建一个延迟线程任务，通过延迟线程池服务在给定的延迟时间之后执行
    this.scheduledExecutorService.schedule(new Runnable() {
   
     
        @Override
        public void run() {
   
     
            //尝试请求broker锁定该mq
            boolean lockOK = ConsumeMessageOrderlyService.this.lockOneMQ(mq);
            if (lockOK) {
   
     
                //如果锁定成功，那么调用submitConsumeRequestLater方法延迟提交消费请求，延迟10ms。
                ConsumeMessageOrderlyService.this.submitConsumeRequestLater(processQueue, mq, 10);
            } else {
   
     
                //如果锁定失败，那么同样调用submitConsumeRequestLater方法延迟提交消费请求，但是延迟3000ms，即3s。
                ConsumeMessageOrderlyService.this.submitConsumeRequestLater(processQueue, mq, 3000);
            }
        }
    }, delayMills, TimeUnit.MILLISECONDS);
```

#### 3.1.1 submitConsumeRequestLater延迟提交消费请求

*
*在一次消费任务过程中，如果发现除了处理队列被丢弃之外的不满足继续消费的条件时，例如：如果是集群模式但没有锁定了processQueue处理队列或者processQueue处理队列锁已经过期，或者本次任务消费时间超过了默认的最大时间60s，都将会调用submitConsumeRequestLater延迟一定时间提交新的消费请求，并且本次消费请求结束。
**

**另外，如果消费失败，返回status =
null或者SUSPEND_CURRENT_QUEUE_A_MOMENT，那么当校验没有达到最大重试次数时，也会调用submitConsumeRequestLater延迟1s提交新的消费请求，并且本次消费请求结束。
**

*
*submitConsumeRequestLater方法内部构建一个延迟线程任务，通过延迟线程池服务在给定的延迟时间之后执行submitConsumeRequest方法，其中dispathToConsume参数为true，也就是说一定会构建一个新的ConsumeRequest并且将请求提交到consumeExecutor线程池中进行消费。
**

*
*此时，执行该新提交的线程任务的线程将和执行此前的任务的线程可能不是同一个线程，但是，却一定能保证同时只有一个线程能对同一个消息队列执行消费。所以说，顺序消费同样是通过线程池消费的，他不能保证每次都是同一个线程去消费同一个消息队列，但是他能保证同一时刻同一个队列只有一个线程去消费。
**

```java
/**
 * ConsumeMessageOrderlyService的方法
 * <p>
 * 延迟提交消费请求
 *
 * @param processQueue      处理队列
 * @param messageQueue      消息队列
 * @param suspendTimeMillis 延迟时间
 */
private void submitConsumeRequestLater(
        final ProcessQueue processQueue,
        final MessageQueue messageQueue,
        final long suspendTimeMillis
) {
   
     
    //如果延迟时间为-1，则将DefaultMQPushConsumer.suspendCurrentQueueTimeMillis属性作为延迟时间，默认1s
    long timeMillis = suspendTimeMillis;
    if (timeMillis == -1) {
   
     
        timeMillis = this.defaultMQPushConsumer.getSuspendCurrentQueueTimeMillis();
    }
    //最少延迟10ms，最多延迟30000ms
    if (timeMillis < 10) {
   
     
        timeMillis = 10;
    } else if (timeMillis > 30000) {
   
     
        timeMillis = 30000;
    }
    //构建一个延迟线程任务，通过延迟线程池服务在给定的延迟时间之后执行submitConsumeRequest方法
    this.scheduledExecutorService.schedule(new Runnable() {
   
     

        @Override
        public void run() {
   
     
            //提交的消息为null，dispathToConsume为true，也就是说一定会构建一个新的ConsumeRequest并且将请求提交到consumeExecutor线程池中进行消费
            ConsumeMessageOrderlyService.this.submitConsumeRequest(null, processQueue, messageQueue, true);
        }
    }, timeMillis, TimeUnit.MILLISECONDS);
}
```

### 3.2 takeMessages拉取消息

顺序消息使用的方法。从processQueue内部的msgTreeMap有序map集合中获取offset最小的consumeBatchSize条消息，按顺序从最小的offset返回，保证有序性。

拉取操作需要获取到当前treeMapLock锁，每次都拉取移除msgTreeMap中的第一条消息，也就是offset最小的一条消息。然后将拉取到的消息存入consumingMsgOrderlyTreeMap中，表示正在消费的消息。

最后会判断如果没有拉取到任何一条消息，那么设置consuming = false，表示没有消息了，处于非消费状态。

```java
/**
 * ProcessQueue的方法
 * <p>
 * 顺序消息使用的方法
 * 从processQueue内部的msgTreeMap有序map集合中获取offset最小的consumeBatchSize条消息，按顺序从最小的offset返回，保证有序性
 *
 * @param batchSize 批量消费数量
 * @return 拉取的消息
 */
public List<MessageExt> takeMessages(final int batchSize) {
   
     
    List<MessageExt> result = new ArrayList<MessageExt>(batchSize);
    final long now = System.currentTimeMillis();
    try {
   
     
        //加锁
        this.treeMapLock.writeLock().lockInterruptibly();
        this.lastConsumeTimestamp = now;
        try {
   
     
            if (!this.msgTreeMap.isEmpty()) {
   
     
                //循环batchSize次
                for (int i = 0; i < batchSize; i++) {
   
     
                    //每次都拉取msgTreeMap中最小的一条消息
                    Map.Entry<Long, MessageExt> entry = this.msgTreeMap.pollFirstEntry();
                    if (entry != null) {
   
     
                        result.add(entry.getValue());
                        //将拉取到的消息存入consumingMsgOrderlyTreeMap中，表示正在消费的消息
                        consumingMsgOrderlyTreeMap.put(entry.getKey(), entry.getValue());
                    } else {
   
     
                        break;
                    }
                }
            }
            //如果没有拉取到任何一条消息，那么设置consuming为false，表示没有消息了，处于非消费状态
            if (result.isEmpty()) {
   
     
                consuming = false;
            }
        } finally {
   
     
            //解锁
            this.treeMapLock.writeLock().unlock();
        }
    } catch (InterruptedException e) {
   
     
        log.error("take Messages exception", e);
    }

    return result;
}
```

## 4 processConsumeResult处理消费结果

**该方法处理顺序消费的消费结果，包含提交以及重试的逻辑。**

**1、** 首先判断context.autoCommit属性是否为true，即是否设置为自动提交，这个context是在每次消费时都会创建的一个对象，并且默认都是true，除非在业务中手动改为false，所以一般都是自动提交；
**2、** 然后对于各种返回的状态进行判断和处理：；

**1、** 如果返回COMMIT和ROLLBACK这两种废弃的状态，那么仅仅打印日志，并且默认算作SUCCESS状态；
**2、** 如果返回SUCCESS，表示消费成功那么调用commit方法通过处理队列提交offset，这里仅仅是更新本地内存的消息缓存信息，返回待更新的offset然后增加成功的统计信息；
**3、** 如果返回SUSPEND_CURRENT_QUEUE_A_MOMENT，表示返回失败那么增加失败的统计信息；

```
    1.  调用checkReconsumeTimes方法，校验是否达到最大重试次数，可以通过DefaultMQPushConsumer\#maxReconsumeTimes属性配置，默认无上限，即Integer.MAX\_VALUE。
2.  如果没有到达最大重试次数，那么调用makeMessageToConsumeAgain方法标记消息等待再次消费，随后调用延迟提交新的消费请求，默认suspendTimeMillis为-1，即延迟1s后重新消费。设置continueConsume = false，本消费请求消费结束不会继续消费。
3.  达到了最大重试次数，那么调用commit提交消息，返回待更新的offset，算作成功。
```

1. 如果待更新的偏移量大于等于0并且处理队列没有被丢弃，调用OffsetStore#
   updateOffset方法，尝试更新内存中的offsetTable中的最新偏移量信息，第三个参数是否仅单调增加offset为false，表示可能会将offset更新为较小的值。这里仅仅是更新内存中的数据，而offset除了在拉取消息时上报broker进行持久化之外，还会定时每5s调用persistAllConsumerOffset定时持久化。我们在后面Consumer消费进度管理部分会学习相关源码。

```java
/**，
 * ConsumeMessageOrderlyService的方法
 *
 * @param msgs           消息
 * @param status         消费状态
 * @param context        上下文
 * @param consumeRequest 消费请求
 * @return 消费结果，是否继续消费
 */
public boolean processConsumeResult(
        final List<MessageExt> msgs,
        final ConsumeOrderlyStatus status,
        final ConsumeOrderlyContext context,
        final ConsumeRequest consumeRequest
) {
   
     
    boolean continueConsume = true;
    long commitOffset = -1L;
    //如果context设置为自动提交，context默认都是true，除非在业务中手动改为false
    if (context.isAutoCommit()) {
   
     
        switch (status) {
   
     
            //使用废弃的状态，默认算作SUCCESS
            case COMMIT:
            case ROLLBACK:
                log.warn("the message queue consume result is illegal, we think you want to ack these message {}",
                        consumeRequest.getMessageQueue());
                //消费成功
            case SUCCESS:
                /*
                 * 通过处理队列提交offset，这里仅仅是更新本地内存的消息缓存信息
                 */
                commitOffset = consumeRequest.getProcessQueue().commit();
                //统计
                this.getConsumerStatsManager().incConsumeOKTPS(consumerGroup, consumeRequest.getMessageQueue().getTopic(), msgs.size());
                break;
            //消费失败
            case SUSPEND_CURRENT_QUEUE_A_MOMENT:
                //统计
                this.getConsumerStatsManager().incConsumeFailedTPS(consumerGroup, consumeRequest.getMessageQueue().getTopic(), msgs.size());
                /*
                 * 校验是否达到最大重试次数，可以通过DefaultMQPushConsumer#maxReconsumeTimes属性配置，默认无上限，即Integer.MAX_VALUE
                 */
                if (checkReconsumeTimes(msgs)) {
   
     
                    //没有到达最大重试次数
                    //标记消息等待再次消费
                    consumeRequest.getProcessQueue().makeMessageToConsumeAgain(msgs);
                    //延迟提交新的消费请求，默认suspendTimeMillis为-1，即延迟1s后重新消费
                    this.submitConsumeRequestLater(
                            consumeRequest.getProcessQueue(),
                            consumeRequest.getMessageQueue(),
                            context.getSuspendCurrentQueueTimeMillis());
                    //本消费请求消费结束不会继续消费
                    continueConsume = false;
                } else {
   
     
                    //达到了最大重试次数，那么提交消息，算作成功
                    commitOffset = consumeRequest.getProcessQueue().commit();
                }
                break;
            default:
                break;
        }
    }
    //如果context设置为手动提交
    else {
   
     
        switch (status) {
   
     
            //消费成功
            case SUCCESS:
                //仅仅是统计数据
                this.getConsumerStatsManager().incConsumeOKTPS(consumerGroup, consumeRequest.getMessageQueue().getTopic(), msgs.size());
                break;
            //只有返回COMMIT，那么才会提交消息，这里仅仅是更新本地内存的消息缓存信息
            case COMMIT:
                commitOffset = consumeRequest.getProcessQueue().commit();
                break;
            //ROLLBACK回滚
            case ROLLBACK:
                consumeRequest.getProcessQueue().rollback();
                this.submitConsumeRequestLater(
                        consumeRequest.getProcessQueue(),
                        consumeRequest.getMessageQueue(),
                        context.getSuspendCurrentQueueTimeMillis());
                continueConsume = false;
                break;
            //消费失败稍后再试
            case SUSPEND_CURRENT_QUEUE_A_MOMENT:
                //统计
                this.getConsumerStatsManager().incConsumeFailedTPS(consumerGroup, consumeRequest.getMessageQueue().getTopic(), msgs.size());
                /*
                 * 校验是否达到最大重试次数，可以通过DefaultMQPushConsumer#maxReconsumeTimes属性配置，默认无上限，即Integer.MAX_VALUE
                 */
                if (checkReconsumeTimes(msgs)) {
   
     
                    //没有到达最大重试次数
                    //标记消息等待再次消费
                    consumeRequest.getProcessQueue().makeMessageToConsumeAgain(msgs);
                    //延迟提交新的消费请求，默认suspendTimeMillis为-1，即延迟1s后重新消费
                    this.submitConsumeRequestLater(
                            consumeRequest.getProcessQueue(),
                            consumeRequest.getMessageQueue(),
                            context.getSuspendCurrentQueueTimeMillis());
                    //本消费请求消费结束不会继续消费
                    continueConsume = false;
                }
                //达到了最大重试次数，也不会提交消息
                break;
            default:
                break;
        }
    }
    /*
     * 如果偏移量大于等于0并且处理队列没有被丢弃，调用OffsetStore# updateOffset方法，尝试更新内存中的offsetTable中的最新偏移量信息
     * 第三个参数是否仅单调增加offset为false，表示可能会将offset更新为较小的值
     * 这里仅仅是更新内存中的数据，而offset除了在拉取消息时上报broker进行持久化之外，还会定时每5s调用persistAllConsumerOffset定时持久化。
     * 我们在后面Consumer消费进度管理部分会学习相关源码。
     */
    if (commitOffset >= 0 && !consumeRequest.getProcessQueue().isDropped()) {
   
     
        this.defaultMQPushConsumerImpl.getOffsetStore().updateOffset(consumeRequest.getMessageQueue(), commitOffset, false);
    }

    return continueConsume;
}
```

### 4.1 commit提交消息

*
*一次消费成功后，或者消费失败但是重试次数已经达到最大重试次数（可以通过DefaultMQPushConsumer#maxReconsumeTimes属性配置，默认无上限，即Integer.MAX_VALUE）。那么会执行ProcessQueue#commit方法。
**

ProcessQueue#commit方法将会删除processQueue中消费完毕的消息，返回待更新的offset，或者说待提交的offset。大概步骤为：

**1、** 此前我们知道takeMessages方法会将拉取到的消息放入consumingMsgOrderlyTreeMap中，那么这里会先从该map中获取最大消息offset；
**2、** 然后msgCount减去已经消费完成的消息数量，msgSize减去已经消费完成的消息大小，清空正在消费的消息consumingMsgOrderlyTreeMap；
**3、** 最后返回下一个offset，也就是提交的待提交的offset，为已消费完毕的最大offset+1；

```java
/**
 * ProcessQueue的方法
 * 顺序消费调用的方法，删除processQueue中消费完毕的消息，返回待更新的offset
 *
 * @return 待更新的offset
 */
public long commit() {
   
     
    try {
   
     
        //加锁
        this.treeMapLock.writeLock().lockInterruptibly();
        try {
   
     
            //获取正在消费的消息map中的最大消息offset
            Long offset = this.consumingMsgOrderlyTreeMap.lastKey();
            //
            msgCount.addAndGet(0 - this.consumingMsgOrderlyTreeMap.size());
            //msgSize减去已经消费完成的消息大小
            for (MessageExt msg : this.consumingMsgOrderlyTreeMap.values()) {
   
     
                msgSize.addAndGet(0 - msg.getBody().length);
            }
            //清空正在消费的消息map
            this.consumingMsgOrderlyTreeMap.clear();
            //返回下一个offset，已消费完毕的最大offset + 1
            if (offset != null) {
   
     
                return offset + 1;
            }
        } finally {
   
     
            this.treeMapLock.writeLock().unlock();
        }
    } catch (InterruptedException e) {
   
     
        log.error("commit exception", e);
    }

    return -1;
}
```

### 4.2 checkReconsumeTimes检查重试次数

检查重试次数判断，是否挂起消费。大概逻辑为：

1. 遍历所有的消息，校验是否达到最大重试次数，可以通过DefaultMQPushConsumer#maxReconsumeTimes属性配置，默认无上限，即Integer.MAX_VALUE。
   **2、**
   如果达到最大重试次数，设置RECONSUME_TIME属性，通过sendMessageBack发回broker延迟topic如果sendMessageBack发送失败，则suspend=true，表示挂起消费，然后设置消息的重试次数属性reconsumeTimes+1；
   **3、** 如果没有达到最大重试次数则suspend=true，表示挂起消费，然后设置消息的重试次数属性reconsumeTimes+1；

可以看到，达到了最大重试次数但是sendMessageBack失败，或者没有达到最大重试次数，那么都会在随后暂时挂起消费，随后重试消费，否则的话，算作消费成功，随后将会commit。

```java
/**
 * ConsumeMessageOrderlyService的方法
 * 顺序消费调用
 * <p>
 * 校验是否达到最大重试次数，可以通过DefaultMQPushConsumer#maxReconsumeTimes属性配置，默认无上限，即Integer.MAX_VALUE
 *
 * @param msgs
 * @return
 */
private boolean checkReconsumeTimes(List<MessageExt> msgs) {
   
     
    boolean suspend = false;
    if (msgs != null && !msgs.isEmpty()) {
   
     
        //遍历消息
        for (MessageExt msg : msgs) {
   
     
            //校验是否达到最大重试次数，可以通过DefaultMQPushConsumer#maxReconsumeTimes属性配置，默认无上限，即Integer.MAX_VALUE
            if (msg.getReconsumeTimes() >= getMaxReconsumeTimes()) {
   
     
                //如果达到最大重试次数，设置RECONSUME_TIME属性
                MessageAccessor.setReconsumeTime(msg, String.valueOf(msg.getReconsumeTimes()));
                //通过sendMessageBack发回broker延迟topic
                if (!sendMessageBack(msg)) {
   
     
                    //如果sendMessageBack发送失败
                    //挂起
                    suspend = true;
                    //设置消息的重试次数属性reconsumeTimes+1
                    msg.setReconsumeTimes(msg.getReconsumeTimes() + 1);
                }
            }
            //如果没有达到最大重试次数
            else {
   
     
                //挂起
                suspend = true;
                //设置消息的重试次数属性reconsumeTimes+1
                msg.setReconsumeTimes(msg.getReconsumeTimes() + 1);
            }
        }
    }
    return suspend;
}
```

### 4.3 makeMessageToConsumeAgain标记消息重新消费

对于checkReconsumeTimes返回false的情况，即达到了最大重试次数但是sendMessageBack失败，或者没有达到最大重试次数，将会调用该方法，标记消息重新消费。

所谓标记，实际上很简单，就是将需要重复消费消息从正在消费的consumingMsgOrderlyTreeMap中移除，然后重新存入待消费的msgTreeMap中，那么将会在随后的消费中被拉取，进而实现重复消费。

*
*所以说，并发消费的重复消费，需要将消息发往broker的重试topic中，等待再次拉取并重新消费，而顺序消费的重复消费就更加简单了，通过consumingMsgOrderlyTreeMap和msgTreeMap这两个map，实现直接在本地重试，不需要经过broker，直到达到了最大重试次数，才会通过sendMessageBack方法将消息发往broker，但是不会再被消费到了。
**

```java
/**
 * ProcessQueue的方法
 * 顺序消费调用，标记消息等待再次消费
 *
 * @param msgs 标记的消息
 */
public void makeMessageToConsumeAgain(List<MessageExt> msgs) {
   
     
    try {
   
     
        //加锁
        this.treeMapLock.writeLock().lockInterruptibly();
        try {
   
     
            //遍历消息
            for (MessageExt msg : msgs) {
   
     
                //从正在消费的consumingMsgOrderlyTreeMap中移除该消息
                this.consumingMsgOrderlyTreeMap.remove(msg.getQueueOffset());
                //重新存入待消费的msgTreeMap中，那么将会在随后的消费中被拉取，进而实现重复消费
                this.msgTreeMap.put(msg.getQueueOffset(), msg);
            }
        } finally {
   
     
            //解锁
            this.treeMapLock.writeLock().unlock();
        }
    } catch (InterruptedException e) {
   
     
        log.error("makeMessageToCosumeAgain exception", e);
    }
}
```

### 4.4 updateOffset更新offset

**尝试更新内存中的offsetTable中的最新偏移量信息，第三个参数是否仅单调增加offset，顺序消费为false，并发消费为true。**

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

#### 4.4.1 compareAndIncreaseOnly仅增加offset

如果目标对象目前的值已经大于目标值，则返回false，否则在一个循环中尝试CAS的更新目标对象的值为目标值。

```java
/**
 * MixAll的方法
 * 仅增加offset
 *
 * @param target 目标值
 * @param value  目标对象
 * @return 是否增加成功
 */
public static boolean compareAndIncreaseOnly(final AtomicLong target, final long value) {
   
     
    //获取目标对象目前的值
    long prev = target.get();
    //如果目标值大于当前值，则在循环中CAS的设置值
    while (value > prev) {
   
     
        //那么尝试CAS的设置当前值为目标值
        boolean updated = target.compareAndSet(prev, value);
        //如果CAS成功则返回true
        if (updated)
            return true;
        //如果AS失败，则重新获取目标对象目前的值
        prev = target.get();
    }
    //获取目标对象目前的值已经大于目标值，则返回false
    return false;
}
```

## 5 顺序消费和并发消费的总结

我们学习了并发消费和顺序消费的源码，现在我们来总结一下他们之间的关键知识点！

**多线程和顺序性**：顺序消费和并发消费实际上都是使用线程池消费，但是不同的是，对于同一个消息队列的消息，并发消费可能有多条线程并发的消费消息，提升了消息速度，但是没有顺序性。

而顺序消费则通过一系列锁，保证同一时刻对于同一个队列只有一个线程去消费它，注意是“只有一个线程”而不是“同一个线程”，因此有可能你先发送的消息被ThreadA消费了，但是你发送的的第二个消息被ThreadB消费了，这是完全正确的，因为他们并不是同时消费的。但是对于不同的队列，顺序消费则不能保证消费有序性，因为不同的队列有不同的锁。

**消费重试**
：并发消费和顺序消费对于消费失败的消息均会有消息重试机制。[RocketMQ的消息重试（消息重投）](https://blog.csdn.net/weixin_43767015/article/details/121135114)。

**顺序消费的保证**：顺序消费模式使用3把锁来保证消费的顺序性：

**1、** **broker端的分布式锁：**；

**1、**
在负载均衡的处理新分配队列的updateProcessQueueTableInRebalance方法，以及ConsumeMessageOrderlyService服务启动时的start方法中，都会尝试向broker申请当前消费者客户端分配到的messageQueue的分布式锁；
**2、** broker端的分布式锁存储结构为ConcurrentMap<String/*group*/,ConcurrentHashMap<MessageQueue,LockEntry>>
，该分布式锁保证同一个consumerGroup下同一个messageQueue只会被分配给一个consumerClient；

3. 获取到的broker端的分布式锁，在client端的表现形式为processQueue.
   locked属性为true，且该分布式锁在broker端默认60s过期，而在client端默认30s过期，因此ConsumeMessageOrderlyService#start会启动一个定时任务，每过20s向broker申请分布式锁，刷新过期时间。而负载均衡服务也是每20s进行一次负载均衡。

**4、** broker端的分布式锁最先被获取到，如果没有获取到，那么在负载均衡的时候就不会创建processQueue了也不会提交对应的消费请求了；
**2、** **messageQueue的本地synchronized锁：**；

**1、** 在执行消费任务的开头，便会获取该messageQueue的本地锁对象objLock，它是一个Object对象，然后通过synchronized实现锁定；
**2、** 这个锁的锁对象存储在MessageQueueLock.mqLockTable属性中，结构为ConcurrentMap<MessageQueue,Object>
，所以说，一个MessageQueue对应一个锁，不同的MessageQueue有不同的锁；
**3、** 因为顺序消费也是通过线程池消费的，所以这个synchronized锁用来保证同一时刻对于同一个队列只有一个线程去消费它；
**3、** **ProcessQueue的本地consumeLock**；

```
1.  在获取到broker端的分布式锁以及messageQueue的本地synchronized锁的之后，在执行真正的消息消费的逻辑messageListener\#consumeMessage之前，会获取ProcessQueue的consumeLock，这个本地锁是一个ReentrantLock。
```

**2、** **那么这把锁有什么作用呢？**；

```
1.  在负载均衡时，如果某个队列C被分配给了新的消费者，那么当前客户端消费者需要对该队列进行释放，它会调用removeUnnecessaryMessageQueue方法对该队列C请求broker端分布式锁的解锁。
2.  而在请求broker分布式锁解锁的时候，一个重要的操作就是首先尝试获取这个messageQueue对应的ProcessQueue的本地consumeLock。只有获取了这个锁，才能尝试请求broker端对该messageQueue的分布式锁解锁。
3.  如果consumeLock加锁失败，表示当前消息队列正在消息，不能解锁。那么本次就放弃解锁了，移除消息队列失败，只有等待下次重新分配消费队列时，再进行移除。
4.  如果没有这把锁，假设该消息队列因为负载均衡而被分配给其他客户端B，但是由于客户端A正在对于拉取的一批消费消息进行消费，还没有提交消费点位，如果此时客户端A能够直接请求broker对该messageQueue解锁，这将导致客户端B获取该messageQueue的分布式锁，进而消费消息，而这些没有commit的消息将会发送重复消费。
5.  所以说这把锁的作用，就是防止在消费消息的过程中，该消息队列因为发生负载均衡而被分配给其他客户端，进而导致的两个客户端重复消费消息的行为。
```

客户端对于不属于自己的messageQueue进行解锁的方法，可以看到解锁前需要先获取这个messageQueue对应的ProcessQueue的本地consumeLock。

```java
/**
 * RebalancePushImpl的方法
 * <p>
 * 删除不必要的消息队列
 *
 * @param mq 需要删除的消息队列
 * @param pq 需要删除的消息队列的处理队列
 * @return 是否移除成功
 */
@Override
public boolean removeUnnecessaryMessageQueue(MessageQueue mq, ProcessQueue pq) {
   
     
    /*
     * 保存指定消息队列的偏移量，可能在本地存储或远程服务器
     */
    this.defaultMQPushConsumerImpl.getOffsetStore().persist(mq);
    /*
     * 移除OffsetStore内部的offsetTable中的对应消息队列的k-v数据
     */
    this.defaultMQPushConsumerImpl.getOffsetStore().removeOffset(mq);
    /*
     * Push模式下，如果当前消费者是有序消费，且是集群消费，那么尝试从Broker端将该消息队列解锁，如果是并发消费，则不会解锁
     */
    if (this.defaultMQPushConsumerImpl.isConsumeOrderly()
            && MessageModel.CLUSTERING.equals(this.defaultMQPushConsumerImpl.messageModel())) {
   
     
        try {
   
     
            //尝试获取处理队列的消费锁，最多等待1s
            //这是一个本地互斥锁，保证在获取到锁以及发起解锁的过程中，没有线程能消费该队列的消息
            //因为MessageListenerOrderly在消费消息时也需要获取该锁。
            if (pq.getConsumeLock().tryLock(1000, TimeUnit.MILLISECONDS)) {
   
     
                try {
   
     
                    /*
                     * 延迟的向Broker发送单向请求，Code为UNLOCK_BATCH_MQ，表示请求Broker释放当前消息队列的分布式锁
                     */
                    return this.unlockDelay(mq, pq);
                } finally {
   
     
                    //本地解锁
                    pq.getConsumeLock().unlock();
                }
            } else {
   
     
                //加锁失败，表示当前消息队列正在消息，不能解锁
                //那么本次就放弃解锁了，移除消息队列失败，等待下次重新分配消费队列时，再进行移除。
                log.warn("[WRONG]mq is consuming, so can not unlock it, {}. maybe hanged for a while, {}",
                        mq,
                        pq.getTryUnlockTimes());
                //尝试解锁次数+1
                pq.incTryUnlockTimes();
            }
        } catch (Exception e) {
   
     
            log.error("removeUnnecessaryMessageQueue Exception", e);
        }

        return false;
    }
    return true;
}
```