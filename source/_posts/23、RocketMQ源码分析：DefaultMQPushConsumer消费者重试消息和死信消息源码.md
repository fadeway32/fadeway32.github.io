---

layout: 23、RocketMQ源码分析：DefaultMQPushConsumer消费者重试消息和死信消息源码

title:  23、RocketMQ源码分析：DefaultMQPushConsumer消费者重试消息和死信消息源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713348

abbrlink: 1739713348

date: 2025-02-16 21:42:06


--- 

# 23、RocketMQ源码分析：DefaultMQPushConsumer消费者重试消息和死信消息源码

分类：[RocketMQ源码分析（1）](https://cxykk.com/?cat=318)  2024-03-27 阅读(135)

> 基于RocketMQ release-4.9.3，深入的介绍了DefaultMQPushConsumer消费者重试消息和死信消息源码。

消费重试：并发消费和顺序消费对于消费失败的消息均会有消息重试机制。此前已经学了相关的知识：[RocketMQ的消费者消息重试和生产者消息重投](https://blog.csdn.net/weixin_43767015/article/details/121135114)
，现在我们来看看他们的源码。

#### 文章目录

- 1 并发消费重试
-
    - 1.1 失败重试
    -
        - 1.1.1 ConsumeMessageConcurrentlyService#sendMessageBack发送消费失败的消息
        - 1.1.2 DefaultMQPushConsumerImpl#sendMessageBack发送消费失败的消息
    -
        - 1.1.1.2.1 getMaxReconsumeTimes获取最大重试次数
    - 1.1.3 consumerSendMessageBack发送消费失败的消息
- 1.2 超时重试
- 2 顺序消费重试
-
    - 2.1 失败重试
-
    - 2.1.1 sendMessageBack发送失败消息
- 2.2 超时重试
- 3 broker处理回退请求
-
    - 3.1 asyncConsumerSendMsgBack处理回退请求
- 3.2 handleRetryAndDLQ处理重试和死信消息

## 1 并发消费重试

并发消费的重试与broker有关，需要借助重试队列。

### 1.1 失败重试

并发消费的消费结果通过ConsumeMessageConcurrentlyService#processConsumeResult方法处理。

对于消费失败的消息，广播模式下仅仅是对于消费失败的消息打印日志，并不会重试。集群模式下，则通过sendMessageBack方法处理消费失败的消息，将该消息重新发送至重试队列，延迟消费。
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162134290.png)

#### 1.1.1 ConsumeMessageConcurrentlyService#sendMessageBack发送消费失败的消息

ConsumeMessageConcurrentlyService的方法，并发消费失败，发送消费失败的消息到broker。
从ConsumeConcurrentlyContext获取delayLevelWhenNextConsume属性作为延迟等级，默认为0。通过在业务方法中修改该属性的只可以控制延迟等级：

**1、** -1，不重试，直接发往死信队列；
**2、** 0，默认值，延迟等级broker端控制，默认从延迟等级level3开始，后续每次重试都是3+当前重试次数；
**3、** 大于0，由client端控制，传入多少延迟等级就是多少；

注意，每次消费均产生一个新的ConsumeConcurrentlyContext对象，所以仅能设置单次发回消息的延迟等级。

```java
/**
 * ConsumeMessageConcurrentlyService的方法
 * <p>
 * 并发消费失败，发送消费失败的消息到broker
 *
 * @param msg     要发回的消息
 * @param context 并发消费上下文
 * @return 发送结果
 */
public boolean sendMessageBack(final MessageExt msg, final ConsumeConcurrentlyContext context) {
   
     
    /*
     * 从ConsumeConcurrentlyContext获取delayLevelWhenNextConsume属性作为延迟等级，默认为0。
     * 通过在业务方法中修改该属性的只可以控制延迟等级：
     * -1，不重试，直接发往死信队列。
     * 0，默认值，延迟等级broker端控制的，默认从延迟等级level3开始，后续每次重试都是3 + 当前重试次数。
     * 大于0，由client端控制，传入多少延迟等级就是多少。
     *
     * 注意，每次消费均产生一个新的ConsumeConcurrentlyContext对象，所以仅能设置单次发回消息的延迟等级
     */
    int delayLevel = context.getDelayLevelWhenNextConsume();

    //使用nameSpace包装topic
    msg.setTopic(this.defaultMQPushConsumer.withNamespace(msg.getTopic()));
    try {
   
     
        //调用DefaultMQPushConsumerImpl#sendMessageBack方法发送消费失败的消息到broker
        this.defaultMQPushConsumerImpl.sendMessageBack(msg, delayLevel, context.getMessageQueue().getBrokerName());
        //没有抛出异常就算成功
        return true;
    } catch (Exception e) {
   
     
        log.error("sendMessageBack exception, group: " + this.consumerGroup + " msg: " + msg.toString(), e);
    }

    return false;
}
```

#### 1.1.2 DefaultMQPushConsumerImpl#sendMessageBack发送消费失败的消息

DefaultMQPushConsumerImpl的方法，发送消费失败的消息到broker。内部调用调用MQClientAPIImpl#consumerSendMessageBack方法发送消费失败的消息到broker。

```java
/**
 * DefaultMQPushConsumerImpl的方法
 * <p>
 * 发送消费失败的消息到broker
 *
 * @param msg        要发回的消息
 * @param delayLevel 延迟等级
 * @param brokerName brokerName
 */
public void sendMessageBack(MessageExt msg, int delayLevel, final String brokerName)
        throws RemotingException, MQBrokerException, InterruptedException, MQClientException {
   
     
    try {
   
     
        //获取broker地址
        String brokerAddr = (null != brokerName) ? this.mQClientFactory.findBrokerAddressInPublish(brokerName)
                : RemotingHelper.parseSocketAddressAddr(msg.getStoreHost());
        //调用MQClientAPIImpl#consumerSendMessageBack方法发送消费失败的消息到broker
        //getMaxReconsumeTimes获取最大重试次数，通过DefaultMQPushConsumer.maxReconsumeTimes属性配置
        //默认-1，表示默认重试16次
        this.mQClientFactory.getMQClientAPIImpl().consumerSendMessageBack(brokerAddr, msg,
                this.defaultMQPushConsumer.getConsumerGroup(), delayLevel, 5000, getMaxReconsumeTimes());
    } catch (Exception e) {
   
     
        //该方法抛出异常
        log.error("sendMessageBack Exception, " + this.defaultMQPushConsumer.getConsumerGroup(), e);
        //构建一个新消息
        Message newMsg = new Message(MixAll.getRetryTopic(this.defaultMQPushConsumer.getConsumerGroup()), msg.getBody());

        String originMsgId = MessageAccessor.getOriginMessageId(msg);
        MessageAccessor.setOriginMessageId(newMsg, UtilAll.isBlank(originMsgId) ? msg.getMsgId() : originMsgId);

        newMsg.setFlag(msg.getFlag());
        MessageAccessor.setProperties(newMsg, msg.getProperties());
        MessageAccessor.putProperty(newMsg, MessageConst.PROPERTY_RETRY_TOPIC, msg.getTopic());
        MessageAccessor.setReconsumeTime(newMsg, String.valueOf(msg.getReconsumeTimes() + 1));
        MessageAccessor.setMaxReconsumeTimes(newMsg, String.valueOf(getMaxReconsumeTimes()));
        MessageAccessor.clearProperty(newMsg, MessageConst.PROPERTY_TRANSACTION_PREPARED);
        //设置延迟等级PROPERTY_DELAY_TIME_LEVEL属性，重试次数 + 3
        newMsg.setDelayTimeLevel(3 + msg.getReconsumeTimes());
        //尝试通过普通send方法发送延迟消息
        this.mQClientFactory.getDefaultMQProducer().send(newMsg);
    } finally {
   
     
        //解除nameSpace
        msg.setTopic(NamespaceUtil.withoutNamespace(msg.getTopic(), this.defaultMQPushConsumer.getNamespace()));
    }
}
```

##### 1.1.1.2.1 getMaxReconsumeTimes获取最大重试次数

getMaxReconsumeTimes获取最大重试次数，通过DefaultMQPushConsumer.maxReconsumeTimes属性配置。**默认-1，对于并发消费表示默认重试16次。
**

```java
/**
 * DefaultMQPushConsumerImpl的方法
 * <p>
 * 获取最大重试次数
 *
 * @return 最大重试次数
 */
private int getMaxReconsumeTimes() {
   
     
    // default reconsume times: 16
    //通过DefaultMQPushConsumer.maxReconsumeTimes属性配置。默认-1，对于并发消费表示默认重试16次。
    if (this.defaultMQPushConsumer.getMaxReconsumeTimes() == -1) {
   
     
        return 16;
    } else {
   
     
        return this.defaultMQPushConsumer.getMaxReconsumeTimes();
    }
}
```

#### 1.1.3 consumerSendMessageBack发送消费失败的消息

MQClientAPIImpl的方法，通过netty发起远程调用，请求Code为CONSUMER_SEND_MSG_BACK，发送消费失败的消息到broker。

```java
/**
 * MQClientAPIImpl的方法
 * <p>
 * 发送消费失败的消息到broker
 *
 * @param addr                 broker地址
 * @param msg                  要发回的消息
 * @param consumerGroup        消费者组
 * @param delayLevel           延迟等级
 * @param timeoutMillis        超时时间
 * @param maxConsumeRetryTimes 最大重试次数，超过发往死信队列
 */
public void consumerSendMessageBack(
        final String addr,
        final MessageExt msg,
        final String consumerGroup,
        final int delayLevel,
        final long timeoutMillis,
        final int maxConsumeRetryTimes
) throws RemotingException, MQBrokerException, InterruptedException {
   
     
    //构建请求头
    ConsumerSendMsgBackRequestHeader requestHeader = new ConsumerSendMsgBackRequestHeader();
    //Code为CONSUMER_SEND_MSG_BACK
    RemotingCommand request = RemotingCommand.createRequestCommand(RequestCode.CONSUMER_SEND_MSG_BACK, requestHeader);

    requestHeader.setGroup(consumerGroup);
    requestHeader.setOriginTopic(msg.getTopic());
    requestHeader.setOffset(msg.getCommitLogOffset());
    requestHeader.setDelayLevel(delayLevel);
    requestHeader.setOriginMsgId(msg.getMsgId());
    requestHeader.setMaxReconsumeTimes(maxConsumeRetryTimes);
    //同步调用
    RemotingCommand response = this.remotingClient.invokeSync(MixAll.brokerVIPChannel(this.clientConfig.isVipChannelEnabled(), addr),
            request, timeoutMillis);
    assert response != null;
    switch (response.getCode()) {
   
     
        case ResponseCode.SUCCESS: {
   
     
            return;
        }
        default:
            break;
    }

    throw new MQBrokerException(response.getCode(), response.getRemark(), addr);
}
```

### 1.2 超时重试

ConsumeMessageConcurrentlyService#start方法将会通过cleanExpireMsgExecutors定时任务清理过期的消息，启动后15min开始执行，后每15min执行一次，这里的15min是RocketMQ大的默认超时时间，可通过defaultMQPushConsumer#consumeTimeout属性设置。

**通过一个定时任务，每隔15min检测一次，当消息消费时间超过15min时，将该消息算作消费失败，并且将该消息通过sendMessageBack发回broker延迟topic，将在给定延迟时间之后发回进行重试消费或者发往死信队列。
**

该定时任务最终通过ProcessQueue#cleanExpiredMsg方法处理超时消息，其源码我们在并发消费部分已经讲过了。下面是关键截图：
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162134651.png)
**这个方法实际上是DefaultMQPushConsumer提供的一个公共方法，可以看到超时重试的每一次的重试延迟等级都是是固定level
3，即延迟10s。**

内部调用DefaultMQPushConsumerImpl#sendMessageBack方法，我们在上面已经讲过了。

```java
public void sendMessageBack(MessageExt msg, int delayLevel)
        throws RemotingException, MQBrokerException, InterruptedException, MQClientException {
   
     
    msg.setTopic(withNamespace(msg.getTopic()));
    //通过DefaultMQPushConsumerImpl#sendMessageBack发送消费失败的消息，指定延迟等级
    this.defaultMQPushConsumerImpl.sendMessageBack(msg, delayLevel, null);
}
```

## 2 顺序消费重试

顺序消费的重试与broker无关，直接在本地延迟1s之后重新消费当前没有消费成功的消息。

### 2.1 失败重试

broker消费失败的重试在ConsumeMessageOrderlyService# processConsumeResult方法中实现，具体的源码我们在顺序消费部分已经讲过了。
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162134047.png)
*
*当返回SUSPEND_CURRENT_QUEUE_A_MOMENT，表示消费失败，则调用checkReconsumeTimes方法校验是否达到最大重试次数，可以通过DefaultMQPushConsumer#maxReconsumeTimes属性配置，默认无上限，即Integer.MAX_VALUE。
**

checkReconsumeTimes方法将检查如果没有达到最大次数则返回true，否则将会调用sendMessageBack方法，将消息发回broker，但是不会再次被消费，而是直接被送往死信队列。

没有达到最大重试次数，那么会调用makeMessageToConsumeAgain方法标记消息等待再次消费，然后调用submitConsumeRequestLater方法延迟提交新的消费请求，默认suspendTimeMillis为-1，即延迟1s后重新消费。

**所谓标记，实际上很简单，就是将需要重复消费消息从正在消费的consumingMsgOrderlyTreeMap中移除，然后重新存入待消费的msgTreeMap中，那么将会在随后的消费中被拉取，进而实现重复消费。
**

*
*所以说，并发消费的重复消费，需要将消息发往broker的重试topic中，等待再次拉取并重新消费，而顺序消费的重复消费就更加简单了，直接在本地重试，不需要经过broker，直到达到了最大重试次数，才会通过sendMessageBack方法将消息发往broker，但是不会再被消费到了。
**

#### 2.1.1 sendMessageBack发送失败消息

**ConsumeMessageOrderlyService的sendMessageBack方法，将顺序消费重试次数达到最大值的消息构造为一个新的msg并且发往broker，topic为重试topic。
**

注意该方法实际上是调用同步发送消息的send方法，请求Code一般为SEND_REPLY_MESSAGE或者SEND_REPLY_MESSAGE_V2。

**在broker端接收到该请求之后，会在handleRetryAndDLQ方法中判断到如果已重试次数大于等于最大重试次数，那么替换为死信topic，消息最终还是会发往死信队列。
**

```java
/**
 * ConsumeMessageOrderlyService的方法
 * 顺序消费，将重试次数达到最大值的消息发往broker死信队列
 *
 * @param msg 发送的消息
 * @return 是否发送成功
 */
public boolean sendMessageBack(final MessageExt msg) {
   
     
    try {
   
     
        // max reconsume times exceeded then send to dead letter queue.
        //新构造一个msg
        Message newMsg = new Message(MixAll.getRetryTopic(this.defaultMQPushConsumer.getConsumerGroup()), msg.getBody());
        String originMsgId = MessageAccessor.getOriginMessageId(msg);
        MessageAccessor.setOriginMessageId(newMsg, UtilAll.isBlank(originMsgId) ? msg.getMsgId() : originMsgId);
        newMsg.setFlag(msg.getFlag());
        MessageAccessor.setProperties(newMsg, msg.getProperties());
        MessageAccessor.putProperty(newMsg, MessageConst.PROPERTY_RETRY_TOPIC, msg.getTopic());
        //设置重试次数
        MessageAccessor.setReconsumeTime(newMsg, String.valueOf(msg.getReconsumeTimes()));
        //设置最大重试次数，默认
        MessageAccessor.setMaxReconsumeTimes(newMsg, String.valueOf(getMaxReconsumeTimes()));
        MessageAccessor.clearProperty(newMsg, MessageConst.PROPERTY_TRANSACTION_PREPARED);
        //设置延迟等级PROPERTY_DELAY_TIME_LEVEL属性， 3 + 重试次数
        newMsg.setDelayTimeLevel(3 + msg.getReconsumeTimes());
        //调用DefaultMQProducer#send方法发送消息
        this.defaultMQPushConsumer.getDefaultMQPushConsumerImpl().getmQClientFactory().getDefaultMQProducer().send(newMsg);
        return true;
    } catch (Exception e) {
   
     
        log.error("sendMessageBack exception, group: " + this.consumerGroup + " msg: " + msg.toString(), e);
    }

    return false;
}
```

### 2.2 超时重试

**对于顺序消费，实际上无论超时多久，无论在你的业务逻辑中卡多久，都不会单纯的因为15min的消费超时而重试。这也是为了保证顺序性的妥协，无论执行多久，你的程序终会返回最终结果，只需要根据返回的状态执行对应的逻辑即可。
**

## 3 broker处理回退请求

**并发消费失败重试，以及顺序消费达到最大重试次数之后，都会向broekr发送消息发回请求，在broker端会进行判断，是继续延迟消费还是发往死信队列。
**

*
*并发消费重试请求Code为CONSUMER_SEND_MSG_BACK，而顺序消费大道最大重试次数后发回broker的请求则是走的普通发送消息的请求。实际上，这两种请求，都算作是发送消息请求，在broker都通过SendMessageProcessor处理。
**
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162134609.png)
因此，这两个请求的broker处理的统一入口都是SendMessageProcessor#asyncProcessRequest方法，我们来看看该方法源码。

```java
/**
 * SendMessageProcessor的方法
 * <p>
 * 异步的处理请求
 */
public CompletableFuture<RemotingCommand> asyncProcessRequest(ChannelHandlerContext ctx,
                                                              RemotingCommand request) throws RemotingCommandException {
   
     
    final SendMessageContext mqtraceContext;
    /*
     * 根据不同的请求code选择不同的处理方式
     */
    switch (request.getCode()) {
   
     
        //如果是消费者发送的消息回退请求，该请求用于实现消息重试
        //如果消息消费失败，那么消息将被通过回退请求发送回broker，并延迟一段时间再消费
        case RequestCode.CONSUMER_SEND_MSG_BACK:
            return this.asyncConsumerSendMsgBack(ctx, request);
        //其他情况，都是属于生产者发送消息的请求，统一处理
        default:
            //解析请求头
            SendMessageRequestHeader requestHeader = parseRequestHeader(request);
            if (requestHeader == null) {
   
     
                //如果请求头为null，那么返回一个null值结果
                return CompletableFuture.completedFuture(null);
            }
            //构建发送请求消息轨迹上下文
            mqtraceContext = buildMsgContext(ctx, requestHeader);
            //执行发送消息前钩子方法
            this.executeSendMessageHookBefore(ctx, request, mqtraceContext);
            if (requestHeader.isBatch()) {
   
     
                //处理批量发送消息逻辑
                return this.asyncSendBatchMessage(ctx, request, mqtraceContext, requestHeader);
            } else {
   
     
                //处理其他发送消息逻辑，例如单条消息
                return this.asyncSendMessage(ctx, request, mqtraceContext, requestHeader);
            }
    }
}
```

可以看到，仅仅是对于CONSUMER_SEND_MSG_BACK请求有特殊处理，将会调用asyncConsumerSendMsgBack方法处理，这是我们主要关注的方法。

而其他请求则走通用处理逻辑，单个消息处理方法asyncSendMessage的逻辑源码我们在此前broker接收消息的部分已经讲过了，稍后着重讲一下里面的
**handleRetryAndDLQ**方法。

### 3.1 asyncConsumerSendMsgBack处理回退请求

SendMessageProcessor#asyncConsumerSendMsgBack方法用于处理消息回退请求。大概步骤为：

**1、** 前置校验查找broker缓存的当前消费者组的订阅组配置SubscriptionGroupConfig，不存在订阅关系就直接返回，如果broker不支持写，那么直接返回如果重试队列数量小于等于0，则直接返回，一般都是1；
**2、** 根据consumerGroup获取对应的重试topic，这里仅仅是获取topic的名字%RETRY%+consumerGroup随机选择一个重试队列id，一般都是0，因为重试队列数一般都是1；
**3、**
调用createTopicInSendMessageBackMethod方法，尝试获取或者创建重试topic，其源码和创建普通topic差不多，区别就是重试topic不需要模板topic，默认读写队列数都是1，权限为读写，该方法的源码我们在broker接收消息的源码部分就已经解析了如果创建重试topic失败，直接返回重试topic没有写的权限，直接返回；
**4、** 调用lookMessageByOffset方法，根据消息物理偏移量从commitLog中找到该条消息将属性RETRY_TOPIC的设置到消息属性中，该属性值为正常的topic；
**5、** 从请求头中获取延迟等级从订阅关系中获取最大重试次数，如果版本大于3.4.9，那么从请求头中获取最大重试次数，这是客户端传递过来的并发消费模式默认最大16，顺序消费默认最大Integer.MAX_VALUE；
**6、** 如果消息已重试次数大于等于最大重试次数，或者延迟等级小于0，那么消息不再重试，消息将会直接发往死信队列；

**1、** 获取该consumerGroup对应的死信队列topic，这里仅仅是获取topic的名字%DLQ%+consumerGroup随机选择一个重试队列id，固定是0，因为死信队列数是1；
**2、** 尝试获取或者创建死信topic，实际上调用的调用获取重试topic的createTopicInSendMessageBackMethod方法，默认读写队列数都是1，权限为读写；
**3、** 设置消息延迟等级0，表示不会延迟，不进入延迟topic，直接发往死信队列；
**7、** 如果没有达到最大重试次数，并且延迟等级不小于0，那么将会重试，因此设置延迟等级；

**1、**
如果参数中的delayLevel=0，表示broker控制延迟等级，那么delayLevel=3+已重试的次数，即默认从level3开始，即从延迟10s开始如果参数中的delayLevel>
0，表示consumer控制延迟等级，那么参数是多少，等级就设置为多少；
**8、** 创建内部消息对象MessageExtBrokerInner，设置相关属性注意这里，设置的topic为重试topic或者死信topic设置消费次数+1；
**9、** 调用asyncPutMessage方法，以异步方式处理、存储消息，将消息存储到commitLog中该方法的源码我们在broker接收消息部分已经讲解过了；

**1、**
如果是延迟消息，即DelayTimeLevel大于0，那么替换topic为SCHEDULE_TOPIC_XXXX，替换queueId为延迟队列id，id=level-1，如果延迟级别大于最大级别，则设置为最大级别18，，默认延迟2h这些参数可以在broker端配置类MessageStoreConfig中配置；
**2、** 最后保存真实topic到消息的REAL_TOPIC属性，保存queueId到消息的REAL_QID属性，方便后面恢复注意这里，如果保存的topic可能是重试topic，而真正的topic保存在RETRY_TOPIC属性中；
**3、** broker后台定时任务服务ScheduleMessageService按照对应的延迟时间进行Delay后重新保存至“%RETRY%+consumerGroup”的重试队列中，然后即可被消费者重新消费；

```java
/**
 * SendMessageProcessor的方法
 * <p>
 * 处理CONSUMER_SEND_MSG_BACK发回请求
 */
private CompletableFuture<RemotingCommand> asyncConsumerSendMsgBack(ChannelHandlerContext ctx,
                                                                    RemotingCommand request) throws RemotingCommandException {
   
     
    final RemotingCommand response = RemotingCommand.createResponseCommand(null);
    //解析请求头
    final ConsumerSendMsgBackRequestHeader requestHeader =
            (ConsumerSendMsgBackRequestHeader) request.decodeCommandCustomHeader(ConsumerSendMsgBackRequestHeader.class);
    String namespace = NamespaceUtil.getNamespaceFromResource(requestHeader.getGroup());
    //执行前置钩子
    if (this.hasConsumeMessageHook() && !UtilAll.isBlank(requestHeader.getOriginMsgId())) {
   
     
        ConsumeMessageContext context = buildConsumeMessageContext(namespace, requestHeader, request);
        this.executeConsumeMessageHookAfter(context);
    }
    /*
     * 1 前置校验
     */
    //查找broker缓存的当前消费者组的订阅组配置
    SubscriptionGroupConfig subscriptionGroupConfig =
            this.brokerController.getSubscriptionGroupManager().findSubscriptionGroupConfig(requestHeader.getGroup());
    //不存在订阅关系就直接返回
    if (null == subscriptionGroupConfig) {
   
     
        response.setCode(ResponseCode.SUBSCRIPTION_GROUP_NOT_EXIST);
        response.setRemark("subscription group not exist, " + requestHeader.getGroup() + " "
                + FAQUrl.suggestTodo(FAQUrl.SUBSCRIPTION_GROUP_NOT_EXIST));
        return CompletableFuture.completedFuture(response);
    }
    //如果broker不支持写，那么直接返回
    if (!PermName.isWriteable(this.brokerController.getBrokerConfig().getBrokerPermission())) {
   
     
        response.setCode(ResponseCode.NO_PERMISSION);
        response.setRemark("the broker[" + this.brokerController.getBrokerConfig().getBrokerIP1() + "] sending message is forbidden");
        return CompletableFuture.completedFuture(response);
    }
    //如果重试队列数量小于等于0，则直接返回，一般都是1
    if (subscriptionGroupConfig.getRetryQueueNums() <= 0) {
   
     
        response.setCode(ResponseCode.SUCCESS);
        response.setRemark(null);
        return CompletableFuture.completedFuture(response);
    }
    /*
     * 2 根据consumerGroup获取对应的重试topic，这里仅仅是获取topic的名字
     *
     * RocketMQ会为每个消费组都设置一个Topic名称为“%RETRY%+consumerGroup”的重试队列
     * 这里需要注意的是，这里的重试队列是针对消费组，而不是针对每个Topic设置的
     * 每个Consumer实例在启动的时候就默认订阅了该消费组的重试队列Topic，但是只有在真正需要到重试topic的时候的才会创建
     */
    String newTopic = MixAll.getRetryTopic(requestHeader.getGroup());
    //随机选择一个重试队列id，一般都是0，因为重试队列数一般都是1
    int queueIdInt = ThreadLocalRandom.current().nextInt(99999999) % subscriptionGroupConfig.getRetryQueueNums();
    int topicSysFlag = 0;
    if (requestHeader.isUnitMode()) {
   
     
        topicSysFlag = TopicSysFlag.buildSysFlag(false, true);
    }
    /*
     * 3 尝试获取或者创建重试topic，其源码和创建普通topic差不多，区别就是重试topic不需要模板topic，默认读写队列数都是1，权限为读写
     * 该方法的源码我们在broker接收消息的源码部分就已经解析了
     */
    TopicConfig topicConfig = this.brokerController.getTopicConfigManager().createTopicInSendMessageBackMethod(
            newTopic,
            subscriptionGroupConfig.getRetryQueueNums(),
            PermName.PERM_WRITE | PermName.PERM_READ, topicSysFlag);
    //创建重试topic失败直接返回
    if (null == topicConfig) {
   
     
        response.setCode(ResponseCode.SYSTEM_ERROR);
        response.setRemark("topic[" + newTopic + "] not exist");
        return CompletableFuture.completedFuture(response);
    }
    //重试topic没有写的权限，直接返回
    if (!PermName.isWriteable(topicConfig.getPerm())) {
   
     
        response.setCode(ResponseCode.NO_PERMISSION);
        response.setRemark(String.format("the topic[%s] sending message is forbidden", newTopic));
        return CompletableFuture.completedFuture(response);
    }
    /*
     * 4 根据消息物理偏移量从commitLog中找到该条消息
     */
    MessageExt msgExt = this.brokerController.getMessageStore().lookMessageByOffset(requestHeader.getOffset());
    //没找到消息，直接返回
    if (null == msgExt) {
   
     
        response.setCode(ResponseCode.SYSTEM_ERROR);
        response.setRemark("look message by offset failed, " + requestHeader.getOffset());
        return CompletableFuture.completedFuture(response);
    }
    //从消息中获取重试topic属性RETRY_TOPIC
    final String retryTopic = msgExt.getProperty(MessageConst.PROPERTY_RETRY_TOPIC);
    //如果原消息没有该属性，则设置该属性值为正常的topic，表示第一次进行重试
    if (null == retryTopic) {
   
     
        MessageAccessor.putProperty(msgExt, MessageConst.PROPERTY_RETRY_TOPIC, msgExt.getTopic());
    }
    //配置是否需要等待存储完成后才返回，这里是否，即异步刷盘
    msgExt.setWaitStoreMsgOK(false);
    /*
     * 5 从请求头中获取延迟等级
     */
    int delayLevel = requestHeader.getDelayLevel();
    /*
     * 6 从订阅关系中获取最大重试次数
     * 如果版本大于3.4.9，那么从请求头中获取最大重试次数，这是客户端传递过来的
     * 并发消费模式最大16，顺序消费默认最大Integer.MAX_VALUE
     */
    int maxReconsumeTimes = subscriptionGroupConfig.getRetryMaxTimes();
    //如果版本大于3.4.9，那么从请求头中获取最大重试次数，这是客户端传递过来的
    //并发消费模式最大16，顺序消费默认最大Integer.MAX_VALUE
    if (request.getVersion() >= MQVersion.Version.V3_4_9.ordinal()) {
   
     
        Integer times = requestHeader.getMaxReconsumeTimes();
        if (times != null) {
   
     
            maxReconsumeTimes = times;
        }
    }
    /*
     * 7 如果消息已重试次数 大于等于 最大重试次数，或者延迟等级小于0，那么消息不再重试，直接发往死信队列
     */
    if (msgExt.getReconsumeTimes() >= maxReconsumeTimes
            || delayLevel < 0) {
   
     
        /*
         * 7.1 获取该consumerGroup对应的死信队列topic
         * RocketMQ会为每个消费组都设置一个Topic名称为%DLQ%+consumerGroup的死信队列topic
         * 这里需要注意的是，和重试队列一样，这里的死信队列是针对消费组，而不是针对每个Topic设置的。
         */
        newTopic = MixAll.getDLQTopic(requestHeader.getGroup());
        //随机选择一个死信队列id，这里是0，因为死信队列数DLQ_NUMS_PER_GROUP是1
        queueIdInt = ThreadLocalRandom.current().nextInt(99999999) % DLQ_NUMS_PER_GROUP;
        /*
         * 7.2 尝试获取或者创建死信topic，实际上调用的调用重试topic的方法，默认读写队列数都是1，权限为读写
         * 该方法的源码我们在broker接收消息的源码部分就已经解析了
         */
        topicConfig = this.brokerController.getTopicConfigManager().createTopicInSendMessageBackMethod(newTopic,
                DLQ_NUMS_PER_GROUP,
                PermName.PERM_WRITE | PermName.PERM_READ, 0);
        //创建死信topic失败直接返回
        if (null == topicConfig) {
   
     
            response.setCode(ResponseCode.SYSTEM_ERROR);
            response.setRemark("topic[" + newTopic + "] not exist");
            return CompletableFuture.completedFuture(response);
        }
        //设置消息延迟等级0，表示不会延迟，不进入延迟topic
        msgExt.setDelayTimeLevel(0);
    }
    //没有达到最大重试次数，并且延迟等级不小于0
    else {
   
     
        //如果参数中的delayLevel = 0，表示broker控制延迟等级
        if (0 == delayLevel) {
   
     
            // 3 + 已重试的次数 ，即默认从level3开始，即从延迟10s开始
            delayLevel = 3 + msgExt.getReconsumeTimes();
        }
        //如果参数中的delayLevel > 0，表示consumer控制延迟等级
        //那么参数是多少，等级就设置为多少
        msgExt.setDelayTimeLevel(delayLevel);
    }
    /*
     * 8 创建内部消息对象MessageExtBrokerInner，设置相关属性
     */
    MessageExtBrokerInner msgInner = new MessageExtBrokerInner();
    /*
     *  注意这里，设置的topic为重试topic或者死信topic
     */
    msgInner.setTopic(newTopic);
    msgInner.setBody(msgExt.getBody());
    msgInner.setFlag(msgExt.getFlag());
    MessageAccessor.setProperties(msgInner, msgExt.getProperties());
    msgInner.setPropertiesString(MessageDecoder.messageProperties2String(msgExt.getProperties()));
    msgInner.setTagsCode(MessageExtBrokerInner.tagsString2tagsCode(null, msgExt.getTags()));
    //设置队列id
    msgInner.setQueueId(queueIdInt);
    msgInner.setSysFlag(msgExt.getSysFlag());
    msgInner.setBornTimestamp(msgExt.getBornTimestamp());
    msgInner.setBornHost(msgExt.getBornHost());
    msgInner.setStoreHost(msgExt.getStoreHost());
    //设置 消费次数 + 1
    msgInner.setReconsumeTimes(msgExt.getReconsumeTimes() + 1);
    //原始消息id
    String originMsgId = MessageAccessor.getOriginMessageId(msgExt);
    //设置到PROPERTY_ORIGIN_MESSAGE_ID属性里面
    MessageAccessor.setOriginMessageId(msgInner, UtilAll.isBlank(originMsgId) ? msgExt.getMsgId() : originMsgId);
    msgInner.setPropertiesString(MessageDecoder.messageProperties2String(msgExt.getProperties()));
    /*
     * 9 异步方式将消息存储到commitLog中
     *
     * 在该方法中，将会处理延迟消息的逻辑。如果是延迟消息，即DelayTimeLevel大于0
     * 那么替换topic为SCHEDULE_TOPIC_XXXX，替换queueId为延迟队列id， id = level - 1，保存真实topic和queueId，方便后面恢复。
     */
    CompletableFuture<PutMessageResult> putMessageResult = this.brokerController.getMessageStore().asyncPutMessage(msgInner);
    //结果处理
    return putMessageResult.thenApply((r) -> {
   
     
        if (r != null) {
   
     
            switch (r.getPutMessageStatus()) {
   
     
                case PUT_OK:
                    //重试topic或者死信topic
                    String backTopic = msgExt.getTopic();
                    //真实topic
                    String correctTopic = msgExt.getProperty(MessageConst.PROPERTY_RETRY_TOPIC);
                    if (correctTopic != null) {
   
     
                        backTopic = correctTopic;
                    }
                    //如果topic是RMQ_SYS_SCHEDULE_TOPIC，即延迟队列的topic，固定为 SCHEDULE_TOPIC_XXXX
                    if (TopicValidator.RMQ_SYS_SCHEDULE_TOPIC.equals(msgInner.getTopic())) {
   
     
                        //增加记录
                        this.brokerController.getBrokerStatsManager().incTopicPutNums(msgInner.getTopic());
                        this.brokerController.getBrokerStatsManager().incTopicPutSize(msgInner.getTopic(), r.getAppendMessageResult().getWroteBytes());
                        this.brokerController.getBrokerStatsManager().incQueuePutNums(msgInner.getTopic(), msgInner.getQueueId());
                        this.brokerController.getBrokerStatsManager().incQueuePutSize(msgInner.getTopic(), msgInner.getQueueId(), r.getAppendMessageResult().getWroteBytes());
                    }
                    this.brokerController.getBrokerStatsManager().incSendBackNums(requestHeader.getGroup(), backTopic);
                    response.setCode(ResponseCode.SUCCESS);
                    response.setRemark(null);
                    return response;
                default:
                    break;
            }
            //异常情况
            response.setCode(ResponseCode.SYSTEM_ERROR);
            response.setRemark(r.getPutMessageStatus().name());
            return response;
        }
        response.setCode(ResponseCode.SYSTEM_ERROR);
        response.setRemark("putMessageResult is null");
        return response;
    });
}
```

### 3.2 handleRetryAndDLQ处理重试和死信消息

顺序消息超过最大重试次数之后，该消息同样会发回broker，只不过此时走的普通消息的发送逻辑，单个消息处理方法SendMessageProcessor#asyncSendMessage的逻辑源码我们在此前broker接收消息的部分已经讲过了，现在我们看一下里面的
**handleRetryAndDLQ**方法。

**handleRetryAndDLQ方法将会对重试消息进行检查，当已重试次数大于等于最大重试次数，那么消息将会发往死信队列，这里会将topic替换为死信队列的topic。
**

*
*SendMessageProcessor#asyncSendMessage方法最终还是会调用asyncPutMessage，以异步方式处理、存储消息。该方法的源码我们在broker接收消息部分已经讲解过了。这样普通请求就和消息回退请求最终都走到同一个方法中去了。
**

```java
/**
 * SendMessageProcessor的方法
 * <p>
 * 处理重试和死信队列消息
 *
 * @param requestHeader 请求头
 * @param response      响应命令对象
 * @param request       请求命令对象
 * @param msg           消息
 * @param topicConfig   topic配置
 * @return 是否是重试和死信队列消息
 */
private boolean handleRetryAndDLQ(SendMessageRequestHeader requestHeader, RemotingCommand response,
                                  RemotingCommand request,
                                  MessageExt msg, TopicConfig topicConfig) {
   
     
    //获取topic
    String newTopic = requestHeader.getTopic();
    //如果是重试topic，顺序消费重试超过最大次数时发送的消息的topic就是重试topic
    if (null != newTopic && newTopic.startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX)) {
   
     
        String groupName = newTopic.substring(MixAll.RETRY_GROUP_TOPIC_PREFIX.length());
        //查找broker缓存的当前消费者组的订阅组配置
        SubscriptionGroupConfig subscriptionGroupConfig =
                this.brokerController.getSubscriptionGroupManager().findSubscriptionGroupConfig(groupName);
        if (null == subscriptionGroupConfig) {
   
     
            response.setCode(ResponseCode.SUBSCRIPTION_GROUP_NOT_EXIST);
            response.setRemark(
                    "subscription group not exist, " + groupName + " " + FAQUrl.suggestTodo(FAQUrl.SUBSCRIPTION_GROUP_NOT_EXIST));
            return false;
        }
        /*
         * 从订阅关系中获取最大重试次数
         * 如果版本大于3.4.9，那么从请求头中获取最大重试次数，这是客户端传递过来的
         * 并发消费模式最大16，顺序消费默认最大Integer.MAX_VALUE
         */
        int maxReconsumeTimes = subscriptionGroupConfig.getRetryMaxTimes();
        if (request.getVersion() >= MQVersion.Version.V3_4_9.ordinal() && requestHeader.getMaxReconsumeTimes() != null) {
   
     
            maxReconsumeTimes = requestHeader.getMaxReconsumeTimes();
        }
        //从请求头中获取已重试次数
        int reconsumeTimes = requestHeader.getReconsumeTimes() == null ? 0 : requestHeader.getReconsumeTimes();
        //如果已重试次数大于等于最大重试次数，那么消息将会发往死信队列
        if (reconsumeTimes >= maxReconsumeTimes) {
   
     
            /*
             * 获取该consumerGroup对应的死信队列topic，名称为%DLQ%+consumerGroup
             */
            newTopic = MixAll.getDLQTopic(groupName);
            //随机选择一个死信队列id，这里是0，因为死信队列数DLQ_NUMS_PER_GROUP是1
            int queueIdInt = ThreadLocalRandom.current().nextInt(99999999) % DLQ_NUMS_PER_GROUP;
            /*
             * 尝试获取或者创建死信topic
             */
            topicConfig = this.brokerController.getTopicConfigManager().createTopicInSendMessageBackMethod(newTopic,
                    DLQ_NUMS_PER_GROUP,
                    PermName.PERM_WRITE | PermName.PERM_READ, 0
            );
            //设置topic为死信队列topic
            msg.setTopic(newTopic);
            //设置队列id
            msg.setQueueId(queueIdInt);
            //设置消息延迟等级0，表示不会延迟，不进入延迟topic
            msg.setDelayTimeLevel(0);
            if (null == topicConfig) {
   
     
                response.setCode(ResponseCode.SYSTEM_ERROR);
                response.setRemark("topic[" + newTopic + "] not exist");
                return false;
            }
        }
    }
    //系统标志
    int sysFlag = requestHeader.getSysFlag();
    if (TopicFilterType.MULTI_TAG == topicConfig.getTopicFilterType()) {
   
     
        sysFlag |= MessageSysFlag.MULTI_TAGS_FLAG;
    }
    msg.setSysFlag(sysFlag);
    return true;
}
```