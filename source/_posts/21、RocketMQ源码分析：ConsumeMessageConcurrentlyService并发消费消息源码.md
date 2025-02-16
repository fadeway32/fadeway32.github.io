---

layout: 21、RocketMQ源码分析：ConsumeMessageConcurrentlyService并发消费消息源码

title:  21、RocketMQ源码分析：ConsumeMessageConcurrentlyService并发消费消息源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713346

abbrlink: 1739713346

date: 2025-02-16 21:42:06


--- 

# 21、RocketMQ源码分析：ConsumeMessageConcurrentlyService并发消费消息源码

此前我们学习了consumer消息的拉取流程源码：

**1、
** [RocketMQ源码(18)—DefaultMQPushConsumer消费者发起拉取消息请求源码](https://blog.csdn.net/weixin_43767015/article/details/128563451)；
**2、
** [RocketMQ源码(19)—Broker处理DefaultMQPushConsumer发起的拉取消息请求源码【一万字】](https://blog.csdn.net/weixin_43767015/article/details/128694893)；
**3、
** [RocketMQ源码(20)—DefaultMQPushConsumer处理Broker的拉取消息响应源码](https://blog.csdn.net/weixin_43767015/article/details/128783131)；

当前DefaultMQPushConsumer拉取到消息之后，会将消息提交到对应的processQueue处理队列内部的msgTreeMap中。然后通过consumeMessageService#submitConsumeRequest方法将拉取到的消息构建为ConsumeRequest，然后通过内部的consumeExecutor线程池消费消息。

consumeMessageService有ConsumeMessageConcurrentlyService并发消费和ConsumeMessageOrderlyService顺序消费两种实现，下面我们来看看这两种实现如何消费消息，本次我们先学习ConsumeMessageConcurrentlyService并发消费的源码。

#### 文章目录

- 1 start启动服务定时清理过期消息
-
    - 1.1 cleanExpireMsg清理过期消息
- 1.2cleanExpiredMsg清理过期消息
- 2 submitConsumeRequest提交消费请求
-
    - 2.2 submitConsumeRequestLater延迟提交
- 2.2 consumeMessageBatchMaxSize和pullBatchSize
- 3 ConsumeRequest执行消费任务
-
    - 3.1 resetRetryAndNamespace重设重试topic
- 4 processConsumeResult处理消费结果
-
    - 4.1 removeMessage移除消息
- 4.2 updateOffset更新offset
-
    - 4.2.1 compareAndIncreaseOnly仅增加offset

## 1 start启动服务定时清理过期消息

**consumeMessageService服务在DefaultMQPushConsumerImpl#start方法中被初始化并启动，即调用start方法。**

*
*ConsumeMessageConcurrentlyService#start方法将会通过cleanExpireMsgExecutors定时任务清理过期的消息，启动后15min开始执行，后每15min执行一次，这里的15min是RocketMQ大的默认超时时间，可通过defaultMQPushConsumer#consumeTimeout属性设置。
**

```java
/**
 * ConsumeMessageConcurrentlyService的方法
 * 启动服务
 */
public void start() {
   
     
    //通过cleanExpireMsgExecutors定时任务清理过期的消息
    //启动后15min开始执行，后每15min执行一次，这里的15min时RocketMQ大的默认超时时间，可通过defaultMQPushConsumer#consumeTimeout属性设置
    this.cleanExpireMsgExecutors.scheduleAtFixedRate(new Runnable() {
   
     

        @Override
        public void run() {
   
     
            try {
   
     
                //清理过期消息
                cleanExpireMsg();
            } catch (Throwable e) {
   
     
                log.error("scheduleAtFixedRate cleanExpireMsg exception", e);
            }
        }

    }, this.defaultMQPushConsumer.getConsumeTimeout(), this.defaultMQPushConsumer.getConsumeTimeout(), TimeUnit.MINUTES);
}
```

### 1.1 cleanExpireMsg清理过期消息

该方法获取所有的消息队列和处理队列的键值对，循环遍历并且调用ProcessQueue#cleanExpiredMsg方法清理过期消息。

```java
/**
 * ConsumeMessageConcurrentlyService的方法
 * <p>
 * 清理过期消息
 */
private void cleanExpireMsg() {
   
     
    //获取所有的消息队列和处理队列的键值对
    Iterator<Map.Entry<MessageQueue, ProcessQueue>> it =
            this.defaultMQPushConsumerImpl.getRebalanceImpl().getProcessQueueTable().entrySet().iterator();
    //循环遍历
    while (it.hasNext()) {
   
     
        Map.Entry<MessageQueue, ProcessQueue> next = it.next();
        ProcessQueue pq = next.getValue();
        //调用ProcessQueue#cleanExpiredMsg方法清理过期消息
        pq.cleanExpiredMsg(this.defaultMQPushConsumer);
    }
}
```

### 1.2cleanExpiredMsg清理过期消息

**循环清理msgTreeMap中的过期消息，每次最多循环清理16条消息。**

**1、** 每次循环首先获取msgTreeMap中的第一次元素的起始消费时间，msgTreeMap是一个红黑树，第一个节点就是offset最小的节点；
**2、** 如果消费时间距离现在时间超过默认15min，那么获取这个msg，如果没有被消费，或者消费时间距离现在时间不超过默认15min，则结束循环；
**3、** 将获取到的消息通过sendMessageBack发回broker延迟topic，将在给定延迟时间（默认从level3，即10s开始）之后发回进行重试消费；
**4、** 加锁判断如果这个消息还没有被消费完，并且还是在第一位，那么调用removeMessage方法从msgTreeMap中移除消息，进行下一轮判断；

```java
/**
 * ProcessQueue的方法
 * 清理过期消息
 *
 * @param pushConsumer 消费者
 */
public void cleanExpiredMsg(DefaultMQPushConsumer pushConsumer) {
   
     
    //如果是顺序消费，直接返回，只有并发消费才会清理
    if (pushConsumer.getDefaultMQPushConsumerImpl().isConsumeOrderly()) {
   
     
        return;
    }
    //一次循环最多处理16个消息
    int loop = msgTreeMap.size() < 16 ? msgTreeMap.size() : 16;
    //遍历消息，最多处理前16个消息
    for (int i = 0; i < loop; i++) {
   
     
        MessageExt msg = null;
        try {
   
     
            //加锁
            this.treeMapLock.readLock().lockInterruptibly();
            try {
   
     
                if (!msgTreeMap.isEmpty()) {
   
     
                    //获取msgTreeMap中的第一次元素的起始消费时间，msgTreeMap是一个红黑树，第一个节点就是offset最小的节点
                    String consumeStartTimeStamp = MessageAccessor.getConsumeStartTimeStamp(msgTreeMap.firstEntry().getValue());
                    //如果消费时间距离现在时间超过默认15min，那么获取这个msg
                    if (StringUtils.isNotEmpty(consumeStartTimeStamp) && System.currentTimeMillis() - Long.parseLong(consumeStartTimeStamp) > pushConsumer.getConsumeTimeout() * 60 * 1000) {
   
     
                        msg = msgTreeMap.firstEntry().getValue();
                    } else {
   
     
                        //如果没有被消费，或者消费时间距离现在时间不超过默认15min，则结束循环
                        break;
                    }
                } else {
   
     
                    //msgTreeMap为空，结束循环
                    break;
                }
            } finally {
   
     
                this.treeMapLock.readLock().unlock();
            }
        } catch (InterruptedException e) {
   
     
            log.error("getExpiredMsg exception", e);
        }

        try {
   
     
            //将消息发回broker延迟topic，将在给定延迟时间（默认从level3，即10s开始）之后进行重试消费
            pushConsumer.sendMessageBack(msg, 3);
            log.info("send expire msg back. topic={}, msgId={}, storeHost={}, queueId={}, queueOffset={}", msg.getTopic(), msg.getMsgId(), msg.getStoreHost(), msg.getQueueId(), msg.getQueueOffset());
            try {
   
     
                this.treeMapLock.writeLock().lockInterruptibly();
                try {
   
     
                    //如果这个消息还没有被消费完
                    if (!msgTreeMap.isEmpty() && msg.getQueueOffset() == msgTreeMap.firstKey()) {
   
     
                        try {
   
     
                            //移除消息
                            removeMessage(Collections.singletonList(msg));
                        } catch (Exception e) {
   
     
                            log.error("send expired msg exception", e);
                        }
                    }
                } finally {
   
     
                    this.treeMapLock.writeLock().unlock();
                }
            } catch (InterruptedException e) {
   
     
                log.error("getExpiredMsg exception", e);
            }
        } catch (Exception e) {
   
     
            log.error("send expired msg exception", e);
        }
    }
}
```

## 2 submitConsumeRequest提交消费请求

*
*该方法将消息批量的封装为ConsumeRequest提交到ConsumeMessageConcurrentlyService内部的consumeExecutor线程池中进行异步消费，如果提交失败，则调用submitConsumeRequestLater方法延迟5s进行提交，而不是丢弃。
**

**1、** 首先获取单次批量消费的数量，**默认1**，通过DefaultMQPushConsumer的consumeMessageBatchMaxSize属性配置；
**2、** 如果消息数量<=单次批量消费的数量，那么直接全量消费，构建一个ConsumeRequest并提交到consumeExecutor线程池；
**3、** 如果消息数量>单次批量消费的数量，那么需要分割消息进行分批提交；

**从该方法可以得知，对于并发消费模式，拉取到的一批消息被分批次提交到线程池之后，就由线程池里面的线程异步的消费，我们知道线程池里面的线程执行先后顺序时不可控制的，因此这些不同批次的消息会被并发、的无序的消费。
**

```java
/**
 * ConsumeMessageOrderlyService的方法
 * 提交并发消费请求
 *
 * @param msgs              拉取到的消息
 * @param processQueue      处理队列
 * @param messageQueue      消息队列
 * @param dispatchToConsume 是否分发消费，对于并发消费无影响
 */
@Override
public void submitConsumeRequest(
        final List<MessageExt> msgs,
        final ProcessQueue processQueue,
        final MessageQueue messageQueue,
        final boolean dispatchToConsume) {
   
     
    //单次批量消费的数量，默认1
    final int consumeBatchSize = this.defaultMQPushConsumer.getConsumeMessageBatchMaxSize();
    /*
     * 如果消息数量 <= 单次批量消费的数量，那么直接全量消费
     */
    if (msgs.size() <= consumeBatchSize) {
   
     
        //构建消费请求，将消息全部放进去
        ConsumeRequest consumeRequest = new ConsumeRequest(msgs, processQueue, messageQueue);
        try {
   
     
            //将请求提交到consumeExecutor线程池中进行消费
            this.consumeExecutor.submit(consumeRequest);
        } catch (RejectedExecutionException e) {
   
     
            //提交的任务被线程池拒绝，那么延迟5s进行提交，而不是丢弃
            this.submitConsumeRequestLater(consumeRequest);
        }
    }
    /*
     * 如果消息数量 > 单次批量消费的数量，那么需要分割消息进行分批提交
     */
    else {
   
     
        //遍历
        for (int total = 0; total < msgs.size(); ) {
   
     
            //一批消息集合，每批消息最多consumeBatchSize条，默认1
            List<MessageExt> msgThis = new ArrayList<MessageExt>(consumeBatchSize);
            //将消息按顺序加入集合
            for (int i = 0; i < consumeBatchSize; i++, total++) {
   
     
                if (total < msgs.size()) {
   
     
                    msgThis.add(msgs.get(total));
                } else {
   
     
                    break;
                }
            }
            //将本批次消息构建为ConsumeRequest
            ConsumeRequest consumeRequest = new ConsumeRequest(msgThis, processQueue, messageQueue);
            try {
   
     
                //将请求提交到consumeExecutor线程池中进行消费
                this.consumeExecutor.submit(consumeRequest);
            } catch (RejectedExecutionException e) {
   
     
                for (; total < msgs.size(); total++) {
   
     
                    msgThis.add(msgs.get(total));
                }
                //提交的任务被线程池拒绝，那么延迟5s进行提交，而不是丢弃
                this.submitConsumeRequestLater(consumeRequest);
            }
        }
    }
}
```

**consumeExecutor线程池用于消费消息，其定义如下：最小、最大线程数默认20，阻塞队列为无界阻塞队列LinkedBlockingQueue。**

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
//单线程的延迟任务线程池，用于延迟提交消费请求
this.scheduledExecutorService = Executors.newSingleThreadScheduledExecutor(new ThreadFactoryImpl("ConsumeMessageScheduledThread_"));
//单线程的延迟任务线程池，用于处理过期的消息
this.cleanExpireMsgExecutors = Executors.newSingleThreadScheduledExecutor(new ThreadFactoryImpl("CleanExpireMsgScheduledThread_"));
```

### 2.2 submitConsumeRequestLater延迟提交

**提交的任务被线程池拒绝，那么延迟5s进行提交，而不是丢弃。**

```java
/**
 * ConsumeMessageConcurrentlyService的方法
 * 
 * 提交的任务被线程池拒绝，那么延迟5s进行提交，而不是丢弃
 * @param consumeRequest 提交请求
 */
private void submitConsumeRequestLater(final ConsumeRequest consumeRequest
) {
   
     
    this.scheduledExecutorService.schedule(new Runnable() {
   
     

        @Override
        public void run() {
   
     
            //将提交的行为封装为一个线程任务，提交到scheduledExecutorService延迟线程池，5s之后执行
            ConsumeMessageConcurrentlyService.this.consumeExecutor.submit(consumeRequest);
        }
    }, 5000, TimeUnit.MILLISECONDS);
}
```

### 2.2 consumeMessageBatchMaxSize和pullBatchSize

co*
*nsumeMessageBatchMaxSize是什么意思呢？他的字面意思就是单次批量消费的数量，实际上它代表着每次发送给消息监听器MessageListenerOrderly或者MessageListenerConcurrently的consumeMessage方法中的参数List
msgs中的最多的消息数量。**

*
*consumeMessageBatchMaxSize默认值为1，所以说，无论是并发消费还是顺序消费，每次的consumeMessage方法的执行，msgs集合默认都只有一条消息。同理，如果把它设置为其他值n，无论是并发消费还是顺序消费，每次的consumeMessage的执行，msgs集合默认都最多只有n条消息。
**

**另外，在此前拉取消息的源码中，我们还学习了另一个参数pullBatchSize，默认值为32，其代表的是每一次拉取请求最多批量拉取的消费数量。也就是说无论是并发消费还是顺序消费，每次最多拉取32条消息。
**

## 3 ConsumeRequest执行消费任务

ConsumeRequest本身是一个线程任务，当拉取到消息之后，会将一批消息构建为一个ConsumeRequest对象，提交给consumeExecutor，由线程池异步的执行，它的run方法就是并发消费的核心方法。大概逻辑为：

**1、** 如果处理队列被丢弃，即dropped=true，那么直接返回，不再消费，例如负载均衡时该队列被分配给了其他新上线的消费者，尽量避免重复消费；
**2、** 调用resetRetryAndNamespace方法，当消息是重试消息的时候，将msg的topic属性从重试topic还原为真实的topic；

3.
如果有消费钩子，那么执行钩子函数的前置方法consumeMessageBefore。我们可以通过DefaultMQPushConsumerImpl#registerConsumeMessageHook方法注册消费钩子ConsumeMessageHook，在消费消息的前后调用。
4. 调用listener#consumeMessage方法，进行消息消费，调用实际的业务逻辑，返回执行状态结果如status为null。

**1、**
正常情况下可返回两种状态：ConsumeConcurrentlyStatus.CONSUME_SUCCESS表示消费成功，ConsumeConcurrentlyStatus.RECONSUME_LATER表示消费失败，如果中途抛出异常，则status为null；
**5、** 对返回的执行状态结果进行判断处理从这里可得知消费超时时间为15min，另外如果返回的status为null，那么status将会被设置为RECONSUME_LATER，即消费失败；

**1、** 计算消费时间consumeRT如果status为null，如果业务的执行抛出了异常，设置returnType为EXCEPTION，否则设置returnType为RETURNNULL；
**2、**
如消费时间consumeRT大于等于consumeTimeout，默认15min设置returnType为TIME_OUT消费超时时间可通过DefaultMQPushConsumer.consumeTimeout属性配置，默认15，单位分钟；
**3、** 如status为RECONSUME_LATER，即消费失败，设置returnType为FAILED；
**4、** 如status为CONSUME_SUCCESS，即消费成功，设置returnType为SUCCESS；
**6、** 如果有消费钩子，那么执行钩子函数的后置方法consumeMessageAfter；

7. 如果处理队列没有被丢弃，即dropped=false，*
   *那么调用ConsumeMessageConcurrentlyService#processConsumeResult方法处理消费结果，包含消费重试、提交offset等操作。**

需*
*要注意的是，如果在执行了listener#consumeMessage方法，即执行了业务逻辑之后，处理消费结果之前，该消息队列被丢弃了，例如负载均衡时该队列被分配给了其他新上线的消费者，那么由于dropped=false，导致不会进行最后的消费结果处理，将会导致消息的重复消费，因此必须做好业务层面的幂等性！
**

```java
class ConsumeRequest implements Runnable {
   
     
    //一次消费的消息集合，默认1条消息
    private final List<MessageExt> msgs;
    //处理队列
    private final ProcessQueue processQueue;
    //消息队列
    private final MessageQueue messageQueue;

    public ConsumeRequest(List<MessageExt> msgs, ProcessQueue processQueue, MessageQueue messageQueue) {
   
     
        this.msgs = msgs;
        this.processQueue = processQueue;
        this.messageQueue = messageQueue;
    }

    public List<MessageExt> getMsgs() {
   
     
        return msgs;
    }

    public ProcessQueue getProcessQueue() {
   
     
        return processQueue;
    }

    /**
     * ConsumeMessageConcurrentlyService的内部类ConsumeRequest的方法
     * <p>
     * 执行并发消费
     */
    @Override
    public void run() {
   
     
        //如果处理队列被丢弃，那么直接返回，不再消费，例如负载均衡时该队列被分配给了其他新上线的消费者，尽量避免重复消费
        if (this.processQueue.isDropped()) {
   
     
            log.info("the message queue not be able to consume, because it's dropped. group={} {}", ConsumeMessageConcurrentlyService.this.consumerGroup, this.messageQueue);
            return;
        }
        /*
         * 1 获取并发消费的消息监听器，push模式模式下是我们需要开发的，通过registerMessageListener方法注册，内部包含了要执行的业务逻辑
         */
        MessageListenerConcurrently listener = ConsumeMessageConcurrentlyService.this.messageListener;
        ConsumeConcurrentlyContext context = new ConsumeConcurrentlyContext(messageQueue);
        ConsumeConcurrentlyStatus status = null;
        //重置重试topic
        defaultMQPushConsumerImpl.resetRetryAndNamespace(msgs, defaultMQPushConsumer.getConsumerGroup());

        /*
         * 2 如果有消费钩子，那么执行钩子函数的前置方法consumeMessageBefore
         * 我们可以注册钩子ConsumeMessageHook，再消费消息的前后调用
         */
        ConsumeMessageContext consumeMessageContext = null;
        if (ConsumeMessageConcurrentlyService.this.defaultMQPushConsumerImpl.hasHook()) {
   
     
            consumeMessageContext = new ConsumeMessageContext();
            consumeMessageContext.setNamespace(defaultMQPushConsumer.getNamespace());
            consumeMessageContext.setConsumerGroup(defaultMQPushConsumer.getConsumerGroup());
            consumeMessageContext.setProps(new HashMap<String, String>());
            consumeMessageContext.setMq(messageQueue);
            consumeMessageContext.setMsgList(msgs);
            consumeMessageContext.setSuccess(false);
            ConsumeMessageConcurrentlyService.this.defaultMQPushConsumerImpl.executeHookBefore(consumeMessageContext);
        }
        //起始时间戳
        long beginTimestamp = System.currentTimeMillis();
        boolean hasException = false;
        //消费返回类型，初始化为SUCCESS
        ConsumeReturnType returnType = ConsumeReturnType.SUCCESS;
        try {
   
     
            if (msgs != null && !msgs.isEmpty()) {
   
     
                //循环设置每个消息的起始消费时间
                for (MessageExt msg : msgs) {
   
     
                    MessageAccessor.setConsumeStartTimeStamp(msg, String.valueOf(System.currentTimeMillis()));
                }
            }
            /*
             * 3 调用listener#consumeMessage方法，进行消息消费，调用实际的业务逻辑，返回执行状态结果
             * 有两种状态ConsumeConcurrentlyStatus.CONSUME_SUCCESS 和 ConsumeConcurrentlyStatus.RECONSUME_LATER
             */
            status = listener.consumeMessage(Collections.unmodifiableList(msgs), context);
        } catch (Throwable e) {
   
     
            log.warn(String.format("consumeMessage exception: %s Group: %s Msgs: %s MQ: %s",
                    RemotingHelper.exceptionSimpleDesc(e),
                    ConsumeMessageConcurrentlyService.this.consumerGroup,
                    msgs,
                    messageQueue), e);
            //抛出异常之后，设置异常标志位
            hasException = true;
        }
        /*
         * 4 对返回的执行状态结果进行判断处理
         */
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
        //如status为RECONSUME_LATER，即消费失败
        else if (ConsumeConcurrentlyStatus.RECONSUME_LATER == status) {
   
     
            //设置returnType为FAILED
            returnType = ConsumeReturnType.FAILED;
        }
        //如status为CONSUME_SUCCESS，即消费成功
        else if (ConsumeConcurrentlyStatus.CONSUME_SUCCESS == status) {
   
     
            //设置returnType为SUCCESS，即消费成功
            returnType = ConsumeReturnType.SUCCESS;
        }
        //如果有钩子，则将returnType设置进去
        if (ConsumeMessageConcurrentlyService.this.defaultMQPushConsumerImpl.hasHook()) {
   
     
            consumeMessageContext.getProps().put(MixAll.CONSUME_CONTEXT_TYPE, returnType.name());
        }
        //如果status为null
        if (null == status) {
   
     
            log.warn("consumeMessage return null, Group: {} Msgs: {} MQ: {}",
                    ConsumeMessageConcurrentlyService.this.consumerGroup,
                    msgs,
                    messageQueue);
            //将status设置为RECONSUME_LATER，即消费失败
            status = ConsumeConcurrentlyStatus.RECONSUME_LATER;
        }
        /*
         * 5 如果有消费钩子，那么执行钩子函数的后置方法consumeMessageAfter
         * 我们可以注册钩子ConsumeMessageHook，在消费消息的前后调用
         */
        if (ConsumeMessageConcurrentlyService.this.defaultMQPushConsumerImpl.hasHook()) {
   
     
            consumeMessageContext.setStatus(status.toString());
            consumeMessageContext.setSuccess(ConsumeConcurrentlyStatus.CONSUME_SUCCESS == status);
            ConsumeMessageConcurrentlyService.this.defaultMQPushConsumerImpl.executeHookAfter(consumeMessageContext);
        }
        //增加消费时间
        ConsumeMessageConcurrentlyService.this.getConsumerStatsManager()
                .incConsumeRT(ConsumeMessageConcurrentlyService.this.consumerGroup, messageQueue.getTopic(), consumeRT);
        /*
         * 6 如果处理队列没有被丢弃，那么调用ConsumeMessageConcurrentlyService#processConsumeResult方法处理消费结果，包含重试等逻辑
         */
        if (!processQueue.isDropped()) {
   
     
            ConsumeMessageConcurrentlyService.this.processConsumeResult(status, context, this);
        } else {
   
     
            log.warn("processQueue is dropped without process consume result. messageQueue={}, msgs={}", messageQueue, msgs);
        }
    }

    public MessageQueue getMessageQueue() {
   
     
        return messageQueue;
    }

}
```

### 3.1 resetRetryAndNamespace重设重试topic

当消息是重试消息的时候，将msg的topic属性从重试topic还原为真实的topic。

```java
public void resetRetryAndNamespace(final List<MessageExt> msgs, String consumerGroup) {
   
     
    //获取重试topic
    final String groupTopic = MixAll.getRetryTopic(consumerGroup);
    for (MessageExt msg : msgs) {
   
     
        //尝试通过PROPERTY_RETRY_TOPIC属性获取每个消息的真实topic
        String retryTopic = msg.getProperty(MessageConst.PROPERTY_RETRY_TOPIC);
        //如果该属性不为null，并且重试topic和消息的topic相等，则表示当前消息是重试消息
        if (retryTopic != null && groupTopic.equals(msg.getTopic())) {
   
     
            //那么设置消息的topic为真实topic，即还原回来
            msg.setTopic(retryTopic);
        }

        if (StringUtils.isNotEmpty(this.defaultMQPushConsumer.getNamespace())) {
   
     
            msg.setTopic(NamespaceUtil.withoutNamespace(msg.getTopic(), this.defaultMQPushConsumer.getNamespace()));
        }
    }
}
```

## 4 processConsumeResult处理消费结果

**对于并发消费的消费结果通过ConsumeMessageConcurrentlyService#processConsumeResult方法处理。**

*
*需要注意的是，如果在执行了listener#consumeMessage方法，即执行了业务逻辑之后，处理消费结果之前，该消息队列被丢弃了，例如负载均衡时该队列被分配给了其他新上线的消费者，那么由于dropped=false，导致不会进行最后的消费结果处理，将会导致消息的重复消费，因此必须做好业务层面的幂等性！
**

processConsumeResult方法的大概步骤为：

**1、** 获取ackIndex，默认初始值为Integer.MAX_VALUE，该值表示消费成功的消息在消息集合中的索引，用于辅助进行消息重试；
**2、** 判断消费状态，设置ackIndex的值：；

**1、** CONSUME_SUCCESS消费成功：ackIndex=消息数量–1；
**2、** RECONSUME_LATER消费失败：ackIndex=-1；
**3、** 判断消息模式，处理消费失败的情况：；

**1、** BROADCASTING广播模式：对于没有消费成功的消息仅仅打印日志；
**2、** CLUSTERING集群模式：；

```
1.  对于消费失败的消息，调用sendMessageBack方法向broker发送发回当前消息作为延迟消息到重试队列，等待重试消费。对于sendMessageBack发送失败的消息加入msgBackFailed失败集合，设置消息的重试次数属性reconsumeTimes+1
2.  对于sendMessageBack发送失败的消息，调用submitConsumeRequestLater方法，延迟5s将sendMessageBack执行失败的消息再次提交到consumeExecutor进行消费。
```

1. 调用ProcessQueue#removeMessage方法从处理队列的msgTreeMap中将消费成功的消息，以及消费失败但是发回broker成功的这批消息移除，然后返回msgTreeMap中的最小的偏移量。
2. 如果偏移量大于等于0并且处理队列没有被丢弃，调用OffsetStore#
   updateOffset方法，尝试更新内存中的offsetTable中的最新偏移量信息，第三个参数是否仅单调增加offset为true，表示只会尝试更新offset为更大的值。这里仅仅是更新内存中的数据，而offset除了在拉取消息时上报broker进行持久化之外，还会定时每5s调用persistAllConsumerOffset定时持久化。我们在后面Consumer消费进度管理部分会学习相关源码。

```java
/**
 * ConsumeMessageConcurrentlyService的方法
 * <p>
 * 处理消费结果
 *
 * @param status         消费状态
 * @param context        上下文
 * @param consumeRequest 消费请求
 */
public void processConsumeResult(
        final ConsumeConcurrentlyStatus status,
        final ConsumeConcurrentlyContext context,
        final ConsumeRequest consumeRequest
) {
   
     
    //ackIndex，默认初始值为Integer.MAX_VALUE，表示消费成功的消息在消息集合中的索引
    int ackIndex = context.getAckIndex();
    //如果消息为空则直接返回
    if (consumeRequest.getMsgs().isEmpty())
        return;
    /*
     * 1 判断消费状态，设置ackIndex的值
     * 消费成功： ackIndex = 消息数量 - 1
     * 消费失败： ackIndex = -1
     */
    switch (status) {
   
     
        //如果消费成功
        case CONSUME_SUCCESS:
            //如果大于等于消息数量，则设置为消息数量减1
            //初始值为Integer.MAX_VALUE，因此一般都会设置为消息数量减1
            if (ackIndex >= consumeRequest.getMsgs().size()) {
   
     
                ackIndex = consumeRequest.getMsgs().size() - 1;
            }
            //消费成功的个数，即消息数量
            int ok = ackIndex + 1;
            //消费失败的个数，即0
            int failed = consumeRequest.getMsgs().size() - ok;
            //统计
            this.getConsumerStatsManager().incConsumeOKTPS(consumerGroup, consumeRequest.getMessageQueue().getTopic(), ok);
            this.getConsumerStatsManager().incConsumeFailedTPS(consumerGroup, consumeRequest.getMessageQueue().getTopic(), failed);
            break;
        //如果消费失败
        case RECONSUME_LATER:
            //ackIndex初始化为-1
            ackIndex = -1;
            //统计
            this.getConsumerStatsManager().incConsumeFailedTPS(consumerGroup, consumeRequest.getMessageQueue().getTopic(),
                    consumeRequest.getMsgs().size());
            break;
        default:
            break;
    }
    /*
     * 2 判断消息模式，处理消费失败的情况
     * 广播模式：打印日志
     * 集群模式：向broker发送当前消息作为延迟消息，等待重试消费
     */
    switch (this.defaultMQPushConsumer.getMessageModel()) {
   
     
        //广播模式下
        case BROADCASTING:
            //从消费成功的消息在消息集合中的索引+1开始，仅仅是对于消费失败的消息打印日志，并不会重试
            for (int i = ackIndex + 1; i < consumeRequest.getMsgs().size(); i++) {
   
     
                MessageExt msg = consumeRequest.getMsgs().get(i);
                log.warn("BROADCASTING, the message consume failed, drop it, {}", msg.toString());
            }
            break;
        //集群模式下
        case CLUSTERING:
            List<MessageExt> msgBackFailed = new ArrayList<MessageExt>(consumeRequest.getMsgs().size());
            //消费成功的消息在消息集合中的索引+1开始，遍历消息
            for (int i = ackIndex + 1; i < consumeRequest.getMsgs().size(); i++) {
   
     
                //获取该索引对应的消息
                MessageExt msg = consumeRequest.getMsgs().get(i);
                /*
                 * 2.1 消费失败后，将该消息重新发送至重试队列，延迟消费
                 */
                boolean result = this.sendMessageBack(msg, context);
                //如果执行发送失败
                if (!result) {
   
     
                    //设置重试次数+！
                    msg.setReconsumeTimes(msg.getReconsumeTimes() + 1);
                    //加入失败的集合
                    msgBackFailed.add(msg);
                }
            }

            if (!msgBackFailed.isEmpty()) {
   
     
                //从consumeRequest中移除消费失败并且发回broker失败的消息
                consumeRequest.getMsgs().removeAll(msgBackFailed);
                /*
                 * 2.2 调用submitConsumeRequestLater方法，延迟5s将sendMessageBack执行失败的消息再次提交到consumeExecutor进行消费
                 */
                this.submitConsumeRequestLater(msgBackFailed, consumeRequest.getProcessQueue(), consumeRequest.getMessageQueue());
            }
            break;
        default:
            break;
    }
    /*
     * 3 从处理队列的msgTreeMap中将消费成功以及消费失败但是发回broker成功的这批消息移除，然后返回msgTreeMap中的最小的偏移量
     */
    long offset = consumeRequest.getProcessQueue().removeMessage(consumeRequest.getMsgs());
    //如果偏移量大于等于0并且处理队列没有被丢弃
    if (offset >= 0 && !consumeRequest.getProcessQueue().isDropped()) {
   
     
        //尝试更新内存中的offsetTable中的最新偏移量信息，第三个参数是否仅单调增加offset为true
        this.defaultMQPushConsumerImpl.getOffsetStore().updateOffset(consumeRequest.getMessageQueue(), offset, true);
    }
}
```

### 4.1 removeMessage移除消息

**从处理队列的msgTreeMap中将消费成功，以及消费失败但是发回broker成功的这批消息移除，然后返回msgTreeMap中的最小的消息偏移量。如果移除后msgTreeMap为空了，那么直接返回该处理队列记录的最大的消息偏移量+1。
**

*
*这个返回的offset将会尝试用于更新在内存中的offsetTable中的最新偏移量信息，而offset除了在拉取消息时持久化之外，还会定时每5s调用persistAllConsumerOffset定时持久化。我们在后面Consumer消费进度管理部分会学习源码。
**

```java
/**
 * ProcessQueue的方法
 * <p>
 * 移除执行集合中的所有消息，然后返回msgTreeMap中的最小的消息偏移量
 *
 * @param msgs 需要被移除的消息集合
 * @return msgTreeMap中的最小的消息偏移量
 */
public long removeMessage(final List<MessageExt> msgs) {
   
     
    long result = -1;
    final long now = System.currentTimeMillis();
    try {
   
     
        //获取锁
        this.treeMapLock.writeLock().lockInterruptibly();
        //更新时间戳
        this.lastConsumeTimestamp = now;
        try {
   
     
            //如果msgTreeMap存在数据
            if (!msgTreeMap.isEmpty()) {
   
     
                //首先将result设置为该队列最大的消息偏移量+1
                result = this.queueOffsetMax + 1;
                int removedCnt = 0;
                //遍历每一条消息尝试异常
                for (MessageExt msg : msgs) {
   
     
                    MessageExt prev = msgTreeMap.remove(msg.getQueueOffset());
                    if (prev != null) {
   
     
                        removedCnt--;
                        msgSize.addAndGet(0 - msg.getBody().length);
                    }
                }
                msgCount.addAndGet(removedCnt);
                //如果移除消息之后msgTreeMap不为空集合，那么result设置为msgTreeMap当前最小的消息偏移量
                if (!msgTreeMap.isEmpty()) {
   
     
                    result = msgTreeMap.firstKey();
                }
            }
        } finally {
   
     
            this.treeMapLock.writeLock().unlock();
        }
    } catch (Throwable t) {
   
     
        log.error("removeMessage exception", t);
    }

    return result;
}
```

### 4.2 updateOffset更新offset

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

#### 4.2.1 compareAndIncreaseOnly仅增加offset

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