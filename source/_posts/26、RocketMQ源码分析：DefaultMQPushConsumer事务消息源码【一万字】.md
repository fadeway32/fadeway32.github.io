---

layout:  26、RocketMQ源码分析：DefaultMQPushConsumer事务消息源码【一万字】

title:   26、RocketMQ源码分析：DefaultMQPushConsumer事务消息源码【一万字】

tags: RocketMq

categories: Web

top: 56

path: /article/1739713351

abbrlink: 1739713351

date: 2025-02-16 21:42:06


--- 

# 26、RocketMQ源码分析：DefaultMQPushConsumer事务消息源码【一万字】

分类：[RocketMQ源码分析（1）](https://cxykk.com/?cat=318)  2024-03-27 阅读(130)

事务消息是RocketMQ的一大特性，其被用来实现分布式事务，关于RocketMQ的事务消息的相关原理的介绍见这篇博客：[RocketMQ的分布式事务机制（事务消息）](https://blog.csdn.net/weixin_43767015/article/details/121308018)
，关于事务消息的基本案例看这里：[消息事务样例](https://github.com/apache/rocketmq/blob/master/docs/cn/RocketMQ_Example.md#6-消息事务样例)
。本文主要介绍RocketMQ的事务消息的源码。

**不出意外的话，这将是RocketMQ源码系列的最后一篇文章，如有其他没分析到的想看的源码，可以给我说。感谢大家看到最后，祝大家学业有成，工作顺利！
**

#### 文章目录

- 1 start启动事务消息生产者
-
  - 1.1 initTransactionEnv初始化事务环境
- 2 producer发送事务消息
- 3 broker处理half半消息
-
  - 3.1 parseHalfMessageInner解析half消息
- 4 endTransaction结束事务
- 5 broker处理结束事务消息
-
  - 5.1 commitMessage提交half半消息
- 5.2 checkPrepareMessage检查half半消息
- 5.3 endMessageTransaction还原原始消息
- 5.4 sendFinalMessage发送最终消息
- 5.5 deletePrepareMessage删除half消息
-
  - 5.5.1 putOpMessage写入Op事务消息
- 6 broker消息回查
-
  - 6.1 TransactionalMessageCheckService事务回查服务
- 6.2 check检查事物消息
-
  - 6.2.1 getOpQueue获取Op消息队列
  - 6.2.2 fillOpRemoveMap填充需要移除的half消息
  - 6.2.3 needDiscard是否需要丢弃half消息
  - 6.2.4 needSkip是否需要跳过half消息
  - 6.2.5 resolveDiscardMsg丢弃half消息
  -
    - 6.2.5.1 toMessageExtBrokerInner转换内部消息对象
  - 6.2.6 checkPrepareQueueOffset检查half队列偏移量
  - 6.2.7 resolveHalfMsg异步发起回查请求
- 7 producer处理消息回查请求
-
  - 7.1 checkTransactionState检查事务状态
- 7.2 checkTransactionState检查事务状态
- 8 事物消息总结

## 1 start启动事务消息生产者

*
*事务消息需要使用TransactionMQProducer类发送，该类继承了DefaultMQProducer。它同样通过start方法启动，在该方法中，首先会调用initTransactionEnv方法准备事务环境，然后调用父类DefaultMQProducer的start方法进行启动。
**

```java
/**
 * TransactionMQProducer的方法
 * <p>
 * 启动事务消息生产者
 */
@Override
public void start() throws MQClientException {
   
     
    //初始化事务环境
    this.defaultMQProducerImpl.initTransactionEnv();
    //父类DefaultMQProducer的start方法
    super.start();
}
```

### 1.1 initTransactionEnv初始化事务环境

该方法初始化事务环境，实际上就是初始化事务回查线程池以及事务回查消息的阻塞队列。

```java
/**
 * DefaultMQProducerImpl的方法
 * <p>
 * 初始化事务环境
 */
public void initTransactionEnv() {
   
     
    //获取内部的TransactionMQProducer
    TransactionMQProducer producer = (TransactionMQProducer) this.defaultMQProducer;
    //如果有自定义的事务线程池，那么同时使用该线程池作为事务回查线程池
    if (producer.getExecutorService() != null) {
   
     
        this.checkExecutor = producer.getExecutorService();
    }
    //如果没有自定义的事务线程池，那么创建一个单线程的线程池作为事务回查线程池
    else {
   
     
        //事务回查消息的阻塞队列，最大长度2000
        this.checkRequestQueue = new LinkedBlockingQueue<Runnable>(producer.getCheckRequestHoldMax());
        //默认事务回查线程池
        this.checkExecutor = new ThreadPoolExecutor(
                //核心线程数1
                producer.getCheckThreadPoolMinSize(),
                //最大线程数1
                producer.getCheckThreadPoolMaxSize(),
                1000 * 60,
                TimeUnit.MILLISECONDS,
                this.checkRequestQueue);
    }
}
```

## 2 producer发送事务消息

TransactionMQProducer通过sendMessageInTransaction方法发送事务消息。

```java
/**
 * TransactionMQProducer的方法
 *
 * @param msg 要发送的事务消息
 * @param arg 参与本地事务使用的参数
 * @return 发送结果
 */
@Override
public TransactionSendResult sendMessageInTransaction(final Message msg,
                                                      final Object arg) throws MQClientException {
   
     
    //必须要有事务监听器
    if (null == this.transactionListener) {
   
     
        throw new MQClientException("TransactionListener is null", null);
    }
    //根据namespace和topic设置主题，一般没有设置nameSpace
    msg.setTopic(NamespaceUtil.wrapNamespace(this.getNamespace(), msg.getTopic()));
    //调用DefaultMQProducerImpl#sendMessageInTransaction方法发送事务消息
    return this.defaultMQProducerImpl.sendMessageInTransaction(msg, null, arg);
}
```

内部调用DefaultMQProducerImpl#sendMessageInTransaction方法发送事务消息。大概逻辑为：

**1、** 获取设置的transactionListener，不可为null；
**2、** 忽略DelayTimeLevel参数，事务消息不支持延迟消息，将PROPERTY_DELAY_TIME_LEVEL（DELAY）属性清除；
**3、** 校验消息的合法性；
**4、** 设置事务half半消息标志，设置PROPERTY_TRANSACTION_PREPARED属性为true设置PROPERTY_PRODUCER_GROUP属性，为当前生产者所属的生产者组；

5. 事务消息的第一阶段，调用defaultMQProducerImpl#send方法同步发送事务half半消息，可以看到，其发送的方法和普通同步消息的发送方法是同一个方法。

**6、** 处理发送事务half半消息的结果，判断并执行本地事务；

**1、** 如果返回结果是SEND_OK，即half消息发送成功；

```
1.  获取生产者客户端生成的uniqId。uniqId也被称为msgId，从逻辑上代表客户端生成的唯一一条消息，设置事务id为uniqId。
    2.  通过transactionListener\#executeLocalTransaction方法执行本地事务，获取本地事务状态localTransactionState。
3.  如果返回null，那么算作UNKNOW状态。如果事务状态不是COMMIT\_MESSAGE，那么输出日志。
```

**2、** 如果返回结果是其他状态，即算作half消息发送失败，不执行本地事务，直接设置本地事务状态localTransactionState为ROLLBACK_MESSAGE，即回滚；
**7、** 事务消息的第二阶段，通过endTransaction方法执行事务的commit或者rollback操作；
**8、** 组装并返回事务消息的发送结果；

```java
/**
 * DefaultMQProducerImpl的方法
 * <p>
 * 发送事务消息
 *
 * @param msg                      要发送的事务胸袭
 * @param localTransactionExecuter 本地事务执行器，一般都是null
 * @param arg                      本地事务执行参数
 * @return
 * @throws MQClientException
 */
public TransactionSendResult sendMessageInTransaction(final Message msg, final LocalTransactionExecuter localTransactionExecuter, final Object arg) throws MQClientException {
   
     
    //获取设置的transactionListener，不可为null
    TransactionListener transactionListener = getCheckListener();
    if (null == localTransactionExecuter && null == transactionListener) {
   
     
        throw new MQClientException("tranExecutor is null", null);
    }

    //忽略DelayTimeLevel参数，事务消息不支持延迟消息，将PROPERTY_DELAY_TIME_LEVEL（DELAY）属性清除
    if (msg.getDelayTimeLevel() != 0) {
   
     
        MessageAccessor.clearProperty(msg, MessageConst.PROPERTY_DELAY_TIME_LEVEL);
    }
    //校验消息的合法性
    Validators.checkMessage(msg, this.defaultMQProducer);
    SendResult sendResult = null;
    //设置事务half半消息标志，设置PROPERTY_TRANSACTION_PREPARED属性为true
    MessageAccessor.putProperty(msg, MessageConst.PROPERTY_TRANSACTION_PREPARED, "true");
    //设置PROPERTY_PRODUCER_GROUP属性，为当前生产者所属的生产者组
    MessageAccessor.putProperty(msg, MessageConst.PROPERTY_PRODUCER_GROUP, this.defaultMQProducer.getProducerGroup());
    /*
     * 第一阶段 发送half半消息
     */
    try {
   
     
        //调用defaultMQProducerImpl#send同步发送half半消息
        sendResult = this.send(msg);
    } catch (Exception e) {
   
     
        //如果出现异常，那么直接抛出
        throw new MQClientException("send message Exception", e);
    }
    /*
     * 处理发送half半消息的结果，执行本地事务
     */
    LocalTransactionState localTransactionState = LocalTransactionState.UNKNOW;
    Throwable localException = null;
    switch (sendResult.getSendStatus()) {
   
     
        //如果发送成功
        case SEND_OK: {
   
     
            try {
   
     
                //获取事务id
                if (sendResult.getTransactionId() != null) {
   
     
                    //设置__transactionId__属性为事务id，这个属性目前没用到
                    msg.putUserProperty("__transactionId__", sendResult.getTransactionId());
                }
                //获取生产者客户端生成的uniqId。uniqId也被称为msgId，从逻辑上代表客户端生成的唯一一条消息
                String transactionId = msg.getProperty(MessageConst.PROPERTY_UNIQ_CLIENT_MESSAGE_ID_KEYIDX);
                if (null != transactionId && !"".equals(transactionId)) {
   
     
                    //设置事务id为uniqId
                    msg.setTransactionId(transactionId);
                }
                //如果存在本地事务执行器，现在一般都没有使用这个组件
                if (null != localTransactionExecuter) {
   
     
                    //那么通过本地事务执行器执行本地事务
                    localTransactionState = localTransactionExecuter.executeLocalTransactionBranch(msg, arg);
                }
                //否则，如果存在事务监听器，现在一般都使用事务监听器
                else if (transactionListener != null) {
   
     
                    log.debug("Used new transaction API");
                    //通过transactionListener#executeLocalTransaction方法执行本地事务，获取本地事务状态
                    localTransactionState = transactionListener.executeLocalTransaction(msg, arg);
                }
                //如果返回null，那么算作UNKNOW状态
                if (null == localTransactionState) {
   
     
                    localTransactionState = LocalTransactionState.UNKNOW;
                }
                //如果事务状态不是COMMIT_MESSAGE，那么输出日志
                if (localTransactionState != LocalTransactionState.COMMIT_MESSAGE) {
   
     
                    log.info("executeLocalTransactionBranch return {}", localTransactionState);
                    log.info(msg.toString());
                }
            } catch (Throwable e) {
   
     
                //记录异常
                log.info("executeLocalTransactionBranch exception", e);
                log.info(msg.toString());
                localException = e;
            }
        }
        break;

        //消息发送成功但是服务器刷盘超时。
        case FLUSH_DISK_TIMEOUT:
            //消息发送成功，但是服务器同步到Slave时超时。
        case FLUSH_SLAVE_TIMEOUT:
            //消息发送成功，但是此时Slave不可用。
        case SLAVE_NOT_AVAILABLE:
            //如果是以上状态，设置本地事务状态为ROLLBACK_MESSAGE，即回滚
            localTransactionState = LocalTransactionState.ROLLBACK_MESSAGE;
            break;
        default:
            break;
    }
    /*
     * 第二阶段 事务的commit或者rollback
     */
    try {
   
     
        this.endTransaction(msg, sendResult, localTransactionState, localException);
    } catch (Exception e) {
   
     
        log.warn("local transaction execute " + localTransactionState + ", but end broker transaction failed", e);
    }

    //返回事务消息发送结果
    TransactionSendResult transactionSendResult = new TransactionSendResult();
    transactionSendResult.setSendStatus(sendResult.getSendStatus());
    transactionSendResult.setMessageQueue(sendResult.getMessageQueue());
    transactionSendResult.setMsgId(sendResult.getMsgId());
    transactionSendResult.setQueueOffset(sendResult.getQueueOffset());
    transactionSendResult.setTransactionId(sendResult.getTransactionId());
    transactionSendResult.setLocalTransactionState(localTransactionState);
    return transactionSendResult;
}
```

## 3 broker处理half半消息

由于事务half半发送的方法和普通同步消息的发送方法是同一个send方法，因为他们的主要流程都是相同的，而我们此前在Producer发送消息源码部分已经讲过普通消息发送的源码了，因为我们这里介绍对于事务消息的特殊处理。

broker通过SendMessageProcessor#asyncSendMessage方法处理来自producer客户端的单条消息，在该方法中会对事务消息和普通消息进行区分并分别处理。

```java
/**
 * SendMessageProcessor的方法
 * <p>
 * 处理单条消息
 */
private CompletableFuture<RemotingCommand> asyncSendMessage(ChannelHandlerContext ctx, RemotingCommand request,
                                                            SendMessageContext mqtraceContext,
                                                            SendMessageRequestHeader requestHeader) {
   
     

    CompletableFuture<PutMessageResult> putMessageResult = null;
    /*
     * 处理事务消息逻辑
     */
    //TRAN_MSG属性值为true，表示为事务消息
    String transFlag = origProps.get(MessageConst.PROPERTY_TRANSACTION_PREPARED);
    //处理事务消息
    if (transFlag != null && Boolean.parseBoolean(transFlag)) {
   
     
        //判断是否需要拒绝事务消息，如果需要拒绝，则返回NO_PERMISSION异常
        if (this.brokerController.getBrokerConfig().isRejectTransactionMessage()) {
   
     
            response.setCode(ResponseCode.NO_PERMISSION);
            response.setRemark(
                    "the broker[" + this.brokerController.getBrokerConfig().getBrokerIP1()
                            + "] sending transaction message is forbidden");
            return CompletableFuture.completedFuture(response);
        }
        //调用asyncPrepareMessage方法以异步的方式处理事务准备消息，存储消息
        putMessageResult = this.brokerController.getTransactionalMessageService().asyncPrepareMessage(msgInner);
    } else {
   
     
        //不是事务消息，那么调用asyncPutMessage方法处理，存储消息
        //以异步方式将消息存储到存储器中，处理器可以处理下一个请求而不是等待结果，当结果完成时，以异步方式通知客户端
        putMessageResult = this.brokerController.getMessageStore().asyncPutMessage(msgInner);
    }
    //处理消息存放的结果
    return handlePutMessageResultFuture(putMessageResult, response, request, msgInner, responseHeader, mqtraceContext, ctx, queueIdInt);
}
```

普通消息的处理方法asyncPutMessage源码我们在前面已经讲过了，下面来看看事务消息的处理方法TransactionalMessageService#asyncPrepareMessage的源码。该方法用于处理事务准备消息，也就是half消息。

```java
/**
 * TransactionalMessageServiceImpl的方法
 * 
 * 以异步方式处理事务准备消息
 *
 * @param messageInner 事务准备消息，也就是half消息
 */
@Override
public CompletableFuture<PutMessageResult> asyncPrepareMessage(MessageExtBrokerInner messageInner) {
   
     
    //异步的存放半消息
    return transactionalMessageBridge.asyncPutHalfMessage(messageInner);
}
```

可以看到，内部调用transactionalMessageBridge#asyncPutHalfMessage方法，TransactionalMessageService采用桥接模式，它的操作大多委托给内部的桥接类transactionalMessageBridge。

```java
/**
 * TransactionalMessageBridge的方法
 * <p>
 * 异步的存放半消息
 *
 * @param messageInner 半消息
 */
public CompletableFuture<PutMessageResult> asyncPutHalfMessage(MessageExtBrokerInner messageInner) {
   
     
    //首先调用parseHalfMessageInner方法解析Half消息
    //然后调用asyncPutMessage方法当作普通消息异步存储
    return store.asyncPutMessage(parseHalfMessageInner(messageInner));
}
```

transactionalMessageBridge#asyncPutHalfMessage首先调用parseHalfMessageInner方法解析Half消息，然后调用asyncPutMessage方法当作普通消息异步存储，asyncPutMessage方法的源码我们在broker接收消息部分已经讲过源码了。

```java
/**
 * TransactionalMessageBridge的方法
 * <p>
 * 异步的存放半消息
 *
 * @param messageInner 半消息
 */
public CompletableFuture<PutMessageResult> asyncPutHalfMessage(MessageExtBrokerInner messageInner) {
   
     
    //首先调用parseHalfMessageInner方法解析Half消息
    //然后调用asyncPutMessage方法当作普通消息异步存储
    return store.asyncPutMessage(parseHalfMessageInner(messageInner));
}
```

### 3.1 parseHalfMessageInner解析half消息

parseHalfMessageInner方法解析Half消息，替换为普通消息。采用的是topic和queueId重写的方案，这种方案在RocketMQ中很常见，比如延迟消息也是采用该方案。

保存原始topic和queueId到PROPERTY_REAL_TOPIC以及PROPERTY_REAL_QUEUE_ID属性中，设置topic为半消息topic，固定为RMQ_SYS_TRANS_HALF_TOPIC，设置queueId为0。

当一阶段消息写入成功之后，这条half消息就处于Pending状态，即不确定状态，此时需要等待执行本地事务的结果，然后进入第二阶段通过commit或者是rollBack，来确定这条消息的最终状态。

```java
/**
 * TransactionalMessageBridge的方法
 * <p>
 * 异步的存放半消息
 *
 * @param messageInner 半消息
 */
public CompletableFuture<PutMessageResult> asyncPutHalfMessage(MessageExtBrokerInner messageInner) {
   
     
    //首先调用parseHalfMessageInner方法解析Half消息
    //然后调用asyncPutMessage方法当作普通消息异步存储
    return store.asyncPutMessage(parseHalfMessageInner(messageInner));
}

/**
 * 解析Half消息
 *
 * @param msgInner 半消息
 */
private MessageExtBrokerInner parseHalfMessageInner(MessageExtBrokerInner msgInner) {
   
     
    //使用扩展属性PROPERTY_REAL_TOPIC（REAL_TOPIC） 记录原始topic
    MessageAccessor.putProperty(msgInner, MessageConst.PROPERTY_REAL_TOPIC, msgInner.getTopic());
    //使用扩展属性PROPERTY_REAL_QUEUE_ID（REAL_QID） 记录原始queueId
    MessageAccessor.putProperty(msgInner, MessageConst.PROPERTY_REAL_QUEUE_ID,
            String.valueOf(msgInner.getQueueId()));
    //设置消息系统属性sysFlag为普通消息
    msgInner.setSysFlag(
            MessageSysFlag.resetTransactionValue(msgInner.getSysFlag(), MessageSysFlag.TRANSACTION_NOT_TYPE));
    //设置topic为半消息topic，固定为RMQ_SYS_TRANS_HALF_TOPIC
    msgInner.setTopic(TransactionalMessageUtil.buildHalfTopic());
    //设置queueId为0
    msgInner.setQueueId(0);
    //属性转换为string
    msgInner.setPropertiesString(MessageDecoder.messageProperties2String(msgInner.getProperties()));
    return msgInner;
}
```

## 4 endTransaction结束事务

无论本地事务是否执行成功，都会执行第二阶段endTransaction方法，将会进行事务的commit或者rollback操作。

根据本地事务状态localTransactionState设置commitOrRollback标志，最终发送一个结束事务的单向请求，请求Code为END_TRANSACTION，发送后不管结果，因为broker还有消息回查机制。

```java
/**
 * DefaultMQProducerImpl的方法
 * <p>
 * 结束事务，事务的commit或者rollback
 *
 * @param msg                   事务消息
 * @param sendResult            发送结果
 * @param localTransactionState 本地事务状态
 * @param localException        本地事务执行抛出的异常
 */
public void endTransaction(final Message msg, final SendResult sendResult, final LocalTransactionState localTransactionState, final Throwable localException) throws RemotingException, MQBrokerException, InterruptedException, UnknownHostException {
   
     
    final MessageId id;
    //解码消息id，包含broker地址和offset
    //首先获取offsetMsgId，如果存在则设置为消息id，这是真正的Message Id，是broker生成的唯一id
    //如果没有offsetMsgId，那么设置msgId为消息id，这是客户端生成的唯一id，即uniqId
    if (sendResult.getOffsetMsgId() != null) {
   
     
        id = MessageDecoder.decodeMessageId(sendResult.getOffsetMsgId());
    } else {
   
     
        id = MessageDecoder.decodeMessageId(sendResult.getMsgId());
    }
    //从sendResult获取事务id，一般都是null
    String transactionId = sendResult.getTransactionId();
    //获取broker地址
    final String brokerAddr = this.mQClientFactory.findBrokerAddressInPublish(sendResult.getMessageQueue().getBrokerName());
    //创建结束事务请求头
    EndTransactionRequestHeader requestHeader = new EndTransactionRequestHeader();
    //设置事务id
    requestHeader.setTransactionId(transactionId);
    //设置消息的commitLog偏移量
    requestHeader.setCommitLogOffset(id.getOffset());
    /*
     * 根据本地事务状态，设置broker事务消息提交或者回滚
     */
    switch (localTransactionState) {
   
     
        //本地事务成功
        case COMMIT_MESSAGE:
            //提交
            requestHeader.setCommitOrRollback(MessageSysFlag.TRANSACTION_COMMIT_TYPE);
            break;
        //本地事务回滚
        case ROLLBACK_MESSAGE:
            //回滚
            requestHeader.setCommitOrRollback(MessageSysFlag.TRANSACTION_ROLLBACK_TYPE);
            break;
            //未知状态
        case UNKNOW:
            requestHeader.setCommitOrRollback(MessageSysFlag.TRANSACTION_NOT_TYPE);
            break;
        default:
            break;
    }
    //执行钩子函数，一般没有钩子
    doExecuteEndTransactionHook(msg, sendResult.getMsgId(), brokerAddr, localTransactionState, false);
    //设置生产者组
    requestHeader.setProducerGroup(this.defaultMQProducer.getProducerGroup());
    //事务消息在queue中的偏移量
    requestHeader.setTranStateTableOffset(sendResult.getQueueOffset());
    //设置msgId，即uniqId
    requestHeader.setMsgId(sendResult.getMsgId());
    String remark = localException != null ? ("executeLocalTransactionBranch exception: " + localException.toString()) : null;
    //发送结束事务单向请求
    this.mQClientFactory.getMQClientAPIImpl().endTransactionOneway(brokerAddr, requestHeader, remark, this.defaultMQProducer.getSendMsgTimeout());
}

/**
 * MQClientAPIImpl的方法
 *
 * @param addr          broker地址
 * @param requestHeader 请求头
 * @param remark        本地事务执行抛出的异常
 * @param timeoutMillis 超时时间
 * @throws RemotingException
 * @throws MQBrokerException
 * @throws InterruptedException
 */
public void endTransactionOneway(
        final String addr,
        final EndTransactionRequestHeader requestHeader,
        final String remark,
        final long timeoutMillis
) throws RemotingException, MQBrokerException, InterruptedException {
   
     
    //请求Code为END_TRANSACTION
    RemotingCommand request = RemotingCommand.createRequestCommand(RequestCode.END_TRANSACTION, requestHeader);

    request.setRemark(remark);
    this.remotingClient.invokeOneway(addr, request, timeoutMillis);
}
```

关于msgId和offsetMsgId：
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162130990.png)

## 5 broker处理结束事务消息

*
*broker启动的时候，在BrokerController#registerProcessor的方法中会注册各种请求处理器，其中结束事务请求（Code为END_TRANSACTION）由EndTransactionProcessor处理器并且在专门的线程池endTransactionExecutor中处理。
**
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162130007.png)
EndTransactionProcessor的processRequest方法是处理END_TRANSACTION请求的入口方法，处理事务消息的提交或者回滚。大概逻辑为：

**1、** 如果是SLAVEbroker，直接返回，只有MASTERbroker能够处理事务消息；
**2、** 判断本地事务执行状态，如果是TRANSACTION_NOT_TYPE，那么表示本地事务没有结果，可能是还在等待事务结束，broker将不会不进行任何处理，直接返回；
**3、** 如果commitOrRollback为TRANSACTION_COMMIT_TYPE，那么需要提交事务；

**1、** 通过commitMessage方法提交half消息，但实际上仅仅是根据commitLogOffset查询half消息；
**2、** 通过checkPrepareMessage检查half消息；
**3、** 还原原始的消息，恢复topic和queueId为原始的数据，然后调用sendFinalMessage将原始消息发送到目的topic，稍后即可被消费者消费到；
**4、** 如果发送成功，调用deletePrepareMessage方法删除half消息，实际上是写入Op消息；
**4、** 如果commitOrRollback为TRANSACTION_ROLLBACK_TYPE，那么需要回滚事务通过；

**1、** rollbackMessage方法回滚half消息，但实际上仅仅是根据commitLogOffset查询half消息；
**2、** 通过checkPrepareMessage检查half消息；
**3、** 调用deletePrepareMessage方法删除half消息，实际上是写入Op消息；

```java
/**
 * EndTransactionProcessor的方法
 * <p>
 * 处理END_TRANSACTION请求，处理事务消息的提交或者回滚
 */
@Override
public RemotingCommand processRequest(ChannelHandlerContext ctx, RemotingCommand request) throws
        RemotingCommandException {
   
     
    final RemotingCommand response = RemotingCommand.createResponseCommand(null);
    //解析请求头
    final EndTransactionRequestHeader requestHeader =
            (EndTransactionRequestHeader) request.decodeCommandCustomHeader(EndTransactionRequestHeader.class);
    LOGGER.debug("Transaction request:{}", requestHeader);
    //1 如果是SLAVE broker，直接返回，只有MASTER broker能够处理事务消息
    if (BrokerRole.SLAVE == brokerController.getMessageStoreConfig().getBrokerRole()) {
   
     
        response.setCode(ResponseCode.SLAVE_NOT_AVAILABLE);
        LOGGER.warn("Message store is slave mode, so end transaction is forbidden. ");
        return response;
    }
    /*
     * 2 判断本地事务执行状态，如果是TRANSACTION_NOT_TYPE，那么表示本地事务没有结果，可能是还在等待事务结束，broker将不会不进行任何处理，直接返回
     */
    //如果当前请求来自于事务回查消息
    if (requestHeader.getFromTransactionCheck()) {
   
     
        switch (requestHeader.getCommitOrRollback()) {
   
     
            //事务回查没有结果，可能是还在等待事务结束，broker不进行任何处理，直接返回
            case MessageSysFlag.TRANSACTION_NOT_TYPE: {
   
     
                LOGGER.warn("Check producer[{}] transaction state, but it's pending status."
                                + "RequestHeader: {} Remark: {}",
                        RemotingHelper.parseChannelRemoteAddr(ctx.channel()),
                        requestHeader.toString(),
                        request.getRemark());
                return null;
            }
            //事务回查结果为提交，将会提交该消息
            case MessageSysFlag.TRANSACTION_COMMIT_TYPE: {
   
     
                LOGGER.warn("Check producer[{}] transaction state, the producer commit the message."
                                + "RequestHeader: {} Remark: {}",
                        RemotingHelper.parseChannelRemoteAddr(ctx.channel()),
                        requestHeader.toString(),
                        request.getRemark());

                break;
            }
            //事务回查结果为回滚，将会回滚该消息
            case MessageSysFlag.TRANSACTION_ROLLBACK_TYPE: {
   
     
                LOGGER.warn("Check producer[{}] transaction state, the producer rollback the message."
                                + "RequestHeader: {} Remark: {}",
                        RemotingHelper.parseChannelRemoteAddr(ctx.channel()),
                        requestHeader.toString(),
                        request.getRemark());
                break;
            }
            default:
                return null;
        }
    }
    //如果当前请求来自于二阶段endTransaction结束事务消息
    else {
   
     
        switch (requestHeader.getCommitOrRollback()) {
   
     
            //本地事务状态没有结果，可能是还在等待事务结束，broker不进行任何处理，直接返回
            case MessageSysFlag.TRANSACTION_NOT_TYPE: {
   
     
                LOGGER.warn("The producer[{}] end transaction in sending message,  and it's pending status."
                                + "RequestHeader: {} Remark: {}",
                        RemotingHelper.parseChannelRemoteAddr(ctx.channel()),
                        requestHeader.toString(),
                        request.getRemark());
                return null;
            }
            //本地事务结果为提交，将会提交该消息
            case MessageSysFlag.TRANSACTION_COMMIT_TYPE: {
   
     
                break;
            }
            //本地事务结果为回滚，将会回滚该消息
            case MessageSysFlag.TRANSACTION_ROLLBACK_TYPE: {
   
     
                LOGGER.warn("The producer[{}] end transaction in sending message, rollback the message."
                                + "RequestHeader: {} Remark: {}",
                        RemotingHelper.parseChannelRemoteAddr(ctx.channel()),
                        requestHeader.toString(),
                        request.getRemark());
                break;
            }
            default:
                return null;
        }
    }

    OperationResult result = new OperationResult();
    /*
     * 3 提交事务
     */
    if (MessageSysFlag.TRANSACTION_COMMIT_TYPE == requestHeader.getCommitOrRollback()) {
   
     
        /*
         * 提交half消息，但实际上仅仅是根据commitLogOffset查询half消息
         */
        result = this.brokerController.getTransactionalMessageService().commitMessage(requestHeader);
        //查询到half消息
        if (result.getResponseCode() == ResponseCode.SUCCESS) {
   
     
            //检查half消息
            RemotingCommand res = checkPrepareMessage(result.getPrepareMessage(), requestHeader);
            //检查通过
            if (res.getCode() == ResponseCode.SUCCESS) {
   
     
                /*
                 * 还原原始的消息
                 */
                MessageExtBrokerInner msgInner = endMessageTransaction(result.getPrepareMessage());
                //设置系统标记。重置事物标记
                msgInner.setSysFlag(MessageSysFlag.resetTransactionValue(msgInner.getSysFlag(), requestHeader.getCommitOrRollback()));
                msgInner.setQueueOffset(requestHeader.getTranStateTableOffset());
                msgInner.setPreparedTransactionOffset(requestHeader.getCommitLogOffset());
                msgInner.setStoreTimestamp(result.getPrepareMessage().getStoreTimestamp());
                MessageAccessor.clearProperty(msgInner, MessageConst.PROPERTY_TRANSACTION_PREPARED);
                /*
                 * 内部调用asyncPutMessage方法发送消息到原始的topic，随后consumer可以消费到该消息
                 */
                RemotingCommand sendResult = sendFinalMessage(msgInner);
                //如果发送成功
                if (sendResult.getCode() == ResponseCode.SUCCESS) {
   
     
                    /*
                     * 删除half消息
                     */
                    this.brokerController.getTransactionalMessageService().deletePrepareMessage(result.getPrepareMessage());
                }
                return sendResult;
            }
            return res;
        }
    }
    /*
     * 4 回滚事务
     */
    else if (MessageSysFlag.TRANSACTION_ROLLBACK_TYPE == requestHeader.getCommitOrRollback()) {
   
     
        /*
         * 回滚half消息，但实际上仅仅是根据commitLogOffset查询half消息
         */
        result = this.brokerController.getTransactionalMessageService().rollbackMessage(requestHeader);
        //查询到half消息
        if (result.getResponseCode() == ResponseCode.SUCCESS) {
   
     
            //检查half消息
            RemotingCommand res = checkPrepareMessage(result.getPrepareMessage(), requestHeader);
            //检查通过
            if (res.getCode() == ResponseCode.SUCCESS) {
   
     
                /*
                 * 删除half消息
                 */
                this.brokerController.getTransactionalMessageService().deletePrepareMessage(result.getPrepareMessage());
            }
            return res;
        }
    }
    response.setCode(result.getResponseCode());
    response.setRemark(result.getResponseRemark());
    return response;
}
```

### 5.1 commitMessage提交half半消息

提交half消息，但实际上仅仅是根据commitLogOffset查询half消息，下面的rollbackMessage方法回滚half消息，实际上也是仅仅是根据commitLogOffset查询half消息。

```java
/**
 * TransactionalMessageServiceImpl的方法
 * <p>
 * 提交half消息，但实际上仅仅是根据commitLogOffset查询half消息
 */
@Override
public OperationResult commitMessage(EndTransactionRequestHeader requestHeader) {
   
     
    //根据commitLogOffset查询half消息
    return getHalfMessageByOffset(requestHeader.getCommitLogOffset());
}

/**
 * TransactionalMessageServiceImpl的方法
 * <p>
 * 回滚half消息，但实际上仅仅是根据commitLogOffset查询half消息
 */
@Override
public OperationResult rollbackMessage(EndTransactionRequestHeader requestHeader) {
   
     
    //根据commitLogOffset查询half消息
    return getHalfMessageByOffset(requestHeader.getCommitLogOffset());
}

/**
 * TransactionalMessageServiceImpl的方法
 * <p>
 * 根据commitLogOffset查询half消息
 */
private OperationResult getHalfMessageByOffset(long commitLogOffset) {
   
     
    OperationResult response = new OperationResult();
    //根据commitLogOffset查询half消息
    MessageExt messageExt = this.transactionalMessageBridge.lookMessageByOffset(commitLogOffset);
    //找到了消息就设置SUCCESS
    if (messageExt != null) {
   
     
        response.setPrepareMessage(messageExt);
        response.setResponseCode(ResponseCode.SUCCESS);
    } else {
   
     
        response.setResponseCode(ResponseCode.SYSTEM_ERROR);
        response.setResponseRemark("Find prepared transaction message failed");
    }
    return response;
}
```

### 5.2 checkPrepareMessage检查half半消息

检查half半消息，要求请求中的生产者组、消息的ConsumeQueue offset、消息的CommitLog offset都要和找到的消息中的属性一致。

```java
/**
 * TransactionalMessageServiceImpl
 * <p>
 * 检查half消息
 *
 * @param msgExt        half消息
 * @param requestHeader 请求头
 */
private RemotingCommand checkPrepareMessage(MessageExt msgExt, EndTransactionRequestHeader requestHeader) {
   
     
    final RemotingCommand response = RemotingCommand.createResponseCommand(null);
    if (msgExt != null) {
   
     
        //获取生产者组
        final String pgroupRead = msgExt.getProperty(MessageConst.PROPERTY_PRODUCER_GROUP);
        //如果消息的生产者组和请求头中的producerGroup不一致，则检查失败
        if (!pgroupRead.equals(requestHeader.getProducerGroup())) {
   
     
            response.setCode(ResponseCode.SYSTEM_ERROR);
            response.setRemark("The producer group wrong");
            return response;
        }
        //如果消息的ConsumeQueue offset和请求头中的offset不一致，则检查失败
        if (msgExt.getQueueOffset() != requestHeader.getTranStateTableOffset()) {
   
     
            response.setCode(ResponseCode.SYSTEM_ERROR);
            response.setRemark("The transaction state table offset wrong");
            return response;
        }
        //如果消息的CommitLog offset和请求头中的CommitLogOffset不一致，则检查失败
        if (msgExt.getCommitLogOffset() != requestHeader.getCommitLogOffset()) {
   
     
            response.setCode(ResponseCode.SYSTEM_ERROR);
            response.setRemark("The commit log offset wrong");
            return response;
        }
    } else {
   
     
        response.setCode(ResponseCode.SYSTEM_ERROR);
        response.setRemark("Find prepared transaction message failed");
        return response;
    }
    response.setCode(ResponseCode.SUCCESS);
    return response;
}
```

### 5.3 endMessageTransaction还原原始消息

该方法还原原始消息，在发送half消息的时候，将原始的topic和queueId存放到了PROPERTY_REAL_TOPIC以及PROPERTY_REAL_QUEUE_ID属性中，现在需要将其还原。

```java
/**
 * EndTransactionProcessor的方法
 *
 * 还原原始消息
 * @param msgExt 事物消息
 */
private MessageExtBrokerInner endMessageTransaction(MessageExt msgExt) {
   
     
    MessageExtBrokerInner msgInner = new MessageExtBrokerInner();
    //设置topic为原始topic
    msgInner.setTopic(msgExt.getUserProperty(MessageConst.PROPERTY_REAL_TOPIC));
    //设置queueId为原始id
    msgInner.setQueueId(Integer.parseInt(msgExt.getUserProperty(MessageConst.PROPERTY_REAL_QUEUE_ID)));
    msgInner.setBody(msgExt.getBody());
    msgInner.setFlag(msgExt.getFlag());
    msgInner.setBornTimestamp(msgExt.getBornTimestamp());
    msgInner.setBornHost(msgExt.getBornHost());
    msgInner.setStoreHost(msgExt.getStoreHost());
    msgInner.setReconsumeTimes(msgExt.getReconsumeTimes());
    msgInner.setWaitStoreMsgOK(false);
    //设置消息事物id，即客户端生成的uniqId
    msgInner.setTransactionId(msgExt.getUserProperty(MessageConst.PROPERTY_UNIQ_CLIENT_MESSAGE_ID_KEYIDX));
    msgInner.setSysFlag(msgExt.getSysFlag());
    TopicFilterType topicFilterType =
            (msgInner.getSysFlag() & MessageSysFlag.MULTI_TAGS_FLAG) == MessageSysFlag.MULTI_TAGS_FLAG ? TopicFilterType.MULTI_TAG
                    : TopicFilterType.SINGLE_TAG;
    //生成tagsCode
    long tagsCodeValue = MessageExtBrokerInner.tagsString2tagsCode(topicFilterType, msgInner.getTags());
    msgInner.setTagsCode(tagsCodeValue);
    MessageAccessor.setProperties(msgInner, msgExt.getProperties());
    msgInner.setPropertiesString(MessageDecoder.messageProperties2String(msgExt.getProperties()));
    //清除没用的属性
    MessageAccessor.clearProperty(msgInner, MessageConst.PROPERTY_REAL_TOPIC);
    MessageAccessor.clearProperty(msgInner, MessageConst.PROPERTY_REAL_QUEUE_ID);
    return msgInner;
}
```

### 5.4 sendFinalMessage发送最终消息

当还原了原始消息之后，调用EndTransactionProcessor#sendFinalMessage方法发送最终消息。

内部调用的MessageStore#putMessage方法发送消息，该方法内部实现为：调用asyncPutMessage方法异步发送消息，调用putMessageResultFuture#get方法同步等待结果。

```java
/**
 * EndTransactionProcessor的方法
 * <p>
 * 内部调用asyncPutMessage方法发送消息到原始的topic，随后consumer可以消费到该消息
 */
private RemotingCommand sendFinalMessage(MessageExtBrokerInner msgInner) {
   
     
    final RemotingCommand response = RemotingCommand.createResponseCommand(null);
    /*
     * 同步的将最终的消息发送到原始的topic，随后consumer可以消费到该消息
     * 内部实现为：调用asyncPutMessage方法异步发送消息，调用putMessageResultFuture#get方法同步等待结果
     */
    final PutMessageResult putMessageResult = this.brokerController.getMessageStore().putMessage(msgInner);
    //处理响应结果
    if (putMessageResult != null) {
   
     
        switch (putMessageResult.getPutMessageStatus()) {
   
     
            // Success
            case PUT_OK:
            case FLUSH_DISK_TIMEOUT:
            case FLUSH_SLAVE_TIMEOUT:
            case SLAVE_NOT_AVAILABLE:
                response.setCode(ResponseCode.SUCCESS);
                response.setRemark(null);
                break;
            // Failed
            case CREATE_MAPEDFILE_FAILED:
                response.setCode(ResponseCode.SYSTEM_ERROR);
                response.setRemark("Create mapped file failed.");
                break;
            case MESSAGE_ILLEGAL:
            case PROPERTIES_SIZE_EXCEEDED:
                response.setCode(ResponseCode.MESSAGE_ILLEGAL);
                response.setRemark("The message is illegal, maybe msg body or properties length not matched. msg body length limit 128k, msg properties length limit 32k.");
                break;
            case SERVICE_NOT_AVAILABLE:
                response.setCode(ResponseCode.SERVICE_NOT_AVAILABLE);
                response.setRemark("Service not available now.");
                break;
            case OS_PAGECACHE_BUSY:
                response.setCode(ResponseCode.SYSTEM_ERROR);
                response.setRemark("OS page cache busy, please try another machine");
                break;
            case UNKNOWN_ERROR:
                response.setCode(ResponseCode.SYSTEM_ERROR);
                response.setRemark("UNKNOWN_ERROR");
                break;
            default:
                response.setCode(ResponseCode.SYSTEM_ERROR);
                response.setRemark("UNKNOWN_ERROR DEFAULT");
                break;
        }
        return response;
    } else {
   
     
        response.setCode(ResponseCode.SYSTEM_ERROR);
        response.setRemark("store putMessage return null");
    }
    return response;
}
```

### 5.5 deletePrepareMessage删除half消息

该方法内部调用transactionalMessageBridge#putOpMessage方法写入事务Op消息，opType为“d”，用来实现“删除”half消息的效果。

```java
/**
 * TransactionalMessageServiceImpl的方法
 * <p>
 * 当提交或回滚消息时，删除half消息，Op消息的逻辑
 *
 * @param msgExt half消息
 */
@Override
public boolean deletePrepareMessage(MessageExt msgExt) {
   
     
    //写入事务Op消息
    if (this.transactionalMessageBridge.putOpMessage(msgExt, TransactionalMessageUtil.REMOVETAG)) {
   
     
        log.debug("Transaction op message write successfully. messageId={}, queueId={} msgExt:{}", msgExt.getMsgId(), msgExt.getQueueId(), msgExt);
        return true;
    } else {
   
     
        log.error("Transaction op message write failed. messageId is {}, queueId is {}", msgExt.getMsgId(), msgExt.getQueueId());
        return false;
    }
}
```

#### 5.5.1 putOpMessage写入Op事务消息

**该方法用于写入事务Op消息。大概步骤为：**

**1、** 构建一个messageQueue，topic为half消息的topic：固定为RMQ_SYS_TRANS_HALF_TOPIC，queueId为half消息的topic：固定为0，此为对应的half消息队列；
**2、** 调用addRemoveTagInTransactionOp方法，写入Op消息到half消息队列对应的Op消息队列中；

**1、** 构建一条Op消息，topic为RMQ_SYS_TRANS_OP_HALF_TOPIC，tags为“d”，body为对应的half消息在half消息队列的相对偏移量；
**2、** 调用writeOp方法，将Op消息写入对应的Op消息队列；

```
1.  从opQueueMap缓存中，获取half消息队列对应的Op消息队列，没有就创建。如果没有找到则创建新的Op消息队列，topic为RMQ\_SYS\_TRANS\_OP\_HALF\_TOPIC，brokerName和queueId和对应的half消息队列的属性一致。
    2.  将Op消息存入该Op消息队列中，内部调用的MessageStore\#putMessage方法发送消息。
```

*
*实际上，RocketMQ无法真正的删除一条消息，因为消息都是顺序写入commitLog文件中的，但是为了区别于这条消息的没有确定的状态（Pending），需要一个操作来标识这条消息的最终状态，或者说标记这条消息已完成commit或者rollback操作。
**

**RocketMQ事务消息方案中引入了Op消息的概念，用Op消息标识事务消息已经确定的状态（Commit或者Rollback）。如果一条事务消息没有对应的Op消息，说明这个事务的状态还无法确定（可能是二阶段失败了）。
**

**从这里的源码可以得知，Op消息的topic为RMQ_SYS_TRANS_OP_HALF_TOPIC，tags为“d”，body为对应的half消息在half
消息队列的相对偏移量。每一个half消息都有一个对应的Op消息，每一个half消息队列都有一个对应的Op消息队列，对应消息队列的queueId和brokerName是相同的，这样就能快速进行查找。
**

```java
/**
 * TransactionalMessageBridge的方法
 * <p>
 * 写入事务Op消息
 *
 * @param messageExt half消息
 * @param opType     Op标记 “d”
 * @return
 */
public boolean putOpMessage(MessageExt messageExt, String opType) {
   
     
    //构建一个messageQueue，topic为half消息的topic：固定为RMQ_SYS_TRANS_HALF_TOPIC，queueId为half消息的topic：固定为0，此为对应的half消息队列
    MessageQueue messageQueue = new MessageQueue(messageExt.getTopic(),
            this.brokerController.getBrokerConfig().getBrokerName(), messageExt.getQueueId());
    //如果是“d”
    if (TransactionalMessageUtil.REMOVETAG.equals(opType)) {
   
     
        //那么写入Op消息到messageQueue
        return addRemoveTagInTransactionOp(messageExt, messageQueue);
    }
    return true;
}
/**
 * TransactionalMessageBridge的方法
 * <p>
 * 在提交事务或回滚时向OpMessageQueue写入Op消息，tags为“d”
 *
 * @param prepareMessage half消息
 * @param messageQueue   half消息队列
 * @return 总会返回true
 */
private boolean addRemoveTagInTransactionOp(MessageExt prepareMessage, MessageQueue messageQueue) {
   
     
    //构建一条Op消息，topic为RMQ_SYS_TRANS_OP_HALF_TOPIC，tags为“d”，body为 对应的half消息在half consumeQueue的相对偏移量
    Message message = new Message(TransactionalMessageUtil.buildOpTopic(), TransactionalMessageUtil.REMOVETAG,
            String.valueOf(prepareMessage.getQueueOffset()).getBytes(TransactionalMessageUtil.charset));
    //将Op消息写入对应的Op messageQueue
    writeOp(message, messageQueue);
    return true;
}

/**
 * TransactionalMessageBridge的方法
 * <p>
 * 写入Op消息
 *
 * @param message Op消息
 * @param mq      Op消息对应的half消息队列
 */
private void writeOp(Message message, MessageQueue mq) {
   
     
    //从opQueueMap缓存中，获取half消息队列对应的Op消息队列，没有就创建
    //从这里可知，每一个half消息都有一个对应的Op消息，每一个half消息队列都有一个对应的Op消息队列，这样就能快速进行查找
    MessageQueue opQueue;
    if (opQueueMap.containsKey(mq)) {
   
     
        opQueue = opQueueMap.get(mq);
    } else {
   
     
        //如果没有找到则创建新的Op消息队列，topic为RMQ_SYS_TRANS_OP_HALF_TOPIC，brokerName和queueId和对应的half消息队列的属性一致
        opQueue = getOpQueueByHalf(mq);
        MessageQueue oldQueue = opQueueMap.putIfAbsent(mq, opQueue);
        if (oldQueue != null) {
   
     
            opQueue = oldQueue;
        }
    }
    //创建新的Op消息队列，topic为RMQ_SYS_TRANS_OP_HALF_TOPIC，brokerName和queueId和对应的half消息队列的属性一致
    if (opQueue == null) {
   
     
        opQueue = new MessageQueue(TransactionalMessageUtil.buildOpTopic(), mq.getBrokerName(), mq.getQueueId());
    }
    //将Op消息存入该Op消息队列中，内部调用的MessageStore#putMessage方法发送消息
    putMessage(makeOpMessageInner(message, opQueue));
}

/**
 * TransactionalMessageBridge的方法
 * <p>
 * 基于half消息队列获取Op消息队列
 *
 * @param halfMQ half消息队列
 * @return Op消息队列
 */
private MessageQueue getOpQueueByHalf(MessageQueue halfMQ) {
   
     
    MessageQueue opQueue = new MessageQueue();
    //topic为RMQ_SYS_TRANS_OP_HALF_TOPIC
    opQueue.setTopic(TransactionalMessageUtil.buildOpTopic());
    //brokerName为half消息队列的brokerName
    opQueue.setBrokerName(halfMQ.getBrokerName());
    //queueId为half消息队列的queueId
    opQueue.setQueueId(halfMQ.getQueueId());
    return opQueue;
}
```

## 6 broker消息回查

*
*在上面的broker处理结束事务请求（Code为END_TRANSACTION）的流程中，我们知道对于commitOrRollback属性为TRANSACTION_COMMIT_TYPE或者TRANSACTION_ROLLBACK_TYPE的结果将会进行commit和rollback操作，并且发送到Op
topic中，表示该事务结束。**

*
*但是，对于commitOrRollback属性为TRANSACTION_NOT_TYPE的情况，比如本地事务执行返回null的时候，此时broker并没有处理就直接返回了，也就是说对于这种情况，并没有立即对事物进行commit或者rollback，此时事务还是处于pending状态，那么这种情况下该事务就一直处于这个状态了吗？显然并不是，RocketMQ会利用事务回查机制进行回查，这是一种补偿机制，用于确定处于pending状态的事务的最终状态。
**

### 6.1 TransactionalMessageCheckService事务回查服务

RocketMQ的事务回查使用一个单独的服务TransactionalMessageCheckService来操作。

在broker启动过程中，在BrokerController#initialize方法中的initialTransaction方法会初始化事务相关的服务，其中就会创建事务回查服务对象。
![*](https://cloud.cxykk.com/images/2024/3/23/2250/1711205439839.png)
在BrokerController#start方法中会执行startProcessorByHa方法，该方法会对TransactionalMessageCheckService服务进行启动，即调用它的start方法。
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162130720.png)
start方法中将会启动该服务内部的线程，线程任务就是实现消息回查的关键。

```java
/**
 * TransactionalMessageCheckService的方法
 */
@Override
public void run() {
   
     
    log.info("Start transaction check service thread!");
    //获取事务回查时间间隔，默认60s，可通过broker.conf配置transactionCheckInterval属性更改
    long checkInterval = brokerController.getBrokerConfig().getTransactionCheckInterval();
    //循环回查
    while (!this.isStopped()) {
   
     
        //最多等待60s执行一次回查
        this.waitForRunning(checkInterval);
    }
    log.info("End transaction check service thread!");
}

/**
 * 被唤醒或者等待时间到了之后，执行事务回查
 */
@Override
protected void onWaitEnd() {
   
     
    //事务超时时间，默认6s，即超过6s还没有被commit或者rollback的事物消息将会进行回查，可通过broker.conf配置transactionTimeOut属性更改
    long timeout = brokerController.getBrokerConfig().getTransactionTimeOut();
    //事务回查最大次数，默认15，超过次数则丢弃消息，可通过broker.conf配置transactionCheckMax属性更改
    int checkMax = brokerController.getBrokerConfig().getTransactionCheckMax();
    long begin = System.currentTimeMillis();
    log.info("Begin to check prepare message, begin time:{}", begin);
    //执行事务回查
    this.brokerController.getTransactionalMessageService().check(timeout, checkMax, this.brokerController.getTransactionalMessageCheckListener());
    log.info("End to check prepare message, consumed time:{}", System.currentTimeMillis() - begin);
}
```

可以看到，这个线程任务内部是一个循环，首先获取事务回查时间间隔，默认60s，可通过broker.conf配置transactionCheckInterval属性更改，即每隔60s进行一次失误回查。

首先需要获取broker端的事务超时时间，默认6s，即超过6s还没有被commit或者rollback的事物消息将会进行回查，可通过broker.conf配置transactionTimeOut属性更改，还要获取事务回查最大次数，默认15，超过次数则丢弃消息，可通过broker.conf配置transactionCheckMax属性更改。然后调用TransactionalMessageService#check方法进行事物检查和回查。

### 6.2 check检查事物消息

TransactionalMessageService#check方法进行事物检查和回查。大概逻辑为：

**1、** 获取事物half消息的topicRMQ_SYS_TRANS_HALF_TOPIC下的所有mq，默认就一个遍历事物half消息的mq，依次进行检测；
**2、** 调用getOpQueue方法，获取half消息队列对应的Op消息队列，half消息队列和Op消息队列是一一对应的关系；
**3、** 获取内部消费者组CID_SYS_RMQ_TRANS对于该halfmq的消费偏移量halfOffset，获取内部消费者组CID_SYS_RMQ_TRANS对于该Opmq的消费偏移量opOffset；
**4、** 调用fillOpRemoveMap方法，根据halfOffset和opOffset，一次性拉取最多32条op消息，填充removeMap和doneOpOffset，找出已处理的half消息，避免重复发送事物状态回查请求；
**5、** 没有拉取到消息则该mq检测结束，拉取到了op消息则从最新消费的halfOffset开始循环进行检测；
**6、** 每一轮消息回查最多进行60s，超时就退出，检测下一个half队列；
**7、** 如果removeMap中已包含该offset，从removeMap移除并且加入到doneOpOffset，那么表示已经确定了的事物消息，无需回查；
**8、** 否则，表示可能需要回查；

**1、** 调用getHalfMsg方法，根据offset查询该half事物消息；

2.
通过needDiscard和needSkip判断是否需要丢弃、跳过该消息，如果是则通过listener#resolveDiscardMsg方法丢弃该half消息，即将消息存入TRANS_CHECK_MAX_TIME_TOPIC这个内部topic中，然后检测下一个iehalf消息。

**3、** 判断如果消息存储时间大于本次回查开始时间，那么本消息队列回查结束；
**4、**
判断当前事务消息是否到达超时时间，超时后才会检测，否则说明还没到事务回查的时候，当前mq的回查结束事务消息的超时时间，默认为6s，这个时间是broker中设置的，consumer也可以为每个事务消息设置超时时间，通过PROPERTY_CHECK_IMMUNITY_TIME_IN_SECONDS属性，如果又改属性，那么以它的值为准；
**5、**
最后判断是否需要回查如果拉取的op消息为null并且当前消息存储的时间大于事务超时时间，或者拉取的op消息不为null并且最后一个op消息的发送存储时减去起始时间的结果大于事务超时时间，或者当前时间小于当前消息发送时间戳，这3种情况都会检测；

6. 如果需要回查，那么首先将该消息再次存入half队列，然后通过listener#resolveHalfMsg向consumer客户端发起一个单向消息回查请求。

**7、** 如果不需要执行回查，那么从已拉取的op消息的下一个offset开始，再次执行fillOpRemoveMap方法，拉取下一轮的op消息，继续下一个循环检测；
**9、** 回查完毕之后，更新half消息队列偏移量，更新op消息队列偏移量；

```java
/**
 * TransactionalMessageServiceImpl的方法
 * <p>
 * 执行事务检查和回查
 *
 * @param transactionTimeout  事务超时时间，默认6s，即超过6s还没有被commit或者rollback的事物消息将会进行回查
 * @param transactionCheckMax 消息被检查的最大次数，默认15，如果超过该值，该消息将被丢弃
 * @param listener            当需要发起回查或者丢弃消息时，会调用相应的方法
 */
@Override
public void check(long transactionTimeout, int transactionCheckMax,
                  AbstractTransactionalMessageCheckListener listener) {
   
     
    try {
   
     
        /*
         * 1 获取事物half消息的topic RMQ_SYS_TRANS_HALF_TOPIC下的所有mq，默认就一个
         */
        //事物half消息的topic
        String topic = TopicValidator.RMQ_SYS_TRANS_HALF_TOPIC;
        //获取该topic下的所有mq，默认就一个
        Set<MessageQueue> msgQueues = transactionalMessageBridge.fetchMessageQueues(topic);
        if (msgQueues == null || msgQueues.size() == 0) {
   
     
            log.warn("The queue of topic is empty :" + topic);
            return;
        }
        log.debug("Check topic={}, queues={}", topic, msgQueues);
        /*
         * 2 遍历事物half消息的mq，依次进行检测
         */
        for (MessageQueue messageQueue : msgQueues) {
   
     
            //起始时间
            long startTime = System.currentTimeMillis();
            /*
             * 2.1 获取对应的Op消息队列，half消息队列和Op消息队列是一一对应的关系
             */
            MessageQueue opQueue = getOpQueue(messageQueue);
            /*
             * 2.2 获取消费偏移量
             */
            //获取内部消费者组CID_SYS_RMQ_TRANS对于该half mq的消费偏移量
            long halfOffset = transactionalMessageBridge.fetchConsumeOffset(messageQueue);
            //获取内部消费者组CID_SYS_RMQ_TRANS对于该Op mq的消费偏移量
            long opOffset = transactionalMessageBridge.fetchConsumeOffset(opQueue);
            log.info("Before check, the queue={} msgOffset={} opOffset={}", messageQueue, halfOffset, opOffset);
            if (halfOffset < 0 || opOffset < 0) {
   
     
                log.error("MessageQueue: {} illegal offset read: {}, op offset: {},skip this queue", messageQueue,
                        halfOffset, opOffset);
                continue;
            }
            //halfOffset < 最新消费的halfOffset的消息，已处理完成的消息，value：opOffset
            List<Long> doneOpOffset = new ArrayList<>();
            //halfOffset >= 最新消费的halfOffset，需要移除的消息，key：halfOffset，value：opOffset
            HashMap<Long, Long> removeMap = new HashMap<>();
            /*
             * 2.3 根据最新已处理的op消息队列消费偏移量和half消息队列消费偏移量，拉取op消息，填充removeMap和doneOpOffset，找出已处理的half消息，避免重复发送事物状态回查请求
             */
            PullResult pullResult = fillOpRemoveMap(removeMap, opQueue, opOffset, halfOffset, doneOpOffset);
            //没拉取到
            if (null == pullResult) {
   
     
                log.error("The queue={} check msgOffset={} with opOffset={} failed, pullResult is null",
                        messageQueue, halfOffset, opOffset);
                continue;
            }
            /*
             * 2.4 从最新消费的halfOffset开始循环进行检测
             */
            // single thread
            //获取空消息的次数
            int getMessageNullCount = 1;
            //处理的最新的half消息偏移量
            long newOffset = halfOffset;
            //从最新消费的halfOffset开始遍历
            long i = halfOffset;
            while (true) {
   
     
                /*
                 * 2.4.1 每一轮消息回查最多进行60s，超时就退出，检测下一个队列
                 */
                if (System.currentTimeMillis() - startTime > MAX_PROCESS_TIME_LIMIT) {
   
     
                    log.info("Queue={} process time reach max={}", messageQueue, MAX_PROCESS_TIME_LIMIT);
                    break;
                }
                /*
                 * 2.4.2 如果removeMap中已包含该offset，从removeMap移除并且加入到doneOpOffset，那么表示已经确定了的事物消息，无需回查
                 */
                //如果removeMap中已包含该offset，那么表示已经确定了的事物消息，无需回查
                if (removeMap.containsKey(i)) {
   
     
                    log.debug("Half offset {} has been committed/rolled back", i);
                    //从removeMap移除并且加入到doneOpOffset
                    Long removedOpOffset = removeMap.remove(i);
                    doneOpOffset.add(removedOpOffset);
                }
                /*
                 * 2.4.3 否则，表示可能需要回查
                 */
                else {
   
     
                    /*
                     * 2.4.4 根据offset查询该half 事物消息
                     */
                    //根据offset查询该half 事物消息
                    GetResult getResult = getHalfMsg(messageQueue, i);
                    MessageExt msgExt = getResult.getMsg();
                    /*
                     * 2.4.5 如果没找到消息
                     */
                    if (msgExt == null) {
   
     
                        //判断是否可以重试，最多重试一次，如果超过次数则结束该消息队列的回查
                        if (getMessageNullCount++ > MAX_RETRY_COUNT_WHEN_HALF_NULL) {
   
     
                            break;
                        }
                        //没有消息
                        if (getResult.getPullResult().getPullStatus() == PullStatus.NO_NEW_MSG) {
   
     
                            log.debug("No new msg, the miss offset={} in={}, continue check={}, pull result={}", i,
                                    messageQueue, getMessageNullCount, getResult.getPullResult());
                            break;
                        } else {
   
     
                            log.info("Illegal offset, the miss offset={} in={}, continue check={}, pull result={}",
                                    i, messageQueue, getMessageNullCount, getResult.getPullResult());
                            //重置
                            i = getResult.getPullResult().getNextBeginOffset();
                            newOffset = i;
                            continue;
                        }
                    }
                    /*
                     * 2.4.6 判断是否需要丢弃、跳过该消息
                     */
                    if (needDiscard(msgExt, transactionCheckMax) || needSkip(msgExt)) {
   
     
                        //通过listener丢弃该half消息，即将消息存入TRANS_CHECK_MAX_TIME_TOPIC这个内部topic中
                        listener.resolveDiscardMsg(msgExt);
                        //增加offset
                        newOffset = i + 1;
                        i++;
                        continue;
                    }
                    /*
                     * 2.4.7 判断事务是否到达超时时间，超时后才会检测
                     */
                    //消息存储时间大于本次回查开始时间，那么本消息队列回查结束
                    if (msgExt.getStoreTimestamp() >= startTime) {
   
     
                        log.debug("Fresh stored. the miss offset={}, check it later, store={}", i,
                                new Date(msgExt.getStoreTimestamp()));
                        break;
                    }
                    //当前时间戳 减去 消息发送时间戳，得到消息已经存储的时间戳
                    long valueOfCurrentMinusBorn = System.currentTimeMillis() - msgExt.getBornTimestamp();
                    //立即检测事务消息的时间，初始化为 事务消息的超时时间，默认为 6s，这个时间是broker中设置的
                    long checkImmunityTime = transactionTimeout;
                    //从half消息的PROPERTY_CHECK_IMMUNITY_TIME_IN_SECONDS属性中获取consumer客户端设置的事务消息检测时间
                    String checkImmunityTimeStr = msgExt.getUserProperty(MessageConst.PROPERTY_CHECK_IMMUNITY_TIME_IN_SECONDS);
                    //如果设置了该属性，一般是没人设置的
                    if (null != checkImmunityTimeStr) {
   
     
                        //如果consumer设置了事务超时时间，那么就使用自己设置的时间，否则使用broker端的默认超时时间6s
                        checkImmunityTime = getImmunityTime(checkImmunityTimeStr, transactionTimeout);
                        //如果消息存储的时间小于事务超时时间，那么说明还没到事务回查的时候
                        if (valueOfCurrentMinusBorn < checkImmunityTime) {
   
     
                            //检查half队列偏移量，返回true则跳过该消息
                            if (checkPrepareQueueOffset(removeMap, doneOpOffset, msgExt)) {
   
     
                                //跳过该消息
                                newOffset = i + 1;
                                i++;
                                continue;
                            }
                        }
                    } else {
   
     
                        //如果没有设置PROPERTY_CHECK_IMMUNITY_TIME_IN_SECONDS属性，并且消息存储的时间小于事务超时时间
                        //那么说明还没到事务回查的时候，当前mq的回查结束
                        if ((0 <= valueOfCurrentMinusBorn) && (valueOfCurrentMinusBorn < checkImmunityTime)) {
   
     
                            log.debug("New arrived, the miss offset={}, check it later checkImmunity={}, born={}", i,
                                    checkImmunityTime, new Date(msgExt.getBornTimestamp()));
                            break;
                        }
                    }
                    /*
                     * 2.4.6 判断是否需要检测
                     * 如果拉取的op消息为null并且当前消息存储的时间大于事务超时时间
                     * 或者拉取的op消息不为null并且最后一个op消息的发送存储时减去起始时间的结果大于事务超时时间
                     * 或者当前时间小于当前消息发送时间戳
                     * 这3种情况都会检测
                     */
                    List<MessageExt> opMsg = pullResult.getMsgFoundList();
                    boolean isNeedCheck = (opMsg == null && valueOfCurrentMinusBorn > checkImmunityTime)
                            || (opMsg != null && (opMsg.get(opMsg.size() - 1).getBornTimestamp() - startTime > transactionTimeout))
                            || (valueOfCurrentMinusBorn <= -1);
                    /*
                     * 2.4.7 执行回查
                     */
                    if (isNeedCheck) {
   
     
                        //首先将该消息再次存入half队列
                        if (!putBackHalfMsgQueue(msgExt, i)) {
   
     
                            continue;
                        }
                        //然后通过listener向consumer客户端发起一个单向消息回查请求
                        listener.resolveHalfMsg(msgExt);
                    }
                    /*
                     * 2.4.8 如果不需要执行回查，那么从已拉取的op消息的下一个offset开始，再次执行fillOpRemoveMap，拉取下一轮的op消息，继续下一个循环检测
                     */
                    else {
   
     
                        pullResult = fillOpRemoveMap(removeMap, opQueue, pullResult.getNextBeginOffset(), halfOffset, doneOpOffset);
                        log.debug("The miss offset:{} in messageQueue:{} need to get more opMsg, result is:{}", i,
                                messageQueue, pullResult);
                        continue;
                    }
                }
                newOffset = i + 1;
                i++;
            }
            //更新half消息队列偏移量
            if (newOffset != halfOffset) {
   
     
                transactionalMessageBridge.updateConsumeOffset(messageQueue, newOffset);
            }
            //更新op消息队列偏移量
            long newOpOffset = calculateOpOffset(doneOpOffset, opOffset);
            if (newOpOffset != opOffset) {
   
     
                transactionalMessageBridge.updateConsumeOffset(opQueue, newOpOffset);
            }
        }
    } catch (Throwable e) {
   
     
        log.error("Check error", e);
    }

}
```

#### 6.2.1 getOpQueue获取Op消息队列

该方法获取获取对应的Op消息队列，我们在此前删除half的部分就说过了，half消息队列和Op消息队列是一一对应的关系。

```java
/**
 * TransactionalMessageServiceImpl的方法
 *
 * 获取对应的Op消息队列，half消息队列和Op消息队列是一一对应的关系
 * @param messageQueue half消息队列
 */
   private MessageQueue getOpQueue(MessageQueue messageQueue) {
   
     
       //从opQueueMap缓存中尝试直接获取
       MessageQueue opQueue = opQueueMap.get(messageQueue);
       if (opQueue == null) {
   
     
           //如果没获取到，则创建一个Op消息队列，topic为RMQ_SYS_TRANS_OP_HALF_TOPIC，brokerName和queueId和对应的half消息队列的属性一致。
           opQueue = new MessageQueue(TransactionalMessageUtil.buildOpTopic(), messageQueue.getBrokerName(),
                   messageQueue.getQueueId());
           //存入缓存
           opQueueMap.put(messageQueue, opQueue);
       }
       return opQueue;

   }
```

#### 6.2.2 fillOpRemoveMap填充需要移除的half消息

该方法基于最新已处理的op消息队列消费偏移量和half消息队列消费偏移量，填充removeMap和doneOpOffset，找出已处理的half消息，避免重复发送事物状态回查请求。大概步骤为：

**1、** 首先通过CID_SYS_RMQ_TRANS这个消费者组拉取32条最新Op消息，也就是已经处理的half消息；
**2、**
然后获取每个解析Op消息的消息体，结果就是对应的half消息在half消息队列的相对偏移量queueOffset对于有“d”的tag标记的op消息，将queueOffset与最新消费的half消息队列偏移量miniOffset进行比较；

**1、** 如果queueOffset<miniOffset，那么加入到doneOpOffset集合，表示已处理的half消息，value：opOffset；
**2、** 否则，加入到removeMap集合，key：halfOffset，value：opOffset，表示当前half消息需要移除；

注意，queueOffset和removeMap中的消息都是已经确定了状态的消息，区别是doneOpOffset中消息的halfOffset <
最新已消费的halfOffset，而removeMap中消息的halfOffset >= 最新已消费的halfOffset。

```java
 /**
* TransactionalMessageServiceImpl的方法
*
   * 读取op消息，解析op消息，填充removeMap
   *
   * @param removeMap      要删除的half消息，key：halfOffset，value：opOffset
   * @param opQueue        Op消息队列
   * @param pullOffsetOfOp Op消息队列的开始偏移量。
   * @param miniOffset     half消息队列的当前最小偏移量。
   * @param doneOpOffset   已处理的Op消息 ，value：opOffset
   * @return Op message result.
   */
  private PullResult fillOpRemoveMap(HashMap<Long, Long> removeMap,
                                     MessageQueue opQueue, long pullOffsetOfOp, long miniOffset, List<Long> doneOpOffset) {
   
     
   //通过CID_SYS_RMQ_TRANS消费者组拉取32条最新Op消息
      PullResult pullResult = pullOpMsg(opQueue, pullOffsetOfOp, 32);
      if (null == pullResult) {
   
     
          return null;
      }
      //请求offset不合法，过大或者过小
      if (pullResult.getPullStatus() == PullStatus.OFFSET_ILLEGAL
              || pullResult.getPullStatus() == PullStatus.NO_MATCHED_MSG) {
   
     
          log.warn("The miss op offset={} in queue={} is illegal, pullResult={}", pullOffsetOfOp, opQueue,
                  pullResult);
          transactionalMessageBridge.updateConsumeOffset(opQueue, pullResult.getNextBeginOffset());
          return pullResult;
      } else if (pullResult.getPullStatus() == PullStatus.NO_NEW_MSG) {
   
     
          log.warn("The miss op offset={} in queue={} is NO_NEW_MSG, pullResult={}", pullOffsetOfOp, opQueue,
                  pullResult);
          return pullResult;
      }
      //获取拉取到的Op消息
      List<MessageExt> opMsg = pullResult.getMsgFoundList();
      if (opMsg == null) {
   
     
          log.warn("The miss op offset={} in queue={} is empty, pullResult={}", pullOffsetOfOp, opQueue, pullResult);
          return pullResult;
      }
      //遍历Op消息
      for (MessageExt opMessageExt : opMsg) {
   
     
       //解析Op消息的消息体，结果就是对应的half消息在half 消息队列的相对偏移量
          Long queueOffset = getLong(new String(opMessageExt.getBody(), TransactionalMessageUtil.charset));
          log.debug("Topic: {} tags: {}, OpOffset: {}, HalfOffset: {}", opMessageExt.getTopic(),
                  opMessageExt.getTags(), opMessageExt.getQueueOffset(), queueOffset);
          //是否有d的tag标记
          if (TransactionalMessageUtil.REMOVETAG.equals(opMessageExt.getTags())) {
   
     
           //如果有标记，并且小于最新的half消息消费偏移量
              if (queueOffset < miniOffset) {
   
     
                  //加入到doneOpOffset集合，表示已处理的half消息
                  doneOpOffset.add(opMessageExt.getQueueOffset());
              } else {
   
     
                  //加入到removeMap集合，表示当前half消息需要移除 key：halfOffset，value：opOffset。
                  removeMap.put(queueOffset, opMessageExt.getQueueOffset());
              }
          } else {
   
     
              log.error("Found a illegal tag in opMessageExt= {} ", opMessageExt);
          }
      }
      log.debug("Remove map: {}", removeMap);
      log.debug("Done op list: {}", doneOpOffset);
      return pullResult;
  }
```

#### 6.2.3 needDiscard是否需要丢弃half消息

通过检查当前回查次数是否大于等于最大回查次数来判断是否丢弃消息，如果不需要丢弃，那么回查次数自增1，并且放入half消息的PROPERTY_TRANSACTION_CHECK_TIMES属性中。

```java
/**
 * TransactionalMessageServiceImpl的方法
 * <p>
 * 通过检查当前回查次数是否大于等于最大回查次数来判断是否丢弃消息
 *
 * @param msgExt              half消息
 * @param transactionCheckMax 最大回查次数，默认15
 */
private boolean needDiscard(MessageExt msgExt, int transactionCheckMax) {
   
     
    //从PROPERTY_TRANSACTION_CHECK_TIMES属性获取回查次数
    String checkTimes = msgExt.getProperty(MessageConst.PROPERTY_TRANSACTION_CHECK_TIMES);
    int checkTime = 1;
    if (null != checkTimes) {
   
     
        checkTime = getInt(checkTimes);
        //如果回查次数大于等于最大值，那么需要丢弃
        if (checkTime >= transactionCheckMax) {
   
     
            return true;
        } else {
   
     
            //否则，回查次数自增1
            checkTime++;
        }
    }
    //回查次数设置到属性中
    msgExt.putUserProperty(MessageConst.PROPERTY_TRANSACTION_CHECK_TIMES, String.valueOf(checkTime));
    return false;
}
```

#### 6.2.4 needSkip是否需要跳过half消息

通过检查消息时间判断是否需要跳过该消息，当前时间戳减去消息发送时间戳，如果中间间隔的时间大于fileReservedTime，则跳过该消息，fileReservedTime为消息日志文件保留的时间默认72h，即3天。

```java
/**
 * TransactionalMessageServiceImpl的方法
 * <p>
 * 通过检查消息时间判断是否需要跳过该消息
 *
 * @param msgExt half消息
 * @return
 */
private boolean needSkip(MessageExt msgExt) {
   
     
    //当前时间戳减去消息发送时间戳
    long valueOfCurrentMinusBorn = System.currentTimeMillis() - msgExt.getBornTimestamp();
    //如果中间间隔的时间大于fileReservedTime，则跳过该消息，fileReservedTime为消息日志文件保留的时间默认72h，即3天
    if (valueOfCurrentMinusBorn
            > transactionalMessageBridge.getBrokerController().getMessageStoreConfig().getFileReservedTime()
            * 3600L * 1000) {
   
     
        log.info("Half message exceed file reserved time ,so skip it.messageId {},bornTime {}",
                msgExt.getMsgId(), msgExt.getBornTimestamp());
        return true;
    }
    return false;
}
```

#### 6.2.5 resolveDiscardMsg丢弃half消息

需要丢弃、跳过的消息，将会通过DefaultTransactionalMessageCheckListener# resolveDiscardMsg执行难丢弃的逻辑。

首先将half消息转换为内部消息对象，topic改为TRANS_CHECK_MAX_TIME_TOPIC，然后将消息存入该topic中，即算作丢弃完毕。

从这里可以知道，被丢弃的half消息就是存入了TRANS_CHECK_MAX_TIME_TOPIC这个内部topic中。

```java
/**
 * DefaultTransactionalMessageCheckListener的方法
 * <p>
 * 丢弃half消息
 *
 * @param msgExt 需要丢弃的half消息
 */
@Override
public void resolveDiscardMsg(MessageExt msgExt) {
   
     
    log.error("MsgExt:{} has been checked too many times, so discard it by moving it to system topic TRANS_CHECK_MAXTIME_TOPIC", msgExt);

    try {
   
     
        //half消息转换为内部消息对象，topic为TRANS_CHECK_MAX_TIME_TOPIC
        MessageExtBrokerInner brokerInner = toMessageExtBrokerInner(msgExt);
        //将消息存入该topic
        PutMessageResult putMessageResult = this.getBrokerController().getMessageStore().putMessage(brokerInner);
        if (putMessageResult != null && putMessageResult.getPutMessageStatus() == PutMessageStatus.PUT_OK) {
   
     
            log.info("Put checked-too-many-time half message to TRANS_CHECK_MAXTIME_TOPIC OK. Restored in queueOffset={}, " +
                    "commitLogOffset={}, real topic={}", msgExt.getQueueOffset(), msgExt.getCommitLogOffset(), msgExt.getUserProperty(MessageConst.PROPERTY_REAL_TOPIC));
        } else {
   
     
            log.error("Put checked-too-many-time half message to TRANS_CHECK_MAXTIME_TOPIC failed, real topic={}, msgId={}", msgExt.getTopic(), msgExt.getMsgId());
        }
    } catch (Exception e) {
   
     
        log.warn("Put checked-too-many-time message to TRANS_CHECK_MAXTIME_TOPIC error. {}", e);
    }

}
```

##### 6.2.5.1 toMessageExtBrokerInner转换内部消息对象

half消息转换为内部消息对象，topic为TRANS_CHECK_MAX_TIME_TOPIC，被丢弃的half消息将会存入这个这个固定的topic中，该topic队列数固定为1，具有读写权限。

```java
private MessageExtBrokerInner toMessageExtBrokerInner(MessageExt msgExt) {
   
     
    //创建或者获取topic信息，被丢弃的half消息将会存入TRANS_CHECK_MAX_TIME_TOPIC这个固定的topic
    TopicConfig topicConfig = this.getBrokerController().getTopicConfigManager().createTopicOfTranCheckMaxTime(TCMT_QUEUE_NUMS, PermName.PERM_READ | PermName.PERM_WRITE);
    //默认只有一个队列，所以queueId固定为0
    int queueId = ThreadLocalRandom.current().nextInt(99999999) % TCMT_QUEUE_NUMS;
    MessageExtBrokerInner inner = new MessageExtBrokerInner();
    inner.setTopic(topicConfig.getTopicName());
    inner.setBody(msgExt.getBody());
    inner.setFlag(msgExt.getFlag());
    MessageAccessor.setProperties(inner, msgExt.getProperties());
    inner.setPropertiesString(MessageDecoder.messageProperties2String(msgExt.getProperties()));
    inner.setTagsCode(MessageExtBrokerInner.tagsString2tagsCode(msgExt.getTags()));
    inner.setQueueId(queueId);
    inner.setSysFlag(msgExt.getSysFlag());
    inner.setBornHost(msgExt.getBornHost());
    inner.setBornTimestamp(msgExt.getBornTimestamp());
    inner.setStoreHost(msgExt.getStoreHost());
    inner.setReconsumeTimes(msgExt.getReconsumeTimes());
    inner.setMsgId(msgExt.getMsgId());
    inner.setWaitStoreMsgOK(false);
    return inner;
}
```

#### 6.2.6 checkPrepareQueueOffset检查half队列偏移量

对于自定了事务超时时间的消息，如果消息存储的时间小于事务超时时间，那么说明还没到事务回查的时候，此时超时时间不确定，需要重新检查一次。因此调用checkPrepareQueueOffset检查half队列偏移量，返回true则跳过该消息。

该方法的大概逻辑为：

**1、** 从该消息获取PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET属性，该属性的含义为此前该消息在half队列的offset，也就是第一次存放该消息的offset；
**2、**
如果没有该属性，说明该消息第一次遇见，将该消息重新存入half队列，设置PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET属性值为当前消息的offset，等待下一次的回查，存放成功则返回true；
**3、**
如果有该属性，获取该属性值，也就是第一次存放该消息的offset，如果removeMap包含该offset，那么移除并加入doneOpOffset此时表示该消息状态已确定，不需要回查，返回true否则将该消息重新存入half队列，设置PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET属性值为最开始的offset，等待下一次的回查，存放成功则返回true；

```java
/**
 * 检查half消息队列的偏移量，返回true则跳过该消息
 *
 * @param removeMap    需要移除的消息
 * @param doneOpOffset 已处理完成的消息
 * @param msgExt       half消息
 * @return 返回true则跳过该消息
 */
private boolean checkPrepareQueueOffset(HashMap<Long, Long> removeMap, List<Long> doneOpOffset,
                                        MessageExt msgExt) {
   
     
    //从该消息获取PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET属性，即此前该消息在half队列的offset，也就是第一次存放该消息的offset
    String prepareQueueOffsetStr = msgExt.getUserProperty(MessageConst.PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET);
    //如果没有该属性，说明该消息第一次遇见
    if (null == prepareQueueOffsetStr) {
   
     
        //将该消息重新存入half队列，等待下一次的回查，存放成功则返回true
        return putImmunityMsgBackToHalfQueue(msgExt);
    } else {
   
     
        //获取该属性值，也就是第一次存放该消息的offset
        long prepareQueueOffset = getLong(prepareQueueOffsetStr);
        if (-1 == prepareQueueOffset) {
   
     
            return false;
        } else {
   
     
            //如果removeMap包含该offset，那么移除并加入doneOpOffset，
            if (removeMap.containsKey(prepareQueueOffset)) {
   
     
                long tmpOpOffset = removeMap.remove(prepareQueueOffset);
                doneOpOffset.add(tmpOpOffset);
                //此时表示该消息状态已确定，不需要回查
                return true;
            } else {
   
     
                //将该消息重新存入half队列，等待下一次的回查，存放成功则返回true
                return putImmunityMsgBackToHalfQueue(msgExt);
            }
        }
    }
}
private boolean putImmunityMsgBackToHalfQueue(MessageExt messageExt) {
   
     
    //重建一个MessageExtBrokerInner，将最开始的消息的offset存入PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET属性中
    MessageExtBrokerInner msgInner = transactionalMessageBridge.renewImmunityHalfMessageInner(messageExt);
    //消息存入half队列
    return transactionalMessageBridge.putMessage(msgInner);
}

public MessageExtBrokerInner renewImmunityHalfMessageInner(MessageExt msgExt) {
   
     
    //重建内部消息对象
    MessageExtBrokerInner msgInner = renewHalfMessageInner(msgExt);
    //获取PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET属性，第一次存放的时候为null
    String queueOffsetFromPrepare = msgExt.getUserProperty(MessageConst.PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET);
    //如果不为null，那么将此前记录的offset再次存入PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET属性
    if (null != queueOffsetFromPrepare) {
   
     
        MessageAccessor.putProperty(msgInner, MessageConst.PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET,
                String.valueOf(queueOffsetFromPrepare));
    } else {
   
     
        //如果为null，那么将当前half消息的offset存入PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET属性
        MessageAccessor.putProperty(msgInner, MessageConst.PROPERTY_TRANSACTION_PREPARED_QUEUE_OFFSET,
                String.valueOf(msgExt.getQueueOffset()));
    }

    msgInner.setPropertiesString(MessageDecoder.messageProperties2String(msgInner.getProperties()));

    return msgInner;
}
```

#### 6.2.7 resolveHalfMsg异步发起回查请求

如果确实需要对事物消息进行检查，那么将会通过AbstractTransactionalMessageCheckListener#resolveHalfMsg方法发起回查。

该方法构建一个发送回查消息的线程任务，然后通过内部的executorService线程池异步的执行，将会异步的发起一个回查请求，请求Code为CHECK_TRANSACTION_STATE。

```java
/**
 * AbstractTransactionalMessageCheckListener的方法
 * <p>
 * 发起回查
 *
 * @param msgExt half消息
 */
public void resolveHalfMsg(final MessageExt msgExt) {
   
     
    //通过内部的executorService线程池发起一个异步的回查
    executorService.execute(new Runnable() {
   
     
        @Override
        public void run() {
   
     
            try {
   
     
                //异步的发送回查消息
                sendCheckMessage(msgExt);
            } catch (Exception e) {
   
     
                LOGGER.error("Send check message error!", e);
            }
        }
    });
}

/**
 * AbstractTransactionalMessageCheckListener的方法
 * <p>
 * 发送回查消息
 *
 * @param msgExt half消息
 */
public void sendCheckMessage(MessageExt msgExt) throws Exception {
   
     
    //构建回查消息请求头
    CheckTransactionStateRequestHeader checkTransactionStateRequestHeader = new CheckTransactionStateRequestHeader();
    checkTransactionStateRequestHeader.setCommitLogOffset(msgExt.getCommitLogOffset());
    checkTransactionStateRequestHeader.setOffsetMsgId(msgExt.getMsgId());
    //migId和transactionId是同一个，都是客户端生成的uniqId
    checkTransactionStateRequestHeader.setMsgId(msgExt.getUserProperty(MessageConst.PROPERTY_UNIQ_CLIENT_MESSAGE_ID_KEYIDX));
    checkTransactionStateRequestHeader.setTransactionId(checkTransactionStateRequestHeader.getMsgId());
    //消息队列偏移量
    checkTransactionStateRequestHeader.setTranStateTableOffset(msgExt.getQueueOffset());
    //设置真实topic和queueId
    msgExt.setTopic(msgExt.getUserProperty(MessageConst.PROPERTY_REAL_TOPIC));
    msgExt.setQueueId(Integer.parseInt(msgExt.getUserProperty(MessageConst.PROPERTY_REAL_QUEUE_ID)));
    msgExt.setStoreSize(0);
    //获取生产者组
    String groupId = msgExt.getProperty(MessageConst.PROPERTY_PRODUCER_GROUP);
    //选择该组里面的一个活跃的生产者，轮询策略
    Channel channel = brokerController.getProducerManager().getAvailableChannel(groupId);
    if (channel != null) {
   
     
        //向producer发起事务状态回查请求
        brokerController.getBroker2Client().checkProducerTransactionState(groupId, channel, checkTransactionStateRequestHeader, msgExt);
    } else {
   
     
        LOGGER.warn("Check transaction failed, channel is null. groupId={}", groupId);
    }
}

/**
 * Broker2Client的方法
 * <p>
 * 向producer发起事务状态回查请求
 *
 * @param group         生产者组
 * @param channel       连接
 * @param requestHeader 请求头
 * @param messageExt    half消息
 */
public void checkProducerTransactionState(
        final String group,
        final Channel channel,
        final CheckTransactionStateRequestHeader requestHeader,
        final MessageExt messageExt) throws Exception {
   
     
    //构建请求命令对象，Code为CHECK_TRANSACTION_STATE
    RemotingCommand request =
            RemotingCommand.createRequestCommand(RequestCode.CHECK_TRANSACTION_STATE, requestHeader);
    //设置消息体为half消息
    request.setBody(MessageDecoder.encode(messageExt, false));
    try {
   
     
        //向该producer发起单向请求
        this.brokerController.getRemotingServer().invokeOneway(channel, request, 10);
    } catch (Exception e) {
   
     
        log.error("Check transaction failed because invoke producer exception. group={}, msgId={}, error={}",
                group, messageExt.getMsgId(), e.toString());
    }
}
```

## 7 producer处理消息回查请求

broker发送的回查请求Code为CHECK_TRANSACTION_STATE，该请求将会发送到所属的生产者组的下面的某一个活跃的生产者客户端（轮询），因此发起事务的生产者不一定是接受回查请求的生产者。

produer客户端对于CHECK_TRANSACTION_STATE请求，通过ClientRemotingProcessor这个处理器的checkTransactionState方法来处理。
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162130114.png)

### 7.1 checkTransactionState检查事务状态

checkTransactionState方法将会对消息进行解码，然后根据生产者组获取从该客户端的producerTable中获取对应的生产则，然后通过producer#checkTransactionState方法检查事务状态。

```java
/**
 * ClientRemotingProcessor的方法
 * <p>
 * 检查事务状态
 */
public RemotingCommand checkTransactionState(ChannelHandlerContext ctx,
                                             RemotingCommand request) throws RemotingCommandException {
   
     
    //解码请求头
    final CheckTransactionStateRequestHeader requestHeader =
            (CheckTransactionStateRequestHeader) request.decodeCommandCustomHeader(CheckTransactionStateRequestHeader.class);
    //解码消息体，为对应的half消息
    final ByteBuffer byteBuffer = ByteBuffer.wrap(request.getBody());
    final MessageExt messageExt = MessageDecoder.decode(byteBuffer);
    if (messageExt != null) {
   
     
        if (StringUtils.isNotEmpty(this.mqClientFactory.getClientConfig().getNamespace())) {
   
     
            messageExt.setTopic(NamespaceUtil
                    .withoutNamespace(messageExt.getTopic(), this.mqClientFactory.getClientConfig().getNamespace()));
        }
        //获取事务id，实际就是客户端生成的uniqId
        String transactionId = messageExt.getProperty(MessageConst.PROPERTY_UNIQ_CLIENT_MESSAGE_ID_KEYIDX);
        if (null != transactionId && !"".equals(transactionId)) {
   
     
            messageExt.setTransactionId(transactionId);
        }
        //获取生产者组
        final String group = messageExt.getProperty(MessageConst.PROPERTY_PRODUCER_GROUP);
        if (group != null) {
   
     
            //获取该生产者组对应的生产者
            MQProducerInner producer = this.mqClientFactory.selectProducer(group);
            if (producer != null) {
   
     
                //远程地址
                final String addr = RemotingHelper.parseChannelRemoteAddr(ctx.channel());
                //通过producer检查事务状态
                producer.checkTransactionState(addr, messageExt, requestHeader);
            } else {
   
     
                log.debug("checkTransactionState, pick producer by group[{}] failed", group);
            }
        } else {
   
     
            log.warn("checkTransactionState, pick producer group failed");
        }
    } else {
   
     
        log.warn("checkTransactionState, decode message failed");
    }

    return null;
}
```

### 7.2 checkTransactionState检查事务状态

DefaultMQProducerImpl# checkTransactionState方法，真正用于检查事务状态。该方法将事务状态的检查以及发送事务结束消息的请求都封装到一个线程任务中，然后通过事务检查线程池异步的执行事务回查的线程任务。

线程任务的大概逻辑为：

**1、** 获取检查监听器TransactionCheckListener，目前这个监听器已不推荐使用，获取事务监听器TransactionListener，推荐使用该监听器；

2. 执行事务监听器TransactionListener#checkLocalTransaction方法，用于检查本地事务，返回事务状态，我们可以从参数message中获取事务id，进而进行一系列事务检查操作。

**3、** 再次调用endTransactionOneway方法发送结束事务单向请求，将本次检查的结果发送给broker；

```java
/**
 * DefaultMQProducerImpl的方法
 * <p>
 * 检查事务状态
 *
 * @param addr   broker地址
 * @param msg    half消息
 * @param header 请求头
 */
@Override
public void checkTransactionState(final String addr, final MessageExt msg, final CheckTransactionStateRequestHeader header) {
   
     
    /*
     * 创建了一个线程任务
     */
    Runnable request = new Runnable() {
   
     
        private final String brokerAddr = addr;
        private final MessageExt message = msg;
        private final CheckTransactionStateRequestHeader checkRequestHeader = header;
        private final String group = DefaultMQProducerImpl.this.defaultMQProducer.getProducerGroup();

        @Override
        public void run() {
   
     
            //获取检查监听器，目前这个监听器已不推荐使用
            TransactionCheckListener transactionCheckListener = DefaultMQProducerImpl.this.checkListener();
            //获取事务监听器，推荐使用该监听器
            TransactionListener transactionListener = getCheckListener();
            if (transactionCheckListener != null || transactionListener != null) {
   
     
                //检查状态
                LocalTransactionState localTransactionState = LocalTransactionState.UNKNOW;
                Throwable exception = null;
                try {
   
     
                    //如果存在事务检查监听器，现在一般都没有使用这个组件
                    if (transactionCheckListener != null) {
   
     
                        localTransactionState = transactionCheckListener.checkLocalTransactionState(message);
                    }
                    //如果存在事务检查监听器，现在一般都使用这个组件
                    else if (transactionListener != null) {
   
     
                        log.debug("Used new check API in transaction message");
                        //执行事务监听器的checkLocalTransaction方法，用于检查本地事务，返回事务状态
                        //可以从参数message中获取事务id，进而进行一系列操作
                        localTransactionState = transactionListener.checkLocalTransaction(message);
                    } else {
   
     
                        log.warn("CheckTransactionState, pick transactionListener by group[{}] failed", group);
                    }
                } catch (Throwable e) {
   
     
                    log.error("Broker call checkTransactionState, but checkLocalTransactionState exception", e);
                    exception = e;
                }
                /*
                 * 处理事务状态
                 */
                this.processTransactionState(localTransactionState, group, exception);
            } else {
   
     
                log.warn("CheckTransactionState, pick transactionCheckListener by group[{}] failed", group);
            }
        }

        /**
         * 处理事务状态
         *
         * @param localTransactionState 本地事务状态
         * @param producerGroup 生产者组
         * @param exception 抛出的异常
         */
        private void processTransactionState(final LocalTransactionState localTransactionState, final String producerGroup, final Throwable exception) {
   
     
            final EndTransactionRequestHeader thisHeader = new EndTransactionRequestHeader();
            //half消息的commitLogOffset
            thisHeader.setCommitLogOffset(checkRequestHeader.getCommitLogOffset());
            thisHeader.setProducerGroup(producerGroup);
            //half消息的consumeQueueOffset
            thisHeader.setTranStateTableOffset(checkRequestHeader.getTranStateTableOffset());
            thisHeader.setFromTransactionCheck(true);

            String uniqueKey = message.getProperties().get(MessageConst.PROPERTY_UNIQ_CLIENT_MESSAGE_ID_KEYIDX);
            if (uniqueKey == null) {
   
     
                uniqueKey = message.getMsgId();
            }
            //设置msgId和transactionId，一般他们都是uniqueKey
            thisHeader.setMsgId(uniqueKey);
            thisHeader.setTransactionId(checkRequestHeader.getTransactionId());
            //根据返回的本地事务状态，设置commitOrRollback属性
            switch (localTransactionState) {
   
     
                case COMMIT_MESSAGE:
                    thisHeader.setCommitOrRollback(MessageSysFlag.TRANSACTION_COMMIT_TYPE);
                    break;
                case ROLLBACK_MESSAGE:
                    thisHeader.setCommitOrRollback(MessageSysFlag.TRANSACTION_ROLLBACK_TYPE);
                    log.warn("when broker check, client rollback this transaction, {}", thisHeader);
                    break;
                case UNKNOW:
                    thisHeader.setCommitOrRollback(MessageSysFlag.TRANSACTION_NOT_TYPE);
                    log.warn("when broker check, client does not know this transaction state, {}", thisHeader);
                    break;
                default:
                    break;
            }

            String remark = null;
            if (exception != null) {
   
     
                remark = "checkLocalTransactionState Exception: " + RemotingHelper.exceptionSimpleDesc(exception);
            }
            //执行钩子函数，一般没有钩子
            doExecuteEndTransactionHook(msg, uniqueKey, brokerAddr, localTransactionState, true);

            try {
   
     
                //发送结束事务单向请求
                DefaultMQProducerImpl.this.mQClientFactory.getMQClientAPIImpl().endTransactionOneway(brokerAddr, thisHeader, remark, 3000);
            } catch (Exception e) {
   
     
                log.error("endTransactionOneway exception", e);
            }
        }
    };
    /*
     * 通过事务检查线程池执行事务回查的线程任务
     */
    this.checkExecutor.submit(request);
}
```

## 8 事物消息总结

由于我们此前学习过了[RocketMQ事物消息的概念、流程和设计](https://blog.csdn.net/weixin_43767015/article/details/121308018)
，在那篇文章中几乎都总结完了关键点，这篇文章可以看作是从源码的角度再次理解RocketMQ事物消息的实现，所以没有太多需要总结的地方。

下面说几个关键点：

**1、** RocketMQ无法真正的删除某条half消息，因此在二阶段事物commit或者rollBack时，是通过写入对应的事务Op消息，opType为“d”，用来实现“删除”half消息的效果；
**2、**
RocketMQ发送half消息时，真正的topic和queueId会被替换为half消息的topic并且被存放在消息属性中，在二阶段事物commit完成后，将会从后half消息的属性中解析出真正的topic和queueId恢复原始消息，并将原始消息真正的投放到目的地这种“内部消息主题替换”的套路非常巧妙，在RocketMQ延迟消息的实现上也使用到了；
**3、** broker发送的回查请求将会发送到所属的生产者组的下面的某一个活跃的生产者客户端（默认轮询），因此发起事务的生产者不一定是接受回查请求的生产者；

