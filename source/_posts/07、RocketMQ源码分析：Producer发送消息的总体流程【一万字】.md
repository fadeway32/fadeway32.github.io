---

layout: 07、RocketMQ源码分析：Producer发送消息的总体流程【一万字】

title:  07、RocketMQ源码分析：Producer发送消息的总体流程【一万字】

tags: RocketMq

categories: Web

top: 56

path: /article/1739713332

abbrlink: 1739713332

date: 2025-02-16 21:42:06


--- 

# 07、RocketMQ源码分析：Producer发送消息的总体流程【一万字】

- 1 send源码入口
-
    - 1.1 同步消息
- 1.2 单向消息
- 1.3 异步消息
- 2 sendDefaultImpl发送消息实现
-
    - 2.1 makeSureStateOK确定生产者服务状态
- 2.2 checkMessage校验消息的合法性
- 2.3 tryToFindTopicPublishInfo查找topic的发布信息
- 2.4 计算发送次数timesTotal
- 2.5 selectOneMessageQueue选择消息队列
-
    - 2.5.1 selectOneMessageQueue选择一个mq
- 2.6 sendKernelImpl发送消息
-
    - 2.6.1 findBrokerAddressInPublish查找broker地址
    - 2.6.2 brokerVIPChannel判断vip通道
    - 2.6.3 setUniqID生成uniqId
    - 2.6.4 tryToCompressMessage压缩消息
- 2.7 updateFaultItem更新故障表
-
    - 2.7.1 computeNotAvailableDuration计算隔离时间
    - 2.7.2 updateFaultItem更新故障表
- 3 总结

下面是一个最简单的producer的使用案例：

```java
public class Producer {
   
     
    public static void main(String[] args) throws MQClientException, InterruptedException {
   
     

        /*
         * Instantiate with a producer group name.
         */
        DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");
        producer.setNamesrvAddr("127.0.0.1:9876");
        /*
         * Launch the instance.
         */
        producer.start();

        try {
   
     

            /*
             * Create a message instance, specifying topic, tag and message body.
             */
            Message msg = new Message("Topic1" /* Topic */,
                    "TagA" /* Tag */,
                    ("Hello RocketMQ ").getBytes(RemotingHelper.DEFAULT_CHARSET) /* Message body */
            );

            /*
             * Call send message to deliver message to one of brokers.
             */
            SendResult sendResult = producer.send(msg);

            System.out.printf("%s%n", sendResult);
        } catch (Exception e) {
   
     
            e.printStackTrace();
            Thread.sleep(1000);
        }

        //producer.shutdown();
    }
}
```

可以看到producer通过调用send方法发送消息，实际上RocketMQ的producer发送消息的模式可以分为三种：

**1、** **单向发送**：把消息发向Broker服务器，而不用管消息是否成功发送到Broker服务器，只管发送，不管结果；
**2、** **同步发送**：把消息发送给Broker服务器，如果消息成功发送给Broker服务器，能得到Broker服务器的响应结果；
**3、** **异步发送**：把消息发送给Broker服务器，如果消息成功发送给Broker服务器，能得到Broker服务器的响应结果因为是异步发送，发送完消息以后，不用等待，等到Broker服务器的响应调用回调；

DefaultMQProducer提供了更多的send的重载方法，来实现上面三种发送模式：

| 模式  | 方法                                                                                                         | 描述                             |
|:----|:-----------------------------------------------------------------------------------------------------------|:-------------------------------|
| 同步  | SendResult send(Collection msgs)                                                                           | 同步批量发送消息                       |
|     | SendResult send(Collection msgs, long timeout)                                                             | 同步批量发送消息                       |
|     | SendResult send(Collection msgs, MessageQueue messageQueue)                                                | 向指定的消息队列同步批量发送消息               |
|     | SendResult send(Collection msgs, MessageQueue messageQueue, long timeout)                                  | 向指定的消息队列同步批量发送消息，并指定超时时间       |
|     | SendResult send(Message msg)                                                                               | 同步单条发送消息                       |
|     | SendResult send(Message msg, long timeout)                                                                 | 同步发送单条消息，并指定超时时间               |
|     | SendResult send(Message msg, MessageQueue mq)                                                              | 向指定的消息队列同步发送单条消息               |
|     | SendResult send(Message msg, MessageQueue mq, long timeout)                                                | 向指定的消息队列同步单条发送消息，并指定超时时间       |
|     | SendResult send(Message msg, MessageQueueSelector selector, Object arg)                                    | 向消息队列同步单条发送消息，并指定发送队列选择器       |
|     | SendResult send(Message msg, MessageQueueSelector selector, Object arg, long timeout)                      | 向消息队列同步单条发送消息，并指定发送队列选择器与超时时间  |
| 异步  | void send(Message msg, MessageQueueSelector selector, Object arg, SendCallback sendCallback)               | 向指定的消息队列异步单条发送消息               |
|     | void send(Message msg, MessageQueueSelector selector, Object arg, SendCallback sendCallback, long timeout) | 向指定的消息队列异步单条发送消息，并指定超时时间       |
|     | void send(Message msg, SendCallback sendCallback)                                                          | 异步发送消息                         |
|     | void send(Message msg, SendCallback sendCallback, long timeout)                                            | 异步发送消息，并指定回调方法和超时时间            |
|     | void send(Message msg, MessageQueue mq, SendCallback sendCallback)                                         | 向指定的消息队列异步单条发送消息，并指定回调方法       |
|     | void send(Message msg, MessageQueue mq, SendCallback sendCallback, long timeout)                           | 向指定的消息队列异步单条发送消息，并指定回调方法和超时时间  |
| 单向  | void sendOneway(Message msg)                                                                               | 单向发送消息，不等待broker响应             |
|     | void sendOneway(Message msg, MessageQueue mq)                                                              | 单向发送消息到指定队列，不等待broker响应        |
|     | void sendOneway(Message msg, MessageQueueSelector selector, Object arg)                                    | 单向发送消息到队列选择器的选中的队列，不等待broker响应 |

上次我们分析了producer的启动流程源码，这次我们分析producer发送消息的源码。

## 1 send源码入口

DefaultMQProducer#send方法作为源码分析的入口方法，该方法被使用者直接调用。其内部调用defaultMQProducerImpl#send方法发送消息。

### 1.1 同步消息

```java
public SendResult send(
        Message msg) throws MQClientException, RemotingException, MQBrokerException, InterruptedException {
   
     
    //根据namespace设置topic
    msg.setTopic(withNamespace(msg.getTopic()));
    //调用defaultMQProducerImpl#send发送消息
    return this.defaultMQProducerImpl.send(msg);
}
```

该方法内部调用defaultMQProducerImpl#send发送消息。

```java
public SendResult send(
        Message msg) throws MQClientException, RemotingException, MQBrokerException, InterruptedException {
   
     
    //调用另一个send方法，设置超时时间参数，默认3000ms
    return send(msg, this.defaultMQProducer.getSendMsgTimeout());
}
```

该方法内部又调用另一个send方法，设置超时时间参数，默认3000ms。

```java
/**
 * DefaultMQProducerImpl的方法
 *
 * @param msg     消息
 * @param timeout 超时时间，毫秒值
 */
public SendResult send(Message msg,
                       long timeout) throws MQClientException, RemotingException, MQBrokerException, InterruptedException {
   
     
    //调用另一个sendDefaultImpl方法，设置消息发送模式为SYNC，即同步；设置回调函数为null
    return this.sendDefaultImpl(msg, CommunicationMode.SYNC, null, timeout);
}
```

该方法内部又调用另一个sendDefaultImpl方法，设置消息发送模式为SYNC，即同步；设置回调函数为null。

### 1.2 单向消息

单向消息使用sendOneway发送。

```java
public void sendOneway(Message msg) throws MQClientException, RemotingException, InterruptedException
 {
   
     
    //根据namespace设置topic
    msg.setTopic(withNamespace(msg.getTopic()));
    //调用defaultMQProducerImpl#sendOneway发送消息
    this.defaultMQProducerImpl.sendOneway(msg);
}
```

该方法内部调用defaultMQProducerImpl#sendOneway。

```java
public void sendOneway(Message msg) throws MQClientException, RemotingException, InterruptedException {
   
     
    try {
   
     
        //调用sendDefaultImpl方法，设置消息发送模式为ONEWAY，即单向；设置回调函数为null；设置超时时间参数，默认3000ms
        this.sendDefaultImpl(msg, CommunicationMode.ONEWAY, null, this.defaultMQProducer.getSendMsgTimeout());
    } catch (MQBrokerException e) {
   
     
        throw new MQClientException("unknown exception", e);
    }
}
```

最终调用sendDefaultImpl方法，设置消息发送模式为ONEWAY，即单向；设置回调函数为null；设置超时时间参数，默认3000ms。

### 1.3 异步消息

异步消息使用带有callback函数的send方法发送。

```java
public void send(Message msg,                 SendCallback sendCallback) throws MQClientException,
 RemotingException, InterruptedException {
   
     
    //根据namespace设置topic
    msg.setTopic(withNamespace(msg.getTopic()));
    //调用defaultMQProducerImpl#send发送消息，带有sendCallback参数
    this.defaultMQProducerImpl.send(msg, sendCallback);
}
```

该方法内部调用defaultMQProducerImpl#send方法发送消息，带有sendCallback参数。

```java
public void send(Message msg,                 SendCallback sendCallback) throws MQClientException, 
RemotingException, InterruptedException {
   
     
    //该方法内部又调用另一个send方法，设置超时时间参数，默认3000ms。
    send(msg, sendCallback, this.defaultMQProducer.getSendMsgTimeout());
}
```

该方法内部又调用另一个send方法，设置超时时间参数，默认3000ms。

```java
public void send(final Message msg, final SendCallback sendCallback, final long timeout)
        throws MQClientException, RemotingException, InterruptedException {
   
     
    //调用起始时间
    final long beginStartTime = System.currentTimeMillis();
    //获取异步发送执行器线程池
    ExecutorService executor = this.getAsyncSenderExecutor();
    try {
   
     
        /*
         * 使用线程池异步的执行sendDefaultImpl方法，即异步发送消息
         */
        executor.submit(new Runnable() {
   
     
            @Override
            public void run() {
   
     
                /*
                 * 发送之前计算超时时间，如果超时则不发送，直接执行回调函数onException方法
                 */
                long costTime = System.currentTimeMillis() - beginStartTime;
                if (timeout > costTime) {
   
     
                    try {
   
     
                        //调用sendDefaultImpl方法执行发送操作
                        sendDefaultImpl(msg, CommunicationMode.ASYNC, sendCallback, timeout - costTime);
                    } catch (Exception e) {
   
     
                        //抛出异常，执行回调函数onException方法
                        sendCallback.onException(e);
                    }
                } else {
   
     
                    //超时，执行回调函数onException方法
                    sendCallback.onException(
                            new RemotingTooMuchRequestException("DEFAULT ASYNC send call timeout"));
                }
            }

        });
    } catch (RejectedExecutionException e) {
   
     
        throw new MQClientException("executor rejected ", e);
    }

}
```

该方法内部会获取获取异步发送执行器线程池，使用线程池异步的执行sendDefaultImpl方法，即异步发送消息。

发送之前计算超时时间，如果超时则不发送，直接执行回调函数onException方法。

## 2 sendDefaultImpl发送消息实现

该方法位于DefaultMQProducerImpl中，无论是同步消息、异步消息还是单向消息，最终都是调用该方法实现发送消息的逻辑的，因此该方法是真正的发送消息的方法入口。

该方法的大概步骤为：

**1、** 调用makeSureStateOK方法，确定此producer的服务状态正常，如果服务状态不是RUNNING，那么抛出异常；
**2、** 调用checkMessage方法，校验消息的合法性；
**3、** 调用tryToFindTopicPublishInfo方法，尝试查找消息的一个topic路由，用以发送消息；
**4、** 计算循环发送消息的总次数timesTotal，默认情况下，同步模式为3，即默认允许重试2次，可更改重试次数；其他模式为1，即不允许重试，不可更改实际上异步发送消息也会重试，最多两次，只不过不是通过这里的逻辑重试的；
**5、** 调用selectOneMessageQueue方法，选择一个消息队列MessageQueue，该犯法支持失败故障转移；
**6、** 调用sendKernelImpl方法发送消息，异步、同步、单向发送消息的模式都是通过该方法实现的；
**7、** 调用updateFaultItem方法，更新本地错误表缓存数据，用于延迟时间的故障转移的功能；
**8、** 根据发送模式执行不同的处理，如果是异步或者单向模式则直接返回，如果是同步模式，如果开启了retryAnotherBrokerWhenNotStoreOK开关，那么如果返回值不是返回SEND_OK状态，则仍然会执行重试发送；
**9、**
此过程中，如果抛出了RemotingException、MQClientException、以及部分MQBrokerException异常时，那么会进行重试，如果抛出了InterruptedException，或者因为超时则不再重试；

```java
/**
 * DefaultMQProducerImpl的方法
 *
 * @param msg               方法
 * @param communicationMode 通信模式
 * @param sendCallback      回调方法
 * @param timeout           超时时间
 */
private SendResult sendDefaultImpl(
        Message msg,
        final CommunicationMode communicationMode,
        final SendCallback sendCallback,
        final long timeout
) throws MQClientException, RemotingException, MQBrokerException, InterruptedException {
   
     
    /*
     * 1 确定此producer的服务状态正常，如果服务状态不是RUNNING，那么抛出异常
     */
    this.makeSureStateOK();
    /*
     * 2 校验消息的合法性
     */
    Validators.checkMessage(msg, this.defaultMQProducer);
    //生成本次调用id
    final long invokeID = random.nextLong();
    //开始时间戳
    long beginTimestampFirst = System.currentTimeMillis();
    long beginTimestampPrev = beginTimestampFirst;
    //结束时间戳
    long endTimestamp = beginTimestampFirst;
    /*
     * 3 尝试查找消息的一个topic路由，用以发送消息
     */
    TopicPublishInfo topicPublishInfo = this.tryToFindTopicPublishInfo(msg.getTopic());
    //找到有效的topic信息
    if (topicPublishInfo != null && topicPublishInfo.ok()) {
   
     
        boolean callTimeout = false;
        MessageQueue mq = null;
        Exception exception = null;
        SendResult sendResult = null;
        /*
         * 4 计算发送消息的总次数
         * 同步模式为3，即默认允许重试2次，可更改重试次数；其他模式为1，即不允许重试，不可更改
         */
        int timesTotal = communicationMode == CommunicationMode.SYNC ? 1 + this.defaultMQProducer.getRetryTimesWhenSendFailed() : 1;
        int times = 0;
        //记录每一次重试时候发送消息目标Broker名字的数组
        String[] brokersSent = new String[timesTotal];
        /*
         * 在循环中，发送消息，包含消息重试的逻辑，总次数默认不超过3
         */
        for (; times < timesTotal; times++) {
   
     
            //上次使用过的broker，可以为空，表示第一次选择
            String lastBrokerName = null == mq ? null : mq.getBrokerName();
            /*
             * 5 选择一个消息队列MessageQueue
             */
            MessageQueue mqSelected = this.selectOneMessageQueue(topicPublishInfo, lastBrokerName);
            if (mqSelected != null) {
   
     
                mq = mqSelected;
                //设置brokerName
                brokersSent[times] = mq.getBrokerName();
                try {
   
     
                    //调用的开始时间
                    beginTimestampPrev = System.currentTimeMillis();
                    //如果还有可调用次数，那么
                    if (times > 0) {
   
     
                        //在重新发送期间用名称空间重置topic
                        msg.setTopic(this.defaultMQProducer.withNamespace(msg.getTopic()));
                    }
                    //现在调用的开始时间 减去 开始时间，判断时候在调用发起之前就超时了
                    long costTime = beginTimestampPrev - beginTimestampFirst;
                    //如果已经超时了，那么直接结束循环，不再发送
                    //即超时的时候，即使还剩下重试次数，也不会再继续重试
                    if (timeout < costTime) {
   
     
                        callTimeout = true;
                        break;
                    }
                    /*
                     * 6 异步、同步、单向发送消息
                     */
                    sendResult = this.sendKernelImpl(msg, mq, communicationMode, sendCallback, topicPublishInfo, timeout - costTime);
                    //方法调用结束时间戳
                    endTimestamp = System.currentTimeMillis();
                    /*
                     * 7 更新本地错误表缓存数据，用于延迟时间的故障转移的功能
                     */
                    this.updateFaultItem(mq.getBrokerName(), endTimestamp - beginTimestampPrev, false);
                    /*
                     * 8 根据发送模式执行不同的处理
                     */
                    switch (communicationMode) {
   
     
                        //异步和单向模式直接返回null
                        case ASYNC:
                            return null;
                        case ONEWAY:
                            return null;
                        case SYNC:
                            //同步模式，如果开启了retryAnotherBrokerWhenNotStoreOK开关，那么如果不是返回SEND_OK状态，则仍然会执行重试发送
                            if (sendResult.getSendStatus() != SendStatus.SEND_OK) {
   
     
                                if (this.defaultMQProducer.isRetryAnotherBrokerWhenNotStoreOK()) {
   
     
                                    continue;
                                }
                            }
                            //如果发送成功，则返回
                            return sendResult;
                        default:
                            break;
                    }
                } catch (RemotingException e) {
   
     
                    //RemotingException异常，会执行重试
                    endTimestamp = System.currentTimeMillis();
                    this.updateFaultItem(mq.getBrokerName(), endTimestamp - beginTimestampPrev, true);
                    log.warn(String.format("sendKernelImpl exception, resend at once, InvokeID: %s, RT: %sms, Broker: %s", invokeID, endTimestamp - beginTimestampPrev, mq), e);
                    log.warn(msg.toString());
                    exception = e;
                    continue;
                } catch (MQClientException e) {
   
     
                    //MQClientException异常，会执行重试
                    endTimestamp = System.currentTimeMillis();
                    this.updateFaultItem(mq.getBrokerName(), endTimestamp - beginTimestampPrev, true);
                    log.warn(String.format("sendKernelImpl exception, resend at once, InvokeID: %s, RT: %sms, Broker: %s", invokeID, endTimestamp - beginTimestampPrev, mq), e);
                    log.warn(msg.toString());
                    exception = e;
                    continue;
                } catch (MQBrokerException e) {
   
     
                    //MQBrokerException异常
                    endTimestamp = System.currentTimeMillis();
                    this.updateFaultItem(mq.getBrokerName(), endTimestamp - beginTimestampPrev, true);
                    log.warn(String.format("sendKernelImpl exception, resend at once, InvokeID: %s, RT: %sms, Broker: %s", invokeID, endTimestamp - beginTimestampPrev, mq), e);
                    log.warn(msg.toString());
                    exception = e;
                    //如果返回的状态码属于一下几种，则支持重试：
                    //ResponseCode.TOPIC_NOT_EXIST,
                    //ResponseCode.SERVICE_NOT_AVAILABLE,
                    //ResponseCode.SYSTEM_ERROR,
                    //ResponseCode.NO_PERMISSION,
                    //ResponseCode.NO_BUYER_ID,
                    //ResponseCode.NOT_IN_CURRENT_UNIT

                    if (this.defaultMQProducer.getRetryResponseCodes().contains(e.getResponseCode())) {
   
     
                        continue;
                    } else {
   
     
                        //其他状态码不支持重试，如果有结果则返回，否则直接抛出异常
                        if (sendResult != null) {
   
     
                            return sendResult;
                        }

                        throw e;
                    }
                } catch (InterruptedException e) {
   
     
                    //InterruptedException异常，不会执行重试
                    endTimestamp = System.currentTimeMillis();
                    this.updateFaultItem(mq.getBrokerName(), endTimestamp - beginTimestampPrev, false);
                    log.warn(String.format("sendKernelImpl exception, throw exception, InvokeID: %s, RT: %sms, Broker: %s", invokeID, endTimestamp - beginTimestampPrev, mq), e);
                    log.warn(msg.toString());

                    log.warn("sendKernelImpl exception", e);
                    log.warn(msg.toString());
                    throw e;
                }
            } else {
   
     
                break;
            }
        }
        /*
         * 抛出异常的操作
         */
        if (sendResult != null) {
   
     
            return sendResult;
        }

        String info = String.format("Send [%d] times, still failed, cost [%d]ms, Topic: %s, BrokersSent: %s",
                times,
                System.currentTimeMillis() - beginTimestampFirst,
                msg.getTopic(),
                Arrays.toString(brokersSent));

        info += FAQUrl.suggestTodo(FAQUrl.SEND_MSG_FAILED);

        MQClientException mqClientException = new MQClientException(info, exception);
        if (callTimeout) {
   
     
            throw new RemotingTooMuchRequestException("sendDefaultImpl call timeout");
        }

        if (exception instanceof MQBrokerException) {
   
     
            mqClientException.setResponseCode(((MQBrokerException) exception).getResponseCode());
        } else if (exception instanceof RemotingConnectException) {
   
     
            mqClientException.setResponseCode(ClientErrorCode.CONNECT_BROKER_EXCEPTION);
        } else if (exception instanceof RemotingTimeoutException) {
   
     
            mqClientException.setResponseCode(ClientErrorCode.ACCESS_BROKER_TIMEOUT);
        } else if (exception instanceof MQClientException) {
   
     
            mqClientException.setResponseCode(ClientErrorCode.BROKER_NOT_EXIST_EXCEPTION);
        }

        throw mqClientException;
    }

    validateNameServerSetting();

    throw new MQClientException("No route info of this topic: " + msg.getTopic() + FAQUrl.suggestTodo(FAQUrl.NO_TOPIC_ROUTE_INFO),
            null).setResponseCode(ClientErrorCode.NOT_FOUND_TOPIC_EXCEPTION);
}
```

### 2.1 makeSureStateOK确定生产者服务状态

首先会确定此producer的服务状态正常，如果服务状态不是RUNNING，那么抛出异常。

```java
/**
 * DefaultMQProducerImpl的方法
 */
private void makeSureStateOK() throws MQClientException {
   
     
    //服务状态不是RUNNING，那么抛出MQClientException异常。
    if (this.serviceState != ServiceState.RUNNING) {
   
     
        throw new MQClientException("The producer service state not OK, "
                + this.serviceState
                + FAQUrl.suggestTodo(FAQUrl.CLIENT_SERVICE_NOT_OK),
                null);
    }
}
```

### 2.2 checkMessage校验消息的合法性

确定服务状态正常之后，还需要校验消息的合法性。校验规则为：

**1、** 如果msg消息为null，抛出异常；
**2、** 校验topic如果topic为空，或者长度大于127个字符，或者topic的字符串不符合"^[%|a-zA-Z0-9_-]+$"
模式，即包含非法字符，那么抛出异常如果当前topic是不为允许使用的系统topic，那么抛出异常；
**3、** 校验消息体如果消息体为null，或者为空数组，或者消息字节数组长度大于4,194,304，即消息的大小大于4M，那么抛出异常；

```java
/**
 * Validators的方法
 */
public static void checkMessage(Message msg, DefaultMQProducer defaultMQProducer) throws MQClientException {
   
     
    //如果消息为null，抛出异常
    if (null == msg) {
   
     
        throw new MQClientException(ResponseCode.MESSAGE_ILLEGAL, "the message is null");
    }
    /*
     * 校验topic
     */
    //如果topic为空，或者长度大于127个字符，或者topic的字符串不符合 "^[%|a-zA-Z0-9_-]+$"模式，即包含非法字符，那么抛出异常
    Validators.checkTopic(msg.getTopic());
    //如果当前topic是不为允许使用的系统topic SCHEDULE_TOPIC_XXXX，那么抛出异常
    Validators.isNotAllowedSendTopic(msg.getTopic());

    // body
    //如果消息体为null，那么抛出异常
    if (null == msg.getBody()) {
   
     
        throw new MQClientException(ResponseCode.MESSAGE_ILLEGAL, "the message body is null");
    }
    //如果消息体为空数组，那么抛出异常
    if (0 == msg.getBody().length) {
   
     
        throw new MQClientException(ResponseCode.MESSAGE_ILLEGAL, "the message body length is zero");
    }
    //如果消息 字节数组长度大于4,194,304，即消息的大小大于4M，那么抛出异常
    if (msg.getBody().length > defaultMQProducer.getMaxMessageSize()) {
   
     
        throw new MQClientException(ResponseCode.MESSAGE_ILLEGAL,
                "the message body size over max value, MAX: " + defaultMQProducer.getMaxMessageSize());
    }
}

public static void checkTopic(String topic) throws MQClientException {
   
     
    //如果topic为空，那么抛出异常
    if (UtilAll.isBlank(topic)) {
   
     
        throw new MQClientException("The specified topic is blank", null);
    }
    //如果topic长度大于127个字符，那么抛出异常
    if (topic.length() > TOPIC_MAX_LENGTH) {
   
     
        throw new MQClientException(
                String.format("The specified topic is longer than topic max length %d.", TOPIC_MAX_LENGTH), null);
    }
    //如果topic字符串包含非法字符，那么抛出异常
    if (isTopicOrGroupIllegal(topic)) {
   
     
        throw new MQClientException(String.format(
                "The specified topic[%s] contains illegal characters, allowing only %s", topic,
                "^[%|a-zA-Z0-9_-]+$"), null);
    }
}
```

### 2.3 tryToFindTopicPublishInfo查找topic的发布信息

该方法用于查找指定topic的发布信息TopicPublishInfo。

```java
/**
 * DefaultMQProducerImpl的方法
 * <p>
 * 查找指定topic的推送信息
 */
private TopicPublishInfo tryToFindTopicPublishInfo(final String topic) {
   
     
    //尝试直接从producer的topicPublishInfoTable中获取topic信息
    TopicPublishInfo topicPublishInfo = this.topicPublishInfoTable.get(topic);
    //如果没有获取到有效信息，
    if (null == topicPublishInfo || !topicPublishInfo.ok()) {
   
     
        //那么立即创建一个TopicPublishInfo
        this.topicPublishInfoTable.putIfAbsent(topic, new TopicPublishInfo());
        //立即从nameServer同步此topic的路由配置信息，并且更新本地缓存
        this.mQClientFactory.updateTopicRouteInfoFromNameServer(topic);
        //再次获取topicPublishInfo
        topicPublishInfo = this.topicPublishInfoTable.get(topic);
    }
    //如果找到的路由信息是可用的，直接返回
    if (topicPublishInfo.isHaveTopicRouterInfo() || topicPublishInfo.ok()) {
   
     
        return topicPublishInfo;
    } else {
   
     
        //再次从nameServer同步topic的数据，不过这次使用默认的topic “TBW102”去找路由配置信息作为本topic参数信息
        this.mQClientFactory.updateTopicRouteInfoFromNameServer(topic, true, this.defaultMQProducer);
        topicPublishInfo = this.topicPublishInfoTable.get(topic);
        return topicPublishInfo;
    }
}
```

首先在本地缓存topicPublishInfoTable获取，如果没有获取到有效数据，那么立即调用updateTopicRouteInfoFromNameServer方法从nameServer同步此topic的路由配置信息，并且更新本地缓存，如果还是没有获取到有效数据，那么再次从nameServer同步topic的数据，不过这次使用默认的topic
“TBW102”去找路由配置信息作为本topic参数信息。

updateTopicRouteInfoFromNameServer 方法我们在此前的producer启动流程中已经介绍了。
TopicPublishInfo包含topic的各种属性：

```java
/**
 * 是否是顺序消息
 */
private boolean orderTopic = false;
/**
 * 是否包含路由信息
 */
private boolean haveTopicRouterInfo = false;
/**
 * topic的消息队列集合
 */
private List<MessageQueue> messageQueueList = new ArrayList<MessageQueue>();
/**
 * 当前线程线程的消息队列的下标，循环选择消息队列使用+1
 */
private volatile ThreadLocalIndex sendWhichQueue = new ThreadLocalIndex();
/**
 * topic路由信息，包括topic的队列信息queueDatas，topic的broker信息brokerDatas，顺序topic配置orderTopicConf，消费过滤信息filterServerTable等属性
 */
private TopicRouteData topicRouteData;
```

### 2.4 计算发送次数timesTotal

**在发送消息之前，会先计算最大发送次数，同步模式为3，即默认允许重试2次，可更改重试次数；其他模式为1，即不允许重试，不可更改。**

```java
int timesTotal = communicationMode == CommunicationMode.SYNC ? 1 + 
this.defaultMQProducer.getRetryTimesWhenSendFailed() : 1;
```

**注意，异步发送同样有重试，并且也是两次，只不过它的重试不在这个循环里面，而是是在MQClientAPIImpl#sendMessage方法中，后面会讲到。
**

### 2.5 selectOneMessageQueue选择消息队列

**selectOneMessageQueue**方法用于查找一个可用的消息队列，该方法内部调用**mqFaultStrategy#selectOneMessageQueue**方法：

```java
/**
 * DefaultMQProducerImpl的方法
 *
 * 选择一个消息队列
 * @param tpInfo topic信息
 * @param lastBrokerName 上次使用过的broker
 */
public MessageQueue selectOneMessageQueue(final TopicPublishInfo tpInfo, final String lastBrokerName) {
   
     
    //调用mqFaultStrategy#selectOneMessageQueue方法
    return this.mqFaultStrategy.selectOneMessageQueue(tpInfo, lastBrokerName);
}
```

**mqFaultStrategy#selectOneMessageQueue**方法支持故障转移机制，其选择步骤为：

**1、** 首先判断是否开启了发送延迟故障转移机制，即sendLatencyFaultEnable属性是否为true，默认false不打开如果开启了该机制：；

**1、**
首先仍然是遍历消息队列，按照轮询的方式选取一个消息队列，当消息队列可用（无故障）时，选择消息队列的工作就结束，否则循环选择其他队列如果该mq的broker不存在LatencyFaultTolerance维护的faultItemTable集合属性中，或者当前时间戳已经大于该broker下一次开始可用的时间戳，表示无故障；
**2、**
没有选出无故障的mq，那么从LatencyFaultTolerance维护的不是最好的broker集合faultItemTable中随机选择一个broker，随后判断如果写队列数大于0，那么选择该broker然后遍历消息队列，采用取模的方式获取一个队列，即轮询的方式，重置其brokerName，queueId，进行消息发送；
**3、** 如果上面的步骤抛出了异常，那么遍历消息队列，采用取模的方式获取一个队列，即轮询的方式；
**2、**
如果没有发送延迟故障转移机制，那么那么遍历消息队列，即采用取模轮询的方式获取一个brokerName与lastBrokerName不相等的队列，即不会再次选择上次发送失败的broker如果没有找到一个不同broker的mq，那么退回到轮询的方式；

**selectOneMessageQueue**方法选择mq的时候的故障转移机制，其目的就是为了保证每次发送消息尽量更快的成功，是一种保证高可用的手段。总的来说，包括两种故障转移：

**1、**
一种是延迟时间的故障转移，这需要将sendLatencyFaultEnable属性中设置为true，默认false对于请求响应较慢的broker，可以在一段时间内将其状态置为不可用，消息队列选择时，会过滤掉mq认为不可用的broker，以此来避免不断向宕机的broker发送消息，选取一个延迟较短的broker，实现消息发送高可用；
**2、** 另一种是没有开启延迟时间的故障转移的时候，在轮询选择mq的时候，不会选择上次发送失败的broker，实现消息发送高可用；

```java
/**
 * MQFaultStrategy的方法
 * <p>
 * 选择一个消息队列，支持故障延迟转移
 *
 * @param tpInfo         topic信息
 * @param lastBrokerName 上次使用过的broker
 */
public MessageQueue selectOneMessageQueue(final TopicPublishInfo tpInfo, final String lastBrokerName) {
   
     
    /*
     * 判断是否开启了发送延迟故障转移机制，默认false不打开
     * 如果开启了该机制，那么每次选取topic下对应的queue时，会基于之前执行的耗时，在有存在符合条件的broker的前提下，优选选取一个延迟较短的broker，否则再考虑随机选取。
     */
    if (this.sendLatencyFaultEnable) {
   
     
        try {
   
     
            //当前线程线程的消息队列的下标，循环选择消息队列使用+1
            int index = tpInfo.getSendWhichQueue().incrementAndGet();
            //遍历消息队列，采用取模的方式获取一个队列，即轮询的方式
            for (int i = 0; i < tpInfo.getMessageQueueList().size(); i++) {
   
     
                //取模
                int pos = Math.abs(index++) % tpInfo.getMessageQueueList().size();
                if (pos < 0)
                    pos = 0;
                //获取该消息队列
                MessageQueue mq = tpInfo.getMessageQueueList().get(pos);
                //如果当前消息队列是可用的，即无故障，那么直接返回该mq
                //如果该broker不存在LatencyFaultTolerance维护的faultItemTable集合属性中，或者当前时间已经大于该broker下一次开始可用的时间点，表示无故障
                if (latencyFaultTolerance.isAvailable(mq.getBrokerName()))
                    return mq;
            }
            //没有选出无故障的mq，那么一个不是最好的broker集合中随机选择一个
            final String notBestBroker = latencyFaultTolerance.pickOneAtLeast();
            //如果写队列数大于0，那么选择该broker
            int writeQueueNums = tpInfo.getQueueIdByBroker(notBestBroker);
            if (writeQueueNums > 0) {
   
     
                //遍历消息队列，采用取模的方式获取一个队列，即轮询的方式
                final MessageQueue mq = tpInfo.selectOneMessageQueue();
                if (notBestBroker != null) {
   
     
                    //重置其brokerName，queueId，进行消息发送
                    mq.setBrokerName(notBestBroker);
                    mq.setQueueId(tpInfo.getSendWhichQueue().incrementAndGet() % writeQueueNums);
                }
                return mq;
            } else {
   
     
                //如果写队列数小于0，那么移除该broker
                latencyFaultTolerance.remove(notBestBroker);
            }
        } catch (Exception e) {
   
     
            log.error("Error occurred when selecting message queue", e);
        }
        //如果上面的步骤抛出了异常，那么遍历消息队列，采用取模的方式获取一个队列，即轮询的方式
        return tpInfo.selectOneMessageQueue();
    }
    //如果没有发送延迟故障转移机制，那么那么遍历消息队列，即采用取模轮询的方式
    //获取一个brokerName与lastBrokerName不相等的队列，即不会再次选择上次发送失败的broker
    return tpInfo.selectOneMessageQueue(lastBrokerName);
}
```

#### 2.5.1 selectOneMessageQueue选择一个mq

selectOneMessageQueue方法有两个重载方法，一个是有参数的，另一个是无参数的。
无参数的方法，即轮询选择一个mq，没有任何限制：

```java
/**
 * TopicPublishInfo的方法
 * <p>
 * 轮询的选择一个mq
 */
public MessageQueue selectOneMessageQueue() {
   
     
    //获取下一个index
    int index = this.sendWhichQueue.incrementAndGet();
    //取模计算索引
    int pos = Math.abs(index) % this.messageQueueList.size();
    if (pos < 0)
        pos = 0;
    //获取该索引的mq
    return this.messageQueueList.get(pos);
}
```

有参数的方法，其参数是上一次发送失败的brokerName，并且在选择的时候，不会选择上一次发送失败的brokerName的mq，即避免选择发送失败的broker继续发送。当然如果最后没有选出来，那么还是走轮询获取的逻辑。

```java
/**
 * TopicPublishInfo的方法
 *
 * @param lastBrokerName 上一次发送失败的brokerName
 */
public MessageQueue selectOneMessageQueue(final String lastBrokerName) {
   
     
    //如果lastBrokerName为null，即第一次发送，那么轮询选择一个
    if (lastBrokerName == null) {
   
     
        return selectOneMessageQueue();
    } else {
   
     
        for (int i = 0; i < this.messageQueueList.size(); i++) {
   
     
            //轮询选择一个mq
            int index = this.sendWhichQueue.incrementAndGet();
            int pos = Math.abs(index) % this.messageQueueList.size();
            if (pos < 0)
                pos = 0;
            MessageQueue mq = this.messageQueueList.get(pos);
            //如果mq的brokerName不等于lastBrokerName，就返回，否则选择下一个
            if (!mq.getBrokerName().equals(lastBrokerName)) {
   
     
                return mq;
            }
        }
        //没有选出来，那么轮询选择一个
        return selectOneMessageQueue();
    }
}
```

### 2.6 sendKernelImpl发送消息

选择了消息队列之后，会调用sendKernelImpl方法进行消息的发送。该方法的大概步骤为：

**1、**
首先调用findBrokerAddressInPublish方法从brokerAddrTable中查找Masterbroker地址如果找不到，那么再次调用tryToFindTopicPublishInfo方法从nameServer远程拉取配置，并更新本地缓存，随后再次尝试获取Masterbroker地址；
**2、** 调用brokerVIPChannel判断是否开启vip通道，如果开启了，那么将brokerAddr的port–2，因为vip通道的端口为普通端口–2；
**3、** 如果不是批量消息，那么设置唯一的uniqId；
**4、** 如果不是批量消息，并且消息体大于4K，那么进行消息压缩；
**5、** 如果存在CheckForbiddenHook，则执行checkForbidden钩子方法如果存在SendMessageHook，则执行sendMessageBefore钩子方法；
**6、** 设置请求头信息SendMessageRequestHeader，请求头包含各种基本属性，例如producerGroup、topic、queueId等，并且针对重试消息的处理，将消息重试次数和最大重试次数存入请求头中；

7. 根据不同的发送模式发送消息。如果是异步发送模式，则需要先克隆并还原消息。最终异步、单向、同步模式都是调用MQClientAPIImpl#sendMessage方法发送消息的。
8.
如果MQClientAPIImpl#sendMessage方法正常发送或者抛出RemotingException、MQBrokerException、InterruptedException异常，那么会判断如果存在SendMessageHook，则执行sendMessageAfter钩子方法。

**9、** 在finally块中，对原始消息进行恢复；

```java
/**
 * DefaultMQProducerImpl的方法
 * 发送消息
 *
 * @param msg               消息
 * @param mq                mq
 * @param communicationMode 发送模式
 * @param sendCallback      发送回调
 * @param topicPublishInfo  topic信息
 * @param timeout           超时时间
 * @return 发送结果
 */
private SendResult sendKernelImpl(final Message msg,
                                  final MessageQueue mq,
                                  final CommunicationMode communicationMode,
                                  final SendCallback sendCallback,
                                  final TopicPublishInfo topicPublishInfo,
                                  final long timeout) throws MQClientException, RemotingException, MQBrokerException, InterruptedException {
   
     
    //开始时间
    long beginStartTime = System.currentTimeMillis();
    /*
     * 1 根据brokerName从brokerAddrTable中查找broker地址
     */
    String brokerAddr = this.mQClientFactory.findBrokerAddressInPublish(mq.getBrokerName());
    //如果本地找不到 broker 的地址
    if (null == brokerAddr) {
   
     
        /*
         * 2 从nameServer远程拉取配置，并更新本地缓存
         * 该方法此前就学习过了
         */
        tryToFindTopicPublishInfo(mq.getTopic());
        //再次获取地址
        brokerAddr = this.mQClientFactory.findBrokerAddressInPublish(mq.getBrokerName());
    }

    SendMessageContext context = null;
    if (brokerAddr != null) {
   
     
        /*
         * 3 vip通道判断
         */
        brokerAddr = MixAll.brokerVIPChannel(this.defaultMQProducer.isSendMessageWithVIPChannel(), brokerAddr);

        byte[] prevBody = msg.getBody();
        try {
   
     
            //for MessageBatch,ID has been set in the generating process
            /*
             * 4 如果不是批量消息，那么尝试生成唯一uniqId，即UNIQ_KEY属性。MessageBatch批量消息在生成时就已经设置uniqId
             * uniqId也被称为客户端生成的msgId，从逻辑上代表唯一一条消息
             */
            if (!(msg instanceof MessageBatch)) {
   
     
                MessageClientIDSetter.setUniqID(msg);
            }
            /*
             * 设置nameSpace为实例Id
             */
            boolean topicWithNamespace = false;
            if (null != this.mQClientFactory.getClientConfig().getNamespace()) {
   
     
                msg.setInstanceId(this.mQClientFactory.getClientConfig().getNamespace());
                topicWithNamespace = true;
            }
            //消息标识符
            int sysFlag = 0;
            //消息压缩标识
            boolean msgBodyCompressed = false;
            /*
             * 5 尝试压缩消息
             */
            if (this.tryToCompressMessage(msg)) {
   
     
                sysFlag |= MessageSysFlag.COMPRESSED_FLAG;
                msgBodyCompressed = true;
            }
            //事务消息标志，prepare消息
            final String tranMsg = msg.getProperty(MessageConst.PROPERTY_TRANSACTION_PREPARED);
            if (Boolean.parseBoolean(tranMsg)) {
   
     
                sysFlag |= MessageSysFlag.TRANSACTION_PREPARED_TYPE;
            }
            /*
             * 6 如果存在CheckForbiddenHook，则执行checkForbidden方法
             * 为什么叫禁止钩子呢，可能是想要使用者将不可发送消息的检查放在这个钩子函数里面吧（猜测）
             */
            if (hasCheckForbiddenHook()) {
   
     
                CheckForbiddenContext checkForbiddenContext = new CheckForbiddenContext();
                checkForbiddenContext.setNameSrvAddr(this.defaultMQProducer.getNamesrvAddr());
                checkForbiddenContext.setGroup(this.defaultMQProducer.getProducerGroup());
                checkForbiddenContext.setCommunicationMode(communicationMode);
                checkForbiddenContext.setBrokerAddr(brokerAddr);
                checkForbiddenContext.setMessage(msg);
                checkForbiddenContext.setMq(mq);
                checkForbiddenContext.setUnitMode(this.isUnitMode());
                this.executeCheckForbiddenHook(checkForbiddenContext);
            }
            /*
             * 7 如果存在SendMessageHook，则执行sendMessageBefore方法
             */
            if (this.hasSendMessageHook()) {
   
     
                context = new SendMessageContext();
                context.setProducer(this);
                context.setProducerGroup(this.defaultMQProducer.getProducerGroup());
                context.setCommunicationMode(communicationMode);
                context.setBornHost(this.defaultMQProducer.getClientIP());
                context.setBrokerAddr(brokerAddr);
                context.setMessage(msg);
                context.setMq(mq);
                context.setNamespace(this.defaultMQProducer.getNamespace());
                String isTrans = msg.getProperty(MessageConst.PROPERTY_TRANSACTION_PREPARED);
                if (isTrans != null && isTrans.equals("true")) {
   
     
                    context.setMsgType(MessageType.Trans_Msg_Half);
                }

                if (msg.getProperty("__STARTDELIVERTIME") != null || msg.getProperty(MessageConst.PROPERTY_DELAY_TIME_LEVEL) != null) {
   
     
                    context.setMsgType(MessageType.Delay_Msg);
                }
                this.executeSendMessageHookBefore(context);
            }
            /*
             * 8 设置请求头信息
             */
            SendMessageRequestHeader requestHeader = new SendMessageRequestHeader();
            requestHeader.setProducerGroup(this.defaultMQProducer.getProducerGroup());
            requestHeader.setTopic(msg.getTopic());
            requestHeader.setDefaultTopic(this.defaultMQProducer.getCreateTopicKey());
            requestHeader.setDefaultTopicQueueNums(this.defaultMQProducer.getDefaultTopicQueueNums());
            requestHeader.setQueueId(mq.getQueueId());
            requestHeader.setSysFlag(sysFlag);
            requestHeader.setBornTimestamp(System.currentTimeMillis());
            requestHeader.setFlag(msg.getFlag());
            requestHeader.setProperties(MessageDecoder.messageProperties2String(msg.getProperties()));
            requestHeader.setReconsumeTimes(0);
            requestHeader.setUnitMode(this.isUnitMode());
            requestHeader.setBatch(msg instanceof MessageBatch);
            //针对重试消息的处理
            if (requestHeader.getTopic().startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX)) {
   
     
                //获取消息重新消费次数属性值
                String reconsumeTimes = MessageAccessor.getReconsumeTime(msg);
                if (reconsumeTimes != null) {
   
     
                    //将重新消费次数设置到请求头中，并且清除该属性
                    requestHeader.setReconsumeTimes(Integer.valueOf(reconsumeTimes));
                    MessageAccessor.clearProperty(msg, MessageConst.PROPERTY_RECONSUME_TIME);
                }
                //获取消息的最大重试次数属性值
                String maxReconsumeTimes = MessageAccessor.getMaxReconsumeTimes(msg);
                if (maxReconsumeTimes != null) {
   
     
                    //将最大重新消费次数设置到请求头中，并且清除该属性
                    requestHeader.setMaxReconsumeTimes(Integer.valueOf(maxReconsumeTimes));
                    MessageAccessor.clearProperty(msg, MessageConst.PROPERTY_MAX_RECONSUME_TIMES);
                }
            }
            /*
             * 9 根据不同的发送模式，发送消息
             */
            SendResult sendResult = null;
            switch (communicationMode) {
   
     
                /*
                 * 异步发送模式
                 */
                case ASYNC:
                    /*
                     * 首先克隆并还原消息
                     *
                     * 该方法的finally中已经有还原消息的代码了，为什么在异步发送消息之前，还要先还原消息呢？
                     *
                     * 因为异步发送时 finally 重新赋值的时机并不确定，有很大概率是在第一次发送结束前就完成了 finally 中的赋值，
                     * 因此在内部重试前 msg.body 大概率已经被重新赋值过，而 onExceptionImpl 中的重试逻辑 MQClientAPIImpl.sendMessageAsync 不会再对数据进行压缩，
                     * 简言之，在异步发送的情况下，如果调用 onExceptionImpl 内部的重试，有很大概率发送的是无压缩的数据
                     */
                    Message tmpMessage = msg;
                    boolean messageCloned = false;
                    //如果开启了消息压缩
                    if (msgBodyCompressed) {
   
     
                        //If msg body was compressed, msgbody should be reset using prevBody.
                        //Clone new message using commpressed message body and recover origin massage.
                        //Fix bug:https://github.com/apache/rocketmq-externals/issues/66
                        //克隆一个message
                        tmpMessage = MessageAccessor.cloneMessage(msg);
                        messageCloned = true;
                        //恢复原来的消息体
                        msg.setBody(prevBody);
                    }
                    //如果topic整合了namespace
                    if (topicWithNamespace) {
   
     
                        if (!messageCloned) {
   
     
                            tmpMessage = MessageAccessor.cloneMessage(msg);
                            messageCloned = true;
                        }
                        //还原topic
                        msg.setTopic(NamespaceUtil.withoutNamespace(msg.getTopic(), this.defaultMQProducer.getNamespace()));
                    }
                    /*
                     * 发送消息之前，进行超时检查，如果已经超时了那么取消本次发送操作，抛出异常
                     */
                    long costTimeAsync = System.currentTimeMillis() - beginStartTime;
                    if (timeout < costTimeAsync) {
   
     
                        throw new RemotingTooMuchRequestException("sendKernelImpl call timeout");
                    }
                    /*
                     * 10 发送异步消息
                     */
                    sendResult = this.mQClientFactory.getMQClientAPIImpl().sendMessage(
                            brokerAddr,
                            mq.getBrokerName(),
                            tmpMessage,
                            requestHeader,
                            timeout - costTimeAsync,
                            communicationMode,
                            sendCallback,
                            topicPublishInfo,
                            this.mQClientFactory,
                            this.defaultMQProducer.getRetryTimesWhenSendAsyncFailed(),
                            context,
                            this);
                    break;
                /*
                 * 单向、同步发送模式
                 */
                case ONEWAY:
                case SYNC:
                    /*
                     * 发送消息之前，进行超时检查，如果已经超时了那么取消本次发送操作，抛出异常
                     */
                    long costTimeSync = System.currentTimeMillis() - beginStartTime;
                    if (timeout < costTimeSync) {
   
     
                        throw new RemotingTooMuchRequestException("sendKernelImpl call timeout");
                    }
                    /*
                     * 10 发送单向、同步消息
                     */
                    sendResult = this.mQClientFactory.getMQClientAPIImpl().sendMessage(
                            brokerAddr,
                            mq.getBrokerName(),
                            msg,
                            requestHeader,
                            timeout - costTimeSync,
                            communicationMode,
                            context,
                            this);
                    break;
                default:
                    assert false;
                    break;
            }
            /*
             * 9 如果存在SendMessageHook，则执行sendMessageAfter方法
             */
            if (this.hasSendMessageHook()) {
   
     
                context.setSendResult(sendResult);
                this.executeSendMessageHookAfter(context);
            }
            //返回执行结果
            return sendResult;

            //如果抛出了异常，如果存在SendMessageHook，则执行sendMessageAfter方法
        } catch (RemotingException e) {
   
     
            if (this.hasSendMessageHook()) {
   
     
                context.setException(e);
                this.executeSendMessageHookAfter(context);
            }
            throw e;
        } catch (MQBrokerException e) {
   
     
            if (this.hasSendMessageHook()) {
   
     
                context.setException(e);
                this.executeSendMessageHookAfter(context);
            }
            throw e;
        } catch (InterruptedException e) {
   
     
            if (this.hasSendMessageHook()) {
   
     
                context.setException(e);
                this.executeSendMessageHookAfter(context);
            }
            throw e;
        } finally {
   
     
            /*
             * 对消息进行恢复
             * 1、因为客户端可能还需要查看原始的消息内容，如果是压缩消息，则无法查看
             * 2、另外如果第一次压缩后消息还是大于4k，如果不恢复消息，那么客户端使用该message重新发送的时候，还会进行一次消息压缩
             */
            msg.setBody(prevBody);
            msg.setTopic(NamespaceUtil.withoutNamespace(msg.getTopic(), this.defaultMQProducer.getNamespace()));
        }
    }

    throw new MQClientException("The broker[" + mq.getBrokerName() + "] not exist", null);
}
```

#### 2.6.1 findBrokerAddressInPublish查找broker地址

首先会根据brokerName从brokerAddrTable中查找broker地址。生产者只会向Master节点发送消息，因此只会返回Master节点的地址。

```java
/**
 * MQClientInstance的方法
 */
public String findBrokerAddressInPublish(final String brokerName) {
   
     
    //查询brokerAddrTable缓存的数据
    HashMap<Long/* brokerId */, String/* address */> map = this.brokerAddrTable.get(brokerName);
    //返回Mater节点的地址
    if (map != null && !map.isEmpty()) {
   
     
        return map.get(MixAll.MASTER_ID);
    }

    return null;
}
```

#### 2.6.2 brokerVIPChannel判断vip通道

**获取到brokerAddr之后，需要判断是否开启vip通道，如果开启了，那么将brokerAddr的port – 2，因为vip通道的端口为普通通道端口– 2。
**

```java
/**
 * MixAll的方法
 */
public static String brokerVIPChannel(final boolean isChange, final String brokerAddr) {
   
     
    //如果开启了vip通道
    if (isChange) {
   
     
        int split = brokerAddr.lastIndexOf(":");
        String ip = brokerAddr.substring(0, split);
        String port = brokerAddr.substring(split + 1);
        //重新拼接brokerAddr，其中port - 2
        String brokerAddrNew = ip + ":" + (Integer.parseInt(port) - 2);
        return brokerAddrNew;
    } else {
   
     
        //如果没有开启vip通道，那么返回原地址
        return brokerAddr;
    }
}
```

消费者拉取消息只能请求普通通道，但是生产者发送消息可以选择vip通道或者普通通道。

[为什么要开启两个端口监听客户端请求呢](https://github.com/apache/rocketmq/issues/1510)
？答案是隔离读写操作。在消息的API中，最重要的是发送消息，需要高RTT。如果普通端口的请求繁忙，会使得netty的IO线程阻塞，例如消息堆积的时候，消费消息的请求会填满IO线程池，导致写操作被阻塞。在这种情况下，我们可以向VIP频道发送消息，以保证发送消息的RTT。

但是，请注意，在rocketmq
4.5.1版本之后，客户端发送消息的请求选择VIP通道的配置被改为false，想要手动默认开启需要配置com.rocketmq.sendMessageWithVIPChannel属性。或者在创建producer的时候调用producer.setVipChannelEnabled()
方法更改当前producer的配置。

![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162034497.png)
**因此，现在发送消息和消费消息实际上默认都走10911端口了，无需再关心10909端口的问题了。**

#### 2.6.3 setUniqID生成uniqId

该方法用于设置单条消息在客户端的uniqId，即设置到UNIQ_KEY属性中，批量消息在生成时就已经设置uniqId。

uniqId也被称为msgId，从逻辑上代表客户端生成的唯一一条消息，更多见此[文章](https://blog.csdn.net/weixin_43767015/article/details/121751053)，[uniqId生成规则](https://blog.csdn.net/qq_21561501/article/details/105684989)。

```java
/**
 * MessageClientIDSetter的方法
 */
public static void setUniqID(final Message msg) {
   
     
    //如果这条消息不存在"UNIQ_KEY"属性，那么创建uniqId并且存入"UNIQ_KEY"属性中
    if (msg.getProperty(MessageConst.PROPERTY_UNIQ_CLIENT_MESSAGE_ID_KEYIDX) == null) {
   
     
        msg.putProperty(MessageConst.PROPERTY_UNIQ_CLIENT_MESSAGE_ID_KEYIDX, createUniqID());
    }
}
```

#### 2.6.4 tryToCompressMessage压缩消息

在发送单条消息的时候，会判断如果消息体超过4K，那么会进行消息压缩，压缩比默认为5，压缩完毕之后设置压缩标志，批量消息不支持压缩。消息压缩有利于更快的进行网络数据传输。

```java
/**
 * DefaultMQProducerImpl的方法
 */
private boolean tryToCompressMessage(final Message msg) {
   
     
    //如果是批量消息，那么不进行压缩
    if (msg instanceof MessageBatch) {
   
     
        //batch dose not support compressing right now
        return false;
    }
    byte[] body = msg.getBody();
    if (body != null) {
   
     
        //如果消息长度大于4K
        if (body.length >= this.defaultMQProducer.getCompressMsgBodyOverHowmuch()) {
   
     
            try {
   
     
                //进行压缩，使用的JDK自带的压缩类
                byte[] data = UtilAll.compress(body, zipCompressLevel);
                if (data != null) {
   
     
                    //重新设置到body中
                    msg.setBody(data);
                    return true;
                }
            } catch (IOException e) {
   
     
                log.error("tryToCompressMessage exception", e);
                log.warn(msg.toString());
            }
        }
    }

    return false;
}
```

### 2.7 updateFaultItem更新故障表

再发送消息完毕之后，无论是正常还是异常状态，都需要调用updateFaultItem方法，更新本地错误表缓存数据，用于延迟时间的故障转移的功能。

故障转移功能在此前的selectOneMessageQueue方法中被使用到，用于查找一个可用的消息队列。updateFaultItem方法在判断开启了故障转移之后，会更新LatencyFaultTolerance维护的faultItemTable集合属性中的异常broker数据。

```java
/**
 * DefaultMQProducerImpl的方法
 * @param brokerName brokerName
 * @param currentLatency 当前延迟
 * @param isolation 是否使用默认隔离
 */
public void updateFaultItem(final String brokerName, final long currentLatency, boolean isolation) {
   
     
    //调用MQFaultStrategy#updateFaultItem方法
    this.mqFaultStrategy.updateFaultItem(brokerName, currentLatency, isolation);
}
```

看看**MQFaultStrategy#updateFaultItem**
方法。其根据本次发送消息的延迟时间currentLatency，会去计算出该broker的隔离时间duration，即可以计算出该broker的下一个可用时间点。然后更新故障记录表。

```java
/**
 * MQFaultStrategy的方法
 *
 * @param brokerName     brokerName
 * @param currentLatency 当前延迟
 * @param isolation      是否使用默认隔离时间
 */
public void updateFaultItem(final String brokerName, final long currentLatency, boolean isolation) {
   
     
    //如果开启了故障转移，即sendLatencyFaultEnable为true，默认false
    if (this.sendLatencyFaultEnable) {
   
     
        //根据消息当前延迟currentLatency计算当前broker的故障延迟的时间duration
        //如果isolation为true，则使用默认隔离时间30000，即30s
        long duration = computeNotAvailableDuration(isolation ? 30000 : currentLatency);
        //更新故障记录表
        this.latencyFaultTolerance.updateFaultItem(brokerName, currentLatency, duration);
    }
}
```

#### 2.7.1 computeNotAvailableDuration计算隔离时间

computeNotAvailableDuration方法根据本次发送消息的延迟时间currentLatency，会去计算出该broker的隔离时间duration，或者说不可以用时间段，据此即可以计算出该broker的下一个可用时间点。

latencyMax延迟等级和notAvailableDuration隔离时间的对应关系如下：

| **latencyMax，Producer发送消息消耗时长** | **notAvailableDuration，Broker不可用时长** |
|:--------------------------------|:-------------------------------------|
| **50L**                         | 0L                                   |
| **100L**                        | 0L                                   |
| **550L**                        | 30000L                               |
| **1000L**                       | 60000L                               |
| **2000L**                       | 120000L                              |
| **3000L**                       | 180000L                              |
| **15000L**                      | 600000L                              |

**如果使用默认隔离时间30000，那个实际将会被隔离600000L，即10分钟。当抛出异常的时候，通常会设置isolation，即使用默认隔离时间。并且从这个表可以看出来，发送消息延迟越大，那么被设置的隔离时间也就越大。
**

```java
//延迟等级
private long[] latencyMax = {
   
     50L, 100L, 550L, 1000L, 2000L, 3000L, 15000L};
//不可用时间等级
private long[] notAvailableDuration = {
   
     0L, 0L, 30000L, 60000L, 120000L, 180000L, 600000L};

/**
 * MQFaultStrategy的方法
 *
 * @param currentLatency 当前延迟
 * @return 故障延迟的时间
 */
private long computeNotAvailableDuration(final long currentLatency) {
   
     
    //倒叙遍历latencyMax
    for (int i = latencyMax.length - 1; i >= 0; i--) {
   
     
        //选择broker延迟时间对应的broker不可用时间，默认30000对应的故障延迟的时间为600000，即10分钟
        if (currentLatency >= latencyMax[i])
            return this.notAvailableDuration[i];
    }

    return 0;
}
```

#### 2.7.2 updateFaultItem更新故障表

该方法更新LatencyFaultToleranceImpl维护的faultItemTable集合属性中的异常broker的故障信息，将会设置发送消息的延迟时间currentLatency属性，以及下一个可用时间点LatencyFaultToleranceImpl属性。

下次可用时间LatencyFaultToleranceImpl属性= 现在的时间 +
隔离的时间，在selectOneMessageQueue方法选取消息队列的时候，如果开启了集群故障转移，那么会查找下一个可用时间点小于当前时间点的broker的队列来发送消息。

```java
/**
 * LatencyFaultToleranceImpl的方法
 *
 * @param name                 brokerName
 * @param currentLatency       当前延迟
 * @param notAvailableDuration 隔离时间（不可用时间）
 */
@Override
public void updateFaultItem(final String name, final long currentLatency, final long notAvailableDuration) {
   
     
    //获取该broker此前的故障记录数据
    FaultItem old = this.faultItemTable.get(name);
    //如果此前没有数据，那么设置一个新对象肌凝乳
    if (null == old) {
   
     
        final FaultItem faultItem = new FaultItem(name);
        //设置当前延迟
        faultItem.setCurrentLatency(currentLatency);
        //设置下一次可用时间点
        faultItem.setStartTimestamp(System.currentTimeMillis() + notAvailableDuration);
        //已有故障记录，更新
        old = this.faultItemTable.putIfAbsent(name, faultItem);
        if (old != null) {
   
     
            old.setCurrentLatency(currentLatency);
            old.setStartTimestamp(System.currentTimeMillis() + notAvailableDuration);
        }
    } else {
   
     
        //已有故障记录，更新
        old.setCurrentLatency(currentLatency);
        old.setStartTimestamp(System.currentTimeMillis() + notAvailableDuration);
    }
}
```

## 3 总结

本次我们学习了Producer的发送消息的源码总体流程，对于具体的发送消息的sendMessage方法源码将在下文讲解。

从这些源码中，我们得知了一些常见的却容易混淆的概念和知识，例如：

**1、** 生产者消息重试：RocketMQ的消费者消息重试和生产者消息重投；
**2、** 生产者故障转移通过sendLatencyFaultEnable属性配置是否开启，默认未开启故障转移机制，其目的就是为了保证每次发送消息尽量更快的成功，是一种保证高可用的手段总的来说，包括两种故障转移：；

**1、**
一种是延迟时间的故障转移，这需要将sendLatencyFaultEnable属性中设置为true，默认false对于请求响应较慢的broker，可以在一段时间内将其状态置为不可用，消息队列选择时，会过滤掉mq认为不可用的broker，以此来避免不断向宕机的broker发送消息，选取一个延迟较短的broker，实现消息发送高可用；
**2、** 另一种是没有开启延迟时间的故障转移的时候，在轮询选择mq的时候，不会选择上次发送失败的broker，实现消息发送高可用；
**3、** Vip通道VIP通道用于隔离读写操作消费者拉取消息只能请求普通通道，但是生产者发送消息可以选择vip通道或者普通通道；

**1、**
在消息的API中，最重要的是发送消息，需要高RTT如果普通端口的请求繁忙，会使得netty的IO线程阻塞，例如消息堆积的时候，消费消息的请求会填满IO线程池，导致写操作被阻塞在这种情况下，我们可以向VIP频道发送消息，以保证发送消息的RTT；
**2、**
但是，请注意，在rocketmq4.5.1版本之后，客户端发送消息的请求选择VIP通道的配置被改为false，想要手动默认开启需要配置com.rocketmq.sendMessageWithVIPChannel属性或者在创建producer的时候调用producer.setVipChannelEnabled()
方法更改当前producer的配置；
**4、**
故障转移表，RocketMQ的Producer生产者故障转移依赖于故障转移表实现，他是一个HasmMap消息发送结束之后，会根据本次发送消息的延迟时间currentLatency，会去计算出该broker对应的的隔离时间duration，即可以计算出该broker的下一个可用时间点，然后更新故障记录表故障转移表的key为brokerName，value为未来该broker可用时间；