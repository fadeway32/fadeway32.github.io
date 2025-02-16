---

layout: 08、RocketMQ源码分析：Producer发送单向、同步、异步消息源码【一万字】

title:  08、RocketMQ源码分析：Producer发送单向、同步、异步消息源码【一万字】

tags: RocketMq

categories: Web

top: 56

path: /article/1739713333

abbrlink: 1739713333

date: 2025-02-16 21:42:06


--- 

# 08、RocketMQ源码分析：Producer发送单向、同步、异步消息源码【一万字】

- 1 invokeOneway单向发送
-
    - 1.1 invokeOnewayImpl单向调用
- 2 sendMessageSync同步发送
-
    - 2.1 invokeSync同步调用
-
    - 2.1.1 invokeSyncImpl同步调用实现
    -
        - 2.1.1.1 请求的阻塞和唤醒
    - 2.1.2 processSendResponse处理响应结果
- 3 sendMessageAsync异步发送消息
-
    - 3.1 invokeAsync异步调用
-
    - 3.1.1 invokeAsyncImpl异步调用实现
- 3.2 onExceptionImpl异常处理
- 4 NettyClientHandler处理服务端消息
-
    - 4.1 processResponseCommand处理响应
-
    - 4.1.1 executeInvokeCallback执行回调函数
    -
        - 4.1.1.1 executeInvokeCallback指定回调
    - 4.1.2 putResponse存入响应
- 5 总结

此前，我们学习了[RocketMQ源码(7)—Producer发送消息源码(1)—发送消息的总体流程【一万字】](https://blog.csdn.net/weixin_43767015/article/details/126729959)
，我们知道了Producer发送消息的总体流程，现在我们专门来学习一个重要的发送消息的内部方法**MQClientAPIImpl#sendMessage**的源码。

**当一切准备就绪，最终异步、单向、同步发送模式都会调用MQClientAPIImpl#sendMessage方法发送消息，该方法是真正的发起请求的方法。
**

这个方法的逻辑就比较简单了：

**1、**
首先构建发送消息命令对象RemotingCommand，此时会判断是否需要更换轻量级消息头，如果sendSmartMsg属性为true（默认为true）或者是批量消息，则使用轻量级消息头SendMessageRequestHeaderV2相比于requestHeader，其field全为a,b,c,d等短变量名，可以加快FastJson反序列化过程；

2. 根据发送模式执行不同的发送逻辑。*
   *单向发送模式调用RemotingClient#invokeOneway方法；异步发送模式调用MQClientAPIImpl#sendMessageAsync方法；同步发送模式调用MQClientAPIImpl#sendMessageSync方法。在异步和同步模式发送方法的调用前还会再检查是否超时，如果超时则不再调用。
   **

```java
/**
 * MQClientAPIImpl的方法
 * 同步、异步、单向消息的最终发送消息的方法
 *
 * @param addr                     brokerAddr
 * @param brokerName               brokerName
 * @param msg                      msg
 * @param requestHeader            requestHeader
 * @param timeoutMillis            剩余超时时间
 * @param communicationMode        发送模式
 * @param sendCallback             发送回调函数
 * @param topicPublishInfo         topic信息
 * @param instance                 MQClientInstance
 * @param retryTimesWhenSendFailed 异步发送失败时的重试次数，默认2
 * @param context                  发送消息上下文
 * @param producer                 DefaultMQProducerImpl
 * @return
 * @throws RemotingException
 * @throws MQBrokerException
 * @throws InterruptedException
 */
public SendResult sendMessage(
        final String addr,
        final String brokerName,
        final Message msg,
        final SendMessageRequestHeader requestHeader,
        final long timeoutMillis,
        final CommunicationMode communicationMode,
        final SendCallback sendCallback,
        final TopicPublishInfo topicPublishInfo,
        final MQClientInstance instance,
        final int retryTimesWhenSendFailed,
        final SendMessageContext context,
        final DefaultMQProducerImpl producer
) throws RemotingException, MQBrokerException, InterruptedException {
   
     
    long beginStartTime = System.currentTimeMillis();
    RemotingCommand request = null;
    //消息类型
    String msgType = msg.getProperty(MessageConst.PROPERTY_MESSAGE_TYPE);
    //是否时重试消息
    boolean isReply = msgType != null && msgType.equals(MixAll.REPLY_MESSAGE_FLAG);
    /*
     * 1 构建发送消息命令对象RemotingCommand，更换轻量级消息头
     *
     * sendSmartMsg表示是否使用更轻量级的消息头SendMessageRequestHeaderV2
     * 相比于requestHeader，其field 全为 a,b,c,d 等短变量名，可以加快FastJson反序列化过程。
     */
    if (isReply) {
   
     
        //sendSmartMsg默认为true
        if (sendSmartMsg) {
   
     
            //构建轻量级消息头
            SendMessageRequestHeaderV2 requestHeaderV2 = SendMessageRequestHeaderV2.createSendMessageRequestHeaderV2(requestHeader);
            //创建发送消息命令对象，RequestCode为SEND_REPLY_MESSAGE_V2
            request = RemotingCommand.createRequestCommand(RequestCode.SEND_REPLY_MESSAGE_V2, requestHeaderV2);
        } else {
   
     
            //创建发送消息命令对象，RequestCode为SEND_REPLY_MESSAGE
            request = RemotingCommand.createRequestCommand(RequestCode.SEND_REPLY_MESSAGE, requestHeader);
        }
    } else {
   
     
        if (sendSmartMsg || msg instanceof MessageBatch) {
   
     
            //构建轻量级消息头
            SendMessageRequestHeaderV2 requestHeaderV2 = SendMessageRequestHeaderV2.createSendMessageRequestHeaderV2(requestHeader);
            //如果是批量消息，则RequestCode为SEND_BATCH_MESSAGE，否则RequestCode为SEND_MESSAGE_V2
            request = RemotingCommand.createRequestCommand(msg instanceof MessageBatch ? RequestCode.SEND_BATCH_MESSAGE : RequestCode.SEND_MESSAGE_V2, requestHeaderV2);
        } else {
   
     
            //创建发送消息命令对象，RequestCode为SEND_MESSAGE
            request = RemotingCommand.createRequestCommand(RequestCode.SEND_MESSAGE, requestHeader);
        }
    }
    //设置body
    request.setBody(msg.getBody());
    /*
     * 2 根据发送模式执行不同的发送逻辑
     */
    switch (communicationMode) {
   
     
        case ONEWAY:
            /*
             * 单向发送，调用该方法之后不接收返回值，直接返回null
             */
            this.remotingClient.invokeOneway(addr, request, timeoutMillis);
            return null;
        case ASYNC:
            //异步消息重试计数器
            final AtomicInteger times = new AtomicInteger();
            //计算是否超时，如果超时则不再发送
            long costTimeAsync = System.currentTimeMillis() - beginStartTime;
            if (timeoutMillis < costTimeAsync) {
   
     
                throw new RemotingTooMuchRequestException("sendMessage call timeout");
            }
            /*
             * 异步发送，调用该方法之后不接收返回值，直接返回null
             */
            this.sendMessageAsync(addr, brokerName, msg, timeoutMillis - costTimeAsync, request, sendCallback, topicPublishInfo, instance,
                    retryTimesWhenSendFailed, times, context, producer);
            return null;
        case SYNC:
            //计算是否超时，如果超时则不再发送
            long costTimeSync = System.currentTimeMillis() - beginStartTime;
            if (timeoutMillis < costTimeSync) {
   
     
                throw new RemotingTooMuchRequestException("sendMessage call timeout");
            }
            /*
             * 同步发送，调用该方法之后阻塞直至收到返回值
             */
            return this.sendMessageSync(addr, brokerName, msg, timeoutMillis - costTimeSync, request);
        default:
            assert false;
            break;
    }

    return null;
}
```

## 1 invokeOneway单向发送

该模式下，消息只会发送一次，且不会返回任何结果，即只管发送不管结果。

```java
/**
 * NettyRemotingClient的方法
 * <p>
 * 单向消息发送的通用方法
 *
 * @param addr          服务器地址
 * @param request       请求命令对象
 * @param timeoutMillis 超时时间
 */
@Override
public void invokeOneway(String addr, RemotingCommand request, long timeoutMillis) throws InterruptedException,
        RemotingConnectException, RemotingTooMuchRequestException, RemotingTimeoutException, RemotingSendRequestException {
   
     
    //获取或者建立同服务器的通道，即连接
    final Channel channel = this.getAndCreateChannel(addr);
    if (channel != null && channel.isActive()) {
   
     
        try {
   
     
            //执行rpcHook的前置方法doBeforeRequest
            doBeforeRpcHooks(addr, request);
            /*
             * 调用另一个invokeOnewayImpl方法，发送单向消息
             */
            this.invokeOnewayImpl(channel, request, timeoutMillis);
        } catch (RemotingSendRequestException e) {
   
     
            log.warn("invokeOneway: send request exception, so close the channel[{}]", addr);
            this.closeChannel(addr, channel);
            throw e;
        }
    } else {
   
     
        this.closeChannel(addr, channel);
        throw new RemotingConnectException(addr);
    }
}
```

首先会调用getAndCreateChannel方法，尝试获取此broker的通道，如果没有获取到，那么会创建一个通道，即连接。然后执行rpcHook的前置方法doBeforeRequest，随后调用另一个invokeOnewayImpl方法，发送单向消息。

### 1.1 invokeOnewayImpl单向调用

这个方法是单向消息的真正发送方法，终于到了最底层了，不容易啊。

**该方法首先将请求标记为单向发送，然后基于**[**Semaphore信号量
**](https://blog.csdn.net/weixin_43767015/article/details/108079508)*
*尝试获取单向发送的资源，通过信号量控制单向消息并发发送的消息数，从而保护系统内存占用。客户端单向发送的Semaphore信号量默认为65535，即单向消息最大并发为65535，可通过配置"
com.rocketmq.remoting.clientOnewaySemaphoreValue"系统变量更改。**

获取到了信号量资源之后。构建**SemaphoreReleaseOnlyOnce**对象，保证信号量本次只被释放一次，防止并发操作引起线程安全问题，然后就通过channel发送请求即可。

在其监听器ChannelFutureListener中，会释放信号量，如果发送失败了，仅仅是打印一行warn日志，然后就不管了。如果没有获取到信号量资源，那么直接抛出异常即可，并且不再发送。

**只管发送不管结果，不会进行任何重试，这就是单向发送消息的真正含义。**

```java
/**
 * NettyRemotingAbstract的方法
 * <p>
 * 单向消息发送的逻辑
 *
 * @param channel       通道
 * @param request       请求
 * @param timeoutMillis 超时时间
 */
public void invokeOnewayImpl(final Channel channel, final RemotingCommand request, final long timeoutMillis)
        throws InterruptedException, RemotingTooMuchRequestException, RemotingTimeoutException, RemotingSendRequestException {
   
     
    //标记为单向发送
    request.markOnewayRPC();
    //基于Semaphore信号量尝试获取单向发送的资源，通过信号量控制单向消息并发发送的消息数，从而保护系统内存占用。
    //客户端单向发送的Semaphore信号量默认为65535，可通过配置"com.rocketmq.remoting.clientOnewaySemaphoreValue"系统变量更改
    boolean acquired = this.semaphoreOneway.tryAcquire(timeoutMillis, TimeUnit.MILLISECONDS);
    //如果获取到了信号量资源
    if (acquired) {
   
     
        //构建SemaphoreReleaseOnlyOnce对象，保证信号量本次只被释放一次，防止并发操作引起线程安全问题
        final SemaphoreReleaseOnlyOnce once = new SemaphoreReleaseOnlyOnce(this.semaphoreOneway);
        try {
   
     
            //将请求发送出去即可
            channel.writeAndFlush(request).addListener(new ChannelFutureListener() {
   
     
                @Override
                public void operationComplete(ChannelFuture f) throws Exception {
   
     
                    //释放信号量
                    once.release();
                    //如果发送失败了，仅仅是打印一行warn日志，然后就不管了，这就是单向发送
                    if (!f.isSuccess()) {
   
     
                        log.warn("send a request command to channel <" + channel.remoteAddress() + "> failed.");
                    }
                }
            });
        } catch (Exception e) {
   
     
            //释放信号量
            once.release();
            log.warn("write send a request command to channel <" + channel.remoteAddress() + "> failed.");
            throw new RemotingSendRequestException(RemotingHelper.parseChannelRemoteAddr(channel), e);
        }
    } else {
   
     
        //如果没有获取到信号量资源，那么直接抛出异常即可，并且不再发送
        if (timeoutMillis <= 0) {
   
     
            throw new RemotingTooMuchRequestException("invokeOnewayImpl invoke too fast");
        } else {
   
     
            String info = String.format(
                    "invokeOnewayImpl tryAcquire semaphore timeout, %dms, waiting thread nums: %d semaphoreOnewayValue: %d",
                    timeoutMillis,
                    this.semaphoreOneway.getQueueLength(),
                    this.semaphoreOneway.availablePermits()
            );
            log.warn(info);
            throw new RemotingTimeoutException(info);
        }
    }
}
```

## 2 sendMessageSync同步发送

该模式下，发送之后会同步阻塞直到结果返回。

```java
/**
 * MQClientAPIImpl的方法
 */
private SendResult sendMessageSync(
        final String addr,
        final String brokerName,
        final Message msg,
        final long timeoutMillis,
        final RemotingCommand request
) throws RemotingException, MQBrokerException, InterruptedException {
   
     
    /*
     * 发送同步消息
     */
    RemotingCommand response = this.remotingClient.invokeSync(addr, request, timeoutMillis);
    assert response != null;
    /*
     * 处理响应结果
     */
    return this.processSendResponse(brokerName, msg, response, addr);
}
```

其内部调用NettyRemotingClient#invokeSync方法执行同步调用，然后调用processSendResponse方法处理响应结果。

### 2.1 invokeSync同步调用

该方法执行同步调用。首先获取或者创建通道，即连接。然后在发送消息前后执行**rpcHook**钩子方法，即**RPCHook#doBeforeRequest**
方法，通过调用**invokeSyncImpl**方法发起同步调用并获取响应结果返回。

```java
/**
 * NettyRemotingClient的方法
 * <p>
 * 同步调用
 */
@Override
public RemotingCommand invokeSync(String addr, final RemotingCommand request, long timeoutMillis)
        throws InterruptedException, RemotingConnectException, RemotingSendRequestException, RemotingTimeoutException {
   
     
    long beginStartTime = System.currentTimeMillis();
    //根据addr建立连接，获取channel
    final Channel channel = this.getAndCreateChannel(addr);
    if (channel != null && channel.isActive()) {
   
     
        try {
   
     
            //执行rpc钩子的doBeforeRequest方法
            doBeforeRpcHooks(addr, request);
            //检查超时，如果超时则抛出异常
            long costTime = System.currentTimeMillis() - beginStartTime;
            if (timeoutMillis < costTime) {
   
     
                throw new RemotingTimeoutException("invokeSync call the addr[" + addr + "] timeout");
            }
            //执行同步远程调用，或者调用结果
            RemotingCommand response = this.invokeSyncImpl(channel, request, timeoutMillis - costTime);
            //执行rpc钩子的doAfterResponse方法
            doAfterRpcHooks(RemotingHelper.parseChannelRemoteAddr(channel), request, response);
            return response;
        } catch (RemotingSendRequestException e) {
   
     
            log.warn("invokeSync: send request exception, so close the channel[{}]", addr);
            this.closeChannel(addr, channel);
            throw e;
        } catch (RemotingTimeoutException e) {
   
     
            if (nettyClientConfig.isClientCloseSocketIfTimeout()) {
   
     
                this.closeChannel(addr, channel);
                log.warn("invokeSync: close socket because of timeout, {}ms, {}", timeoutMillis, addr);
            }
            log.warn("invokeSync: wait response timeout exception, the channel[{}]", addr);
            throw e;
        }
    } else {
   
     
        this.closeChannel(addr, channel);
        throw new RemotingConnectException(addr);
    }
}
```

#### 2.1.1 invokeSyncImpl同步调用实现

invokeSyncImpl方法发起同步调用并获取响应结果。

**1、** 首先创建一个ResponseFuture，然后将本次请求id和respone存入responseTable缓存；
**2、** 随后执行调用，并添加一个ChannelFutureListener，消息发送完毕会进行回调然后responseFuture通过waitResponse方法阻塞当前线程，直到得到响应结果或者到达超时时间；
**3、** 当ChannelFutureListener回调的时候会判断如果消息发送成功，那么设置发送成功并返回，否则设置发送失败标志和失败原因，并且设置响应结果为null，唤醒阻塞的responseFuture；
**4、** responseFuture被唤醒后会进行一系列判断如果响应结果为null，那么会根据不同情况抛出不同的异常，如果响应结果不为null，那么返回响应结果；
**5、** 最后在finaly块中从responseTable中移除响应结果缓存；

```java
/**
 * NettyRemotingAbstract的方法
 * <p>
 * 执行同步调用
 */
public RemotingCommand invokeSyncImpl(final Channel channel, final RemotingCommand request,
                                      final long timeoutMillis)
        throws InterruptedException, RemotingSendRequestException, RemotingTimeoutException {
   
     
    //获取请求id，通过id可以获取请求结果
    final int opaque = request.getOpaque();

    try {
   
     
        //创建一个Future的map成员ResponseFuture
        final ResponseFuture responseFuture = new ResponseFuture(channel, opaque, timeoutMillis, null, null);
        //将请求id和responseFuture存入responseTable缓存中
        this.responseTable.put(opaque, responseFuture);
        final SocketAddress addr = channel.remoteAddress();
        //发送请求，添加一个ChannelFutureListener，消息发送完毕会进行回调
        channel.writeAndFlush(request).addListener(new ChannelFutureListener() {
   
     
            @Override
            public void operationComplete(ChannelFuture f) throws Exception {
   
     
                //如果消息发送成功，那么设置responseFuture发送成功并返回
                if (f.isSuccess()) {
   
     
                    responseFuture.setSendRequestOK(true);
                    return;
                } else {
   
     
                    responseFuture.setSendRequestOK(false);
                }
                //如果发送失败，那么从responseTable移除该缓存
                responseTable.remove(opaque);
                //设置失败原因
                responseFuture.setCause(f.cause());
                //设置响应结果为null，唤醒阻塞的responseFuture
                //其内部调用了countDownLatch.countDown()方法
                responseFuture.putResponse(null);
                log.warn("send a request command to channel <" + addr + "> failed.");
            }
        });
        /*
         *  responseFuture同步阻塞等待直到得到响应结果或者到达超时时间
         * 其内部调用了countDownLatch.await(timeoutMillis, TimeUnit.MILLISECONDS)方法
         */
        RemotingCommand responseCommand = responseFuture.waitResponse(timeoutMillis);
        //如果响应结果为null
        if (null == responseCommand) {
   
     
            //如果是发送成功，但是没有响应，表示等待响应超时，那么抛出超时异常
            if (responseFuture.isSendRequestOK()) {
   
     
                throw new RemotingTimeoutException(RemotingHelper.parseSocketAddressAddr(addr), timeoutMillis,
                        responseFuture.getCause());
            } else {
   
     
                //如果是发送失败，抛出发送失败异常
                throw new RemotingSendRequestException(RemotingHelper.parseSocketAddressAddr(addr), responseFuture.getCause());
            }
        }
        //否则返回响应结果
        return responseCommand;
    } finally {
   
     
        //最后从responseTable中移除响应结果缓存
        this.responseTable.remove(opaque);
    }
}
```

##### 2.1.1.1 请求的阻塞和唤醒

从上面的源码可以得知，同步发送消息的请求可能会经历短暂的阻塞状态。responseFuture通过waitResponse方法阻塞当前线程，直到得到响应结果或者到达超时时间。进入该方法，可以发现其阻塞使用的工具其实就是CountDownLatch。

```java
/**
 * ResponseFuture的方法
 * <p>
 * 同步等待响应结果
 *
 * @param timeoutMillis 超时时间
 */
public RemotingCommand waitResponse(final long timeoutMillis) throws InterruptedException {
   
     
    //使用countDownLatch等待给定的时间
    this.countDownLatch.await(timeoutMillis, TimeUnit.MILLISECONDS);
    return this.responseCommand;
}
```

[CountDownLatch](https://blog.csdn.net/weixin_43767015/article/details/108035192)
也被称为闭锁，它一般用来确保某些活动直到其他活动都完成才继续执行，ResponseFuture中的CountDownLatch的倒计数只有1。

```java
private final CountDownLatch countDownLatch = new CountDownLatch(1);
```

那么什么时候计数变为0呢，那就是调用putResponse方法的时候，该方法有两个调用点，一个是在ChannelFutureListener中判断请求发送失败的时候，直接设置一个null进去，另一个就是请求正常处理完毕的时候，在processResponseCommand方法中会将执行结果设置进去。

putResponse方法源码如下：

```java
/**
 * ResponseFuture的方法
 * <p>
 * 存入响应结果并且唤醒等待的线程
 *
 * @param responseCommand 响应结果
 */
public void putResponse(final RemotingCommand responseCommand) {
   
     
    //存入结果
    this.responseCommand = responseCommand;
    //倒计数减去1，唤醒等待的线程
    this.countDownLatch.countDown();
}
```

**putResponse方法中会调用countDownLatch#countDown方法，此时倒计数为0，此前阻塞的请求线程将会被唤醒。**

#### 2.1.2 processSendResponse处理响应结果

获得响应之后，调用processSendResponse方法处理响应结果，主要就是进行响应码的对应封装操作，然后对发送正常和异常情况分别进行不同的处理并返回sendResult对象。

从源码中可以看到，sendResult的构造器中，将会设置客户端生成的uniqMsgId为msgId属性，设置broker生成的MsgId为offsetMsgId属性。

```java
/**
 * MQClientAPIImpl的方法
 * <p>
 * 处理响应结果
 */
private SendResult processSendResponse(
        final String brokerName,
        final Message msg,
        final RemotingCommand response,
        final String addr
) throws MQBrokerException, RemotingCommandException {
   
     
    SendStatus sendStatus;
    //根据responseCode设置对应的SendStatus
    switch (response.getCode()) {
   
     
        case ResponseCode.FLUSH_DISK_TIMEOUT: {
   
     
            sendStatus = SendStatus.FLUSH_DISK_TIMEOUT;
            break;
        }
        case ResponseCode.FLUSH_SLAVE_TIMEOUT: {
   
     
            sendStatus = SendStatus.FLUSH_SLAVE_TIMEOUT;
            break;
        }
        case ResponseCode.SLAVE_NOT_AVAILABLE: {
   
     
            sendStatus = SendStatus.SLAVE_NOT_AVAILABLE;
            break;
        }
        case ResponseCode.SUCCESS: {
   
     
            sendStatus = SendStatus.SEND_OK;
            break;
        }
        default: {
   
     
            throw new MQBrokerException(response.getCode(), response.getRemark(), addr);
        }
    }
    //获取响应头
    SendMessageResponseHeader responseHeader =
            (SendMessageResponseHeader) response.decodeCommandCustomHeader(SendMessageResponseHeader.class);

    //If namespace not null , reset Topic without namespace.
    //如果命名空间不为null，重置不带命名空间的topic
    String topic = msg.getTopic();
    if (StringUtils.isNotEmpty(this.clientConfig.getNamespace())) {
   
     
        topic = NamespaceUtil.withoutNamespace(topic, this.clientConfig.getNamespace());
    }
    //新建一个MessageQueue，设置属性
    MessageQueue messageQueue = new MessageQueue(topic, brokerName, responseHeader.getQueueId());
    //获取客户端生成的uniqId
    String uniqMsgId = MessageClientIDSetter.getUniqID(msg);
    if (msg instanceof MessageBatch) {
   
     
        StringBuilder sb = new StringBuilder();
        for (Message message : (MessageBatch) msg) {
   
     
            sb.append(sb.length() == 0 ? "" : ",").append(MessageClientIDSetter.getUniqID(message));
        }
        uniqMsgId = sb.toString();
    }
    //新建SendResult，即最终返回的对象，设置客户端生成的uniqMsgId为msgId属性，设置broker生成的MsgId为offsetMsgId属性
    SendResult sendResult = new SendResult(sendStatus,
            uniqMsgId,
            responseHeader.getMsgId(), messageQueue, responseHeader.getQueueOffset());
    //设置事务id
    sendResult.setTransactionId(responseHeader.getTransactionId());
    //设置regionId和traceOn
    String regionId = response.getExtFields().get(MessageConst.PROPERTY_MSG_REGION);
    String traceOn = response.getExtFields().get(MessageConst.PROPERTY_TRACE_SWITCH);
    if (regionId == null || regionId.isEmpty()) {
   
     
        regionId = MixAll.DEFAULT_TRACE_REGION_ID;
    }
    if (traceOn != null && traceOn.equals("false")) {
   
     
        sendResult.setTraceOn(false);
    } else {
   
     
        sendResult.setTraceOn(true);
    }
    sendResult.setRegionId(regionId);
    return sendResult;
}
```

## 3 sendMessageAsync异步发送消息

**该模式下，调用该方法之后不接收返回值，直接返回null，执行完毕之后会自动执行回调函数operationComplete。异步发送同样支持重试。
**

调用异步发送方法传递的**SendCallback**
对象并不会被直接调用，而是会被封装为另一个内部回调对象InvokeCallback，当异步请求获得响应结果，或者超时时间到了之后，会回调它的operationComplete方法。

该方法中会调用**processSendResponse**
方法解析响应结果为SendResult，如果是响应成功的状态，那么接着执行sendCallback的onSuccess方法，这里的sendCallback就是发送消息时传入的回调函数。

随后会调用**updateFaultItem**更新本地更新本地错误表缓存数据，用于延迟时间的故障转移的功能。

**如果抛出了异常，或者没有获取到broker的返回值，那么调用onExceptionImpl方法处理异常，该方法中会继续重试异步调用，这就是异步发送消息重试的逻辑。
**

```java
/**
 * MQClientAPIImpl的方法
 * <p>
 * 异步发送消息的方法，包含重试的逻辑
 *
 * @param retryTimesWhenSendFailed 异步发送失败重试次数
 * @param times                    重试计数器
 */
private void sendMessageAsync(
        final String addr,
        final String brokerName,
        final Message msg,
        final long timeoutMillis,
        final RemotingCommand request,
        final SendCallback sendCallback,
        final TopicPublishInfo topicPublishInfo,
        final MQClientInstance instance,
        final int retryTimesWhenSendFailed,
        final AtomicInteger times,
        final SendMessageContext context,
        final DefaultMQProducerImpl producer
) throws InterruptedException, RemotingException {
   
     
    //起始时间
    final long beginStartTime = System.currentTimeMillis();
    try {
   
     
        /*
         * 发送异步消息，设置一个InvokeCallback回调对象
         *
         * InvokeCallback#operationComplete方法将会在得到结果之后进行回调
         */
        this.remotingClient.invokeAsync(addr, request, timeoutMillis, new InvokeCallback() {
   
     
            /**
             * 异步执行的回调方法
             */
            @Override
            public void operationComplete(ResponseFuture responseFuture) {
   
     
                //花费的时间
                long cost = System.currentTimeMillis() - beginStartTime;
                RemotingCommand response = responseFuture.getResponseCommand();
                //如果没有设置回调函数
                if (null == sendCallback && response != null) {
   
     

                    try {
   
     
                        //调用processSendResponse方法处理响应结果
                        SendResult sendResult = MQClientAPIImpl.this.processSendResponse(brokerName, msg, response, addr);
                        if (context != null && sendResult != null) {
   
     
                            context.setSendResult(sendResult);
                            context.getProducer().executeSendMessageHookAfter(context);
                        }
                    } catch (Throwable e) {
   
     
                    }
                    //更新本地错误表缓存数据，用于延迟时间的故障转移的功能
                    producer.updateFaultItem(brokerName, System.currentTimeMillis() - responseFuture.getBeginTimestamp(), false);
                    return;
                }
                //如果存在响应结果
                if (response != null) {
   
     
                    try {
   
     
                        //调用processSendResponse方法处理响应结果
                        SendResult sendResult = MQClientAPIImpl.this.processSendResponse(brokerName, msg, response, addr);
                        assert sendResult != null;
                        if (context != null) {
   
     
                            context.setSendResult(sendResult);
                            //执行消息发送之后的钩子函数，即SendMessageHook#sendMessageAfter方法
                            context.getProducer().executeSendMessageHookAfter(context);
                        }

                        try {
   
     
                            //响应成功时调用，执行sendCallback的onSuccess方法
                            //这里的sendCallback就是发送消息时传入的回调函数
                            sendCallback.onSuccess(sendResult);
                        } catch (Throwable e) {
   
     
                        }
                        //更新本地错误表缓存数据，用于延迟时间的故障转移的功能
                        producer.updateFaultItem(brokerName, System.currentTimeMillis() - responseFuture.getBeginTimestamp(), false);
                    } catch (Exception e) {
   
     
                        producer.updateFaultItem(brokerName, System.currentTimeMillis() - responseFuture.getBeginTimestamp(), true);
                        //异常处理，不需要重试
                        onExceptionImpl(brokerName, msg, timeoutMillis - cost, request, sendCallback, topicPublishInfo, instance,
                                retryTimesWhenSendFailed, times, e, context, false, producer);
                    }
                } else {
   
     
                    //更新本地错误表缓存数据，用于延迟时间的故障转移的功能
                    producer.updateFaultItem(brokerName, System.currentTimeMillis() - responseFuture.getBeginTimestamp(), true);
                    //异常处理，需要重试
                    //发送失败
                    if (!responseFuture.isSendRequestOK()) {
   
     
                        MQClientException ex = new MQClientException("send request failed", responseFuture.getCause());
                        onExceptionImpl(brokerName, msg, timeoutMillis - cost, request, sendCallback, topicPublishInfo, instance,
                                retryTimesWhenSendFailed, times, ex, context, true, producer);
                    } else if (responseFuture.isTimeout()) {
   
     
                        //超时
                        MQClientException ex = new MQClientException("wait response timeout " + responseFuture.getTimeoutMillis() + "ms",
                                responseFuture.getCause());
                        onExceptionImpl(brokerName, msg, timeoutMillis - cost, request, sendCallback, topicPublishInfo, instance,
                                retryTimesWhenSendFailed, times, ex, context, true, producer);
                    } else {
   
     
                        MQClientException ex = new MQClientException("unknow reseaon", responseFuture.getCause());
                        onExceptionImpl(brokerName, msg, timeoutMillis - cost, request, sendCallback, topicPublishInfo, instance,
                                retryTimesWhenSendFailed, times, ex, context, true, producer);
                    }
                }
            }
        });
    } catch (Exception ex) {
   
     
        long cost = System.currentTimeMillis() - beginStartTime;
        //更新本地错误表缓存数据，用于延迟时间的故障转移的功能
        producer.updateFaultItem(brokerName, cost, true);
        //异常处理
        onExceptionImpl(brokerName, msg, timeoutMillis - cost, request, sendCallback, topicPublishInfo, instance,
                retryTimesWhenSendFailed, times, ex, context, true, producer);
    }
}
```

### 3.1 invokeAsync异步调用

该方法执行异步调用。首先获取或者创建生产者与broker通道，即连接。然后在发送消息前后执行rpcHook钩子方法，即RPCHook#doBeforeRequest方法，最后通过调用invokeAsyncImpl方法发起异步调用。

```java
/**
 * NettyRemotingClient的方法
 * 异步发送消息
 */
@Override
public void invokeAsync(String addr, RemotingCommand request, long timeoutMillis, InvokeCallback invokeCallback)
        throws InterruptedException, RemotingConnectException, RemotingTooMuchRequestException, RemotingTimeoutException,
        RemotingSendRequestException {
   
     
    //开始时间
    long beginStartTime = System.currentTimeMillis();
    //获取或创建一个与broker的连接
    final Channel channel = this.getAndCreateChannel(addr);
    if (channel != null && channel.isActive()) {
   
     
        try {
   
     
            //执行rpc钩子的doBeforeRequest方法
            doBeforeRpcHooks(addr, request);
            //如果超时，则直接抛出异常，不再执行
            long costTime = System.currentTimeMillis() - beginStartTime;
            if (timeoutMillis < costTime) {
   
     
                throw new RemotingTooMuchRequestException("invokeAsync call the addr[" + addr + "] timeout");
            }
            //执行异步远程调用
            this.invokeAsyncImpl(channel, request, timeoutMillis - costTime, invokeCallback);
        } catch (RemotingSendRequestException e) {
   
     
            log.warn("invokeAsync: send request exception, so close the channel[{}]", addr);
            this.closeChannel(addr, channel);
            throw e;
        }
    } else {
   
     
        this.closeChannel(addr, channel);
        throw new RemotingConnectException(addr);
    }
}
```

#### 3.1.1 invokeAsyncImpl异步调用实现

invokeAsyncImpl方法发起异步调用。该方法和单向发送的方法一样，都会基于[Semaphore信号量](https://blog.csdn.net/weixin_43767015/article/details/108079508)
尝试获取异步发送的资源，通过信号量控制异步消息并发发送的消息数，从而保护系统内存占用。客户端单向发送的Semaphore信号量默认为65535，即异步消息最大并发为65535，可通过配置"
com.rocketmq.remoting.clientAsyncSemaphoreValue"系统变量更改。

在获取到了信号量资源之后。构建SemaphoreReleaseOnlyOnce对象，保证信号量本次只被释放一次，防止并发操作引起线程安全问题，然后就通过channel发送请求即可。

然后创建一个ResponseFuture，设置超时时间、回调函数。然后将本次请求id和respone存入responseTable缓存。

随后执行调用，并添加一个ChannelFutureListener，消息发送完毕会进行回调。当ChannelFutureListener回调的时候会判断如果消息发送成功，那么设置发送成功并返回，否则如果发送失败了，则移除缓存、设置false、并且执行InvokeCallback#operationComplete回调。

如果发送成功了，那么InvokeCallback#operationComplete回调会执行吗，当让会了，当请求正常处理完毕的时候，在processResponseCommand方法中会将执行InvokeCallback#operationComplete回调。

```java
/**
 * NettyRemotingAbstract的方法
 * <p>
 * 异步调用实现
 */
public void invokeAsyncImpl(final Channel channel, final RemotingCommand request, final long timeoutMillis,
                            final InvokeCallback invokeCallback)
        throws InterruptedException, RemotingTooMuchRequestException, RemotingTimeoutException, RemotingSendRequestException {
   
     
    //起始时间
    long beginStartTime = System.currentTimeMillis();
    //获取请求id，通过id可以获取请求结果
    final int opaque = request.getOpaque();
    //基于Semaphore信号量尝试获取异步发送的资源，通过信号量控制异步消息并发发送的消息数，从而保护系统内存占用。
    //客户端异步发送的Semaphore信号量默认为65535，可通过配置"com.rocketmq.remoting.clientOnewaySemaphoreValue"系统变量更改
    boolean acquired = this.semaphoreAsync.tryAcquire(timeoutMillis, TimeUnit.MILLISECONDS);
    //如果获取到了信号量资源
    if (acquired) {
   
     
        //构建SemaphoreReleaseOnlyOnce对象，保证信号量本次只被释放一次，防止并发操作引起线程安全问题
        final SemaphoreReleaseOnlyOnce once = new SemaphoreReleaseOnlyOnce(this.semaphoreAsync);
        //如果超时，则不发送
        long costTime = System.currentTimeMillis() - beginStartTime;
        if (timeoutMillis < costTime) {
   
     
            once.release();
            throw new RemotingTimeoutException("invokeAsyncImpl call timeout");
        }
        //创建一个Future的map成员ResponseFuture，设置超时时间、回调函数
        final ResponseFuture responseFuture = new ResponseFuture(channel, opaque, timeoutMillis - costTime, invokeCallback, once);
        //将请求id和responseFuture存入responseTable缓存中
        this.responseTable.put(opaque, responseFuture);
        try {
   
     
            //发送请求，添加一个ChannelFutureListener，消息发送完毕会进行回调
            channel.writeAndFlush(request).addListener(new ChannelFutureListener() {
   
     
                @Override
                public void operationComplete(ChannelFuture f) throws Exception {
   
     
                    //如果消息发送成功，那么设置responseFuture发送成功并返回
                    if (f.isSuccess()) {
   
     
                        responseFuture.setSendRequestOK(true);
                        return;
                    }
                    /*
                     * 如果发送失败，则移除缓存、设置false、并且执行InvokeCallback#operationComplete回调
                     */
                    requestFail(opaque);
                    log.warn("send a request command to channel <{}> failed.", RemotingHelper.parseChannelRemoteAddr(channel));
                }
            });
        } catch (Exception e) {
   
     
            //释放信号量
            responseFuture.release();
            log.warn("send a request command to channel <" + RemotingHelper.parseChannelRemoteAddr(channel) + "> Exception", e);
            throw new RemotingSendRequestException(RemotingHelper.parseChannelRemoteAddr(channel), e);
        }
    } else {
   
     
        //如果没有获取到信号量资源，那么直接抛出异常即可，并且不再发送
        if (timeoutMillis <= 0) {
   
     
            throw new RemotingTooMuchRequestException("invokeAsyncImpl invoke too fast");
        } else {
   
     
            String info =
                    String.format("invokeAsyncImpl tryAcquire semaphore timeout, %dms, waiting thread nums: %d semaphoreAsyncValue: %d",
                            timeoutMillis,
                            this.semaphoreAsync.getQueueLength(),
                            this.semaphoreAsync.availablePermits()
                    );
            log.warn(info);
            throw new RemotingTimeoutException(info);
        }
    }
}
```

### 3.2 onExceptionImpl异常处理

异步调用如果发生了异常，例如broker返回了错入的响应，或者没有获得响应，那会会执行onExceptionImpl这个异常处理方法。

可以看到，所谓的重试实际上就是重复的调用sendMessageAsync方法。重试之前，首先会判断本次重试的次数是否大于重试总次数，参数为retryTimesWhenSendFailed，默认2次。如果超过了最大重试次数，那么便不会重试，而是执行
**sendCallback#onException**方法。

```java
/**
 * MQClientAPIImpl的方法
 * <p>
 * 异步发送消息的异常处理的方法，包含重试的逻辑
 *
 * @param e          抛出的异常
 * @param timesTotal 异步发送失败重试次数
 * @param curTimes   重试计数器
 * @param needRetry  是否需要重试
 */
private void onExceptionImpl(final String brokerName,
                             final Message msg,
                             final long timeoutMillis,
                             final RemotingCommand request,
                             final SendCallback sendCallback,
                             final TopicPublishInfo topicPublishInfo,
                             final MQClientInstance instance,
                             final int timesTotal,
                             final AtomicInteger curTimes,
                             final Exception e,
                             final SendMessageContext context,
                             final boolean needRetry,
                             final DefaultMQProducerImpl producer
) {
   
     
    //重试次数加1并获取
    int tmp = curTimes.incrementAndGet();
    /*
     * 如果需要重试，并且本次重试次数小于等于总次数
     */
    if (needRetry && tmp <= timesTotal) {
   
     
        //保存brokerName，异步重试将会发送到相同的broker
        String retryBrokerName = brokerName;//by default, it will send to the same broker
        if (topicPublishInfo != null) {
   
      //select one message queue accordingly, in order to determine which broker to send
            //选择一个消息队列
            MessageQueue mqChosen = producer.selectOneMessageQueue(topicPublishInfo, brokerName);
            retryBrokerName = mqChosen.getBrokerName();
        }
        String addr = instance.findBrokerAddressInPublish(retryBrokerName);
        log.warn(String.format("async send msg by retry {} times. topic={}, brokerAddr={}, brokerName={}", tmp, msg.getTopic(), addr,
                retryBrokerName), e);
        try {
   
     
            //设置请求id，通过id可以获取请求结果
            request.setOpaque(RemotingCommand.createNewRequestId());
            //调用sendMessageAsync再次发送异步消息
            sendMessageAsync(addr, retryBrokerName, msg, timeoutMillis, request, sendCallback, topicPublishInfo, instance,
                    timesTotal, curTimes, context, producer);
        } catch (InterruptedException e1) {
   
     
            //不再重试，设置异常
            onExceptionImpl(retryBrokerName, msg, timeoutMillis, request, sendCallback, topicPublishInfo, instance, timesTotal, curTimes, e1,
                    context, false, producer);
        } catch (RemotingTooMuchRequestException e1) {
   
     
            //不再重试，设置异常
            onExceptionImpl(retryBrokerName, msg, timeoutMillis, request, sendCallback, topicPublishInfo, instance, timesTotal, curTimes, e1,
                    context, false, producer);
        } catch (RemotingException e1) {
   
     
            //更新异常表
            producer.updateFaultItem(brokerName, 3000, true);
            //继续重试
            onExceptionImpl(retryBrokerName, msg, timeoutMillis, request, sendCallback, topicPublishInfo, instance, timesTotal, curTimes, e1,
                    context, true, producer);
        }
    } else {
   
     
        //如果本次重试次数大于总次数
        if (context != null) {
   
     
            context.setException(e);
            context.getProducer().executeSendMessageHookAfter(context);
        }

        try {
   
     
            //最后执行sendCallback的onException方法
            sendCallback.onException(e);
        } catch (Exception ignored) {
   
     
        }
    }
}
```

## 4 NettyClientHandler处理服务端消息

RocketMQ在启动的时候，在MQClientInstance的start方法中，会创建一个netty客户端，然后会添加一个处理器NettyClientHandler。

这个NettyClientHandler用于处理RemotingCommand消息，即来处理自服务端的请求消息，或者客户端发出去的请求消息后，服务的返回来的响应消息。

```java
/**
 * NettyRemotingClient的内部类
 * <p>
 * 处理来自服务端的RemotingCommand消息
 */
class NettyClientHandler extends SimpleChannelInboundHandler<RemotingCommand> {
   
     

    /**
     * 处理来自服务端的RemotingCommand消息
     */
    @Override
    protected void channelRead0(ChannelHandlerContext ctx, RemotingCommand msg) throws Exception {
   
     
        processMessageReceived(ctx, msg);
    }
}
```

NettyClientHandler通过processMessageReceived方法处理RemotingCommand消息。

```java
/**
 * NettyRemotingAbstract的方法
 * <p>
 * 处理RemotingCommand命令消息，传入的远程处理命令可能是：
 * 1、来自远程对等组件的查询请求
 * 2、对该参与者之前发出的请求的响应
 */
public void processMessageReceived(ChannelHandlerContext ctx, RemotingCommand msg) throws Exception {
   
     
    final RemotingCommand cmd = msg;
    if (cmd != null) {
   
     
        switch (cmd.getType()) {
   
     
            //处理来源服务端的请求request
            case REQUEST_COMMAND:
                processRequestCommand(ctx, cmd);
                break;
            //处理来源服务端的响应response
            case RESPONSE_COMMAND:
                //客户端发送消息之后服务端的响应会被processResponseCommand方法处理
                processResponseCommand(ctx, cmd);
                break;
            default:
                break;
        }
    }
}
```

这里我们主要看**processResponseCommand**方法，即客户端发送消息之后服务端的响应会被**processResponseCommand**方法处理。

### 4.1 processResponseCommand处理响应

客户端发送消息之后服务端的响应会被processResponseCommand方法处理。消息发送请求的响应处理也是该方法完成的。其大概流程为：

**1、** 先根据请求id找到之前放到responseTable的ResponseFuture，然后从responseTable中移除ResponseFuture缓存；
**2、** 判断如果存在回调函数，即异步请求，那么调用executeInvokeCallback方法，该方法会执行回调函数的方法；
**3、** 如果没有回调函数，则调用putResponse方法该方法将响应数据设置到responseCommand，然后调用countDownLatch.countDown，即倒计数减去1，唤醒等待的线程；

```java
/**
 * NettyRemotingAbstract的方法
 * <p>
 * 客户端发送消息之后服务端的响应会被processResponseCommand方法处理
 */
public void processResponseCommand(ChannelHandlerContext ctx, RemotingCommand cmd) {
   
     
    //获取请求id，通过id可以获取请求结果
    final int opaque = cmd.getOpaque();
    //根据请求标识找到之前放到responseTable的ResponseFuture
    final ResponseFuture responseFuture = responseTable.get(opaque);
    if (responseFuture != null) {
   
     
        responseFuture.setResponseCommand(cmd);
        //从responseTable中移除该响应
        responseTable.remove(opaque);

        if (responseFuture.getInvokeCallback() != null) {
   
     
            //如果存在回调函数，即异步请求
            //那么调用回调函数的方法
            executeInvokeCallback(responseFuture);
        } else {
   
     
            //如果时同步请求，则调用putResponse方法
            //该方法将响应数据设置到responseCommand，然后调用countDownLatch.countDown，即倒计数减去1，唤醒等待的线程
            responseFuture.putResponse(cmd);
            responseFuture.release();
        }
    } else {
   
     
        log.warn("receive response, but not matched any request, " + RemotingHelper.parseChannelRemoteAddr(ctx.channel()));
        log.warn(cmd.toString());
    }
}
```

#### 4.1.1 executeInvokeCallback执行回调函数

该方法主要是在异步请求的时候被调用，例如之前的异步发送消息，之前我们知道，异步请求发送的时候，会同时指定一个回调函数。而当前获得来自服务端的响应之后，就会调用了该回调函数。

该方法尝试在回调执行器中执行回调操作，如果回调执行器为null，则在当前线程中执行回调。

```java
/**
 * NettyRemotingAbstract的方法
 * <p>
 * 在回调执行器中执行回调操作，如果回调执行器为null，则在当前线程中执行回调
 */
private void executeInvokeCallback(final ResponseFuture responseFuture) {
   
     
    boolean runInThisThread = false;
    //获取回调执行器，如果没有设置回调执行器callbackExecutor（默认没有），那么使用publicExecutor
    ExecutorService executor = this.getCallbackExecutor();
    if (executor != null) {
   
     
        try {
   
     
            executor.submit(new Runnable() {
   
     
                @Override
                public void run() {
   
     
                    try {
   
     
                        //通过线程池异步的执行回调操作
                        responseFuture.executeInvokeCallback();
                    } catch (Throwable e) {
   
     
                        log.warn("execute callback in executor exception, and callback throw", e);
                    } finally {
   
     
                        responseFuture.release();
                    }
                }
            });
        } catch (Exception e) {
   
     
            runInThisThread = true;
            log.warn("execute callback in executor exception, maybe executor busy", e);
        }
    } else {
   
     
        runInThisThread = true;
    }
    //在本线程中执行回调操作
    if (runInThisThread) {
   
     
        try {
   
     
            responseFuture.executeInvokeCallback();
        } catch (Throwable e) {
   
     
            log.warn("executeInvokeCallback Exception", e);
        } finally {
   
     
            responseFuture.release();
        }
    }
}
```

##### 4.1.1.1 executeInvokeCallback指定回调

该方法将会调用**invokeCallback.operationComplete**回调方法，这个方法我们之前在异步发送请求的时候就讲过了。

```java
/**
 * ResponseFuture的方法
 */
public void executeInvokeCallback() {
   
     
    if (invokeCallback != null) {
   
     
        //通过cas保证只允许一次调用
        if (this.executeCallbackOnlyOnce.compareAndSet(false, true)) {
   
     
            //执行回调器的回调方法operationComplete
            invokeCallback.operationComplete(this);
        }
    }
}
```

#### 4.1.2 putResponse存入响应

该方法主要是在同步请求的时候被调用，例如之前的同步发送消息，之前我们知道，同步请求发送之后，请求线程会阻塞。而当前获得来自服务端的响应之后，就会调用了该方法。

该方法将响应数据设置到**responseCommand**，然后调用**countDownLatch.countDown**，即倒计数减去1，唤醒等待的线程。

```java
/**
 * ResponseFuture的方法
 * <p>
 * 存入响应结果并且唤醒等待的线程
 *
 * @param responseCommand 响应结果
 */
public void putResponse(final RemotingCommand responseCommand) {
   
     
    //存入结果
    this.responseCommand = responseCommand;
    //倒计数减去1，唤醒等待的线程
    this.countDownLatch.countDown();
}
```

## 5 总结

本次我们讲解了重要的发送消息的内部方法**MQClientAPIImpl#sendMessage**的源码，该方法内部又会根据发送模式执行不同的发送逻辑。
*
*单向发送模式调用RemotingClient#invokeOneway方法；异步发送模式调用MQClientAPIImpl#sendMessageAsync方法；同步发送模式调用MQClientAPIImpl#sendMessageSync方法。在异步和同步模式发送方法的调用前还会再检查是否超时，如果超时则不再调用。
**

**同步发送模式内部采用CountDownLatch工具实现线程的阻塞和唤醒**
，当发送了同步消息之后，当前线程阻塞，当服务端响应返回之后，将会通过CountDownLatch减少倒计数来唤醒阻塞的线程。发送请求和响应怎么对应上的呢？发送请求的时候会生成并带上本次请求的请求Id，客户端返回响应中带有对应的请求的请求Id，这样就能对应上了。

**同步发送和异步发送模式都会有消息重试**
，消息发送过程中如果抛出了RemotingException、MQClientException、以及部分MQBrokerException异常时，那么会进行重试，**默认重试2次
**。如果抛出了**InterruptedException**，或者因为**超时**则不再重试。