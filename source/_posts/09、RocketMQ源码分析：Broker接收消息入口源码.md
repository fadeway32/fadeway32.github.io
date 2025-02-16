---

layout: 09、RocketMQ源码分析：Broker接收消息入口源码

title:  09、RocketMQ源码分析：Broker接收消息入口源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713334

abbrlink: 1739713334

date: 2025-02-16 21:42:06


--- 

# 09、RocketMQ源码分析：Broker接收消息入口源码

*
*此前我们学习了RocketMQ的Producer发送消息的源码，首先会查找查找topic的发布信息，然后找到一个消息队列MessageQueue，默认是轮询的选择，MessageQueue中存储着对应的brokerName，通过brokerName就能找到具体的brokerIP，随后获取producer客户端与这台broker的channel，随后就可以向这台broker发送消息了，注意消息只会被发送到主Broker中，即Master节点。
**

**以上就是RocketMQ的Producer发送消息的大概路程，下面我们来学习RocketMQ的Broker接收消息、处理请求的源码。**

#### 文章目录

- 1 Broker处理请求入口
-
    - 1.1 registerProcessor注册消息处理器
- 1.2 NettyServerHandler处理请求
- 1.3 processRequestCommand分发处理请求
-
    - 1.3.1 rejectRequest是否拒绝请求
    -
        - 1.3.1.1 isOSPageCacheBusy操作系统页缓存是否繁忙
        - 1.3.1.2 isTransientStorePoolDeficient检查临时存储池是否不足
- 2 asyncProcessRequest异步处理请求
-
    - 2.1 asyncProcessRequest异步处理请求
-
    - 2.1.1 parseRequestHeader解析请求头
- 3 总结

## 1 Broker处理请求入口

### 1.1 registerProcessor注册消息处理器

RocketMQ的各种组件的网络通信都是基于Netty实现的。我们在此前学习RocketMQ的Broker的启动源码的时候，会发现Broker在启动的时候在BrokerController#registerProcessor方法中会注册很多的netty消息处理器，不同的消息处理器可以处理不同的消息类型。

```java
/**
 * BrokerController的方法
 * 注册netty消息处理器
 */
public void registerProcessor() {
   
     
    /**
     * 发送消息处理器
     */
    SendMessageProcessor sendProcessor = new SendMessageProcessor(this);
    sendProcessor.registerSendMessageHook(sendMessageHookList);
    sendProcessor.registerConsumeMessageHook(consumeMessageHookList);

    //对于发送类型的请求，使用发送消息处理器sendProcessor来处理
    this.remotingServer.registerProcessor(RequestCode.SEND_MESSAGE, sendProcessor, this.sendMessageExecutor);
    this.remotingServer.registerProcessor(RequestCode.SEND_MESSAGE_V2, sendProcessor, this.sendMessageExecutor);
    this.remotingServer.registerProcessor(RequestCode.SEND_BATCH_MESSAGE, sendProcessor, this.sendMessageExecutor);
    this.remotingServer.registerProcessor(RequestCode.CONSUMER_SEND_MSG_BACK, sendProcessor, this.sendMessageExecutor);
    this.fastRemotingServer.registerProcessor(RequestCode.SEND_MESSAGE, sendProcessor, this.sendMessageExecutor);
    this.fastRemotingServer.registerProcessor(RequestCode.SEND_MESSAGE_V2, sendProcessor, this.sendMessageExecutor);
    this.fastRemotingServer.registerProcessor(RequestCode.SEND_BATCH_MESSAGE, sendProcessor, this.sendMessageExecutor);
    this.fastRemotingServer.registerProcessor(RequestCode.CONSUMER_SEND_MSG_BACK, sendProcessor, this.sendMessageExecutor);
    //……………………省略其他处理器的注册
}
```

其中，**SendMessageProcessor**
这个处理器被用来专门处理发送消息请求，也就是说Producer的发送消息类请求都是通过这个处理器来处理的。这些处理器会连同对应的执行器线程池一起构建一个Pair对象，然后以requestCode为key，Pair对象为value注册到processorTable集合缓存中。

```java
/**
 * NettyRemotingServer的方法，注册netty请求处理器
 * @param requestCode 请求编码
 * @param processor 请求处理器
 * @param executor 请求执行器
 */
@Override
public void registerProcessor(int requestCode, NettyRequestProcessor processor, ExecutorService executor) {
   
     
    ExecutorService executorThis = executor;
    if (null == executor) {
   
     
        //默认执行器是publicExecutor，线程数默认4个线程，线程名以NettyServerPublicExecutor_为前缀。
        executorThis = this.publicExecutor;
    }
    //构建Pair对象
    Pair<NettyRequestProcessor, ExecutorService> pair = new Pair<NettyRequestProcessor, ExecutorService>(processor, executorThis);
    //存入nettyremotingServer的processorTable属性中
    this.processorTable.put(requestCode, pair);
}
```

### 1.2 NettyServerHandler处理请求

当Netty服务端接收到消息的时候，首先会在NettyServerHandler中进行处理。

```java
@ChannelHandler.Sharable
class NettyServerHandler extends SimpleChannelInboundHandler<RemotingCommand> {
   
     

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, RemotingCommand msg) throws Exception {
   
     
        //Netty服务端业务请求处理器的入口
        processMessageReceived(ctx, msg);
    }
}
```

具体的处理器方法就是**processMessageReceived**方法了，在这个方法中，会根据请求code将请求分发给不同的处理器进行处理。

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
                //客户端发送消息之后请求会在服务端被processRequestCommand方法处理
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

这个方法我们在学习Producer发送消息源码的时候就见过了，它会根据接收到的消息是请求还是响应选择不同的方法处理，如果是请求消息则调用processRequestCommand方法，如果是响应消息则调用processResponseCommand方法。在这里，是Broker端接收Producer的请求，因此会调用processRequestCommand方法处理，而如果是Producer端接收到了Broker的响应，则是调用processResponseCommand方法处理。

### 1.3 processRequestCommand分发处理请求

该方法是服务端用来处理来自客户端的请求指令的入口方法，大概流程为：

**1、**
首先从请求中获取requestCode，然后根据此code从processorTable这个本地缓存变量中找到对应的processor以及对应的处理线程池如果该Code没有注册的RequestProcessor，则采用DefaultRequestProcessor作为请求处理器；
**2、** 然后会创建一个线程任务Runnable，该线程任务中：；

**1、** 首先会回去远程地址，然后执行前置钩子方法；
**2、** 然后创建一个响应回调函数RemotingResponseCallback，在获得响应之后会执行该函数该函数中会先执行后置钩子方法，然后判断如果响应response不为null，则写响应；
**3、**
然后会判断执行器是不是异步执行器，如果是的话那么直接调用执行器的asyncProcessRequest方法处理请求以及执行回调函数否则直接调用processRequest方法，然后同步等待获取response，最后调用回调函数的callback方法；
**3、** 判断如果该请求处理器拒绝该请求，那么返回系统繁忙的响应SYSTEM_BUSY：[REJECTREQUEST]
systembusy,startflowcontrolforawhile；
**4、** 根据此前创建的Runnable创建请求任务RequesTask对象，随后通过对应的请求执行器线程池执行这个任务，这里就是支持多线程并发的执行请求处理的逻辑，也是RocketMQRPC通信模型中的M2；

模型中的M2；

```java
/**
 * NettyRemotingAbstract的方法
 * <p>
 * 处理远程对等方发出的传入请求命令
 */
public void processRequestCommand(final ChannelHandlerContext ctx, final RemotingCommand cmd) {
   
     
    //根据 RemotingCommand 的业务请求码code去processorTable这个本地缓存变量中找到对应的 processor以及对应的处理线程池
    final Pair<NettyRequestProcessor, ExecutorService> matched = this.processorTable.get(cmd.getCode());
    //如果该Code没有注册的RequestProcessor，则采用DefaultRequestProcessor作为默认请求处理器，使用remotingExecutor作为默认请求执行器
    final Pair<NettyRequestProcessor, ExecutorService> pair = null == matched ? this.defaultRequestProcessor : matched;
    //获取该请求的唯一id
    final int opaque = cmd.getOpaque();

    if (pair != null) {
   
     
        /*
         * 1 创建一个用于执行请求处理的线程任务
         */
        Runnable run = new Runnable() {
   
     
            @Override
            public void run() {
   
     
                try {
   
     
                    //获取远程地址
                    String remoteAddr = RemotingHelper.parseChannelRemoteAddr(ctx.channel());
                    //执行前置钩子方法
                    doBeforeRpcHooks(remoteAddr, cmd);
                    /*
                     * 创建响应回调函数
                     */
                    final RemotingResponseCallback callback = new RemotingResponseCallback() {
   
     
                        @Override
                        public void callback(RemotingCommand response) {
   
     
                            //执行后置钩子方法
                            doAfterRpcHooks(remoteAddr, cmd, response);
                            //如果不是单向消息
                            if (!cmd.isOnewayRPC()) {
   
     
                                //如果响应不为null
                                if (response != null) {
   
     
                                    //设置响应id为请求id，标记响应状态
                                    response.setOpaque(opaque);
                                    response.markResponseType();
                                    try {
   
     
                                        //将响应写回给客户端
                                        ctx.writeAndFlush(response);
                                    } catch (Throwable e) {
   
     
                                        log.error("process request over, but response failed", e);
                                        log.error(cmd.toString());
                                        log.error(response.toString());
                                    }
                                } else {
   
     
                                }
                            }
                        }
                    };
                    /*
                     * 调用处理器处理请求
                     */
                    //
                    if (pair.getObject1() instanceof AsyncNettyRequestProcessor) {
   
     
                        //如果处理器是异步请求处理器，那么调用异步处理的方法asyncProcessRequest
                        //SendMessageProcessor就是一个异步消息处理器
                        AsyncNettyRequestProcessor processor = (AsyncNettyRequestProcessor) pair.getObject1();
                        processor.asyncProcessRequest(ctx, cmd, callback);
                    } else {
   
     
                        //如果处理器不是异步请求处理器，那么调用同步处理的方法processRequest获取响应，然后同步调用callback回调方法
                        NettyRequestProcessor processor = pair.getObject1();
                        RemotingCommand response = processor.processRequest(ctx, cmd);
                        callback.callback(response);
                    }
                } catch (Throwable e) {
   
     
                    log.error("process request exception", e);
                    log.error(cmd.toString());
                    //如果不是单向的请求，那么返回系统异常的响应SYSTEM_ERROR
                    if (!cmd.isOnewayRPC()) {
   
     
                        final RemotingCommand response = RemotingCommand.createResponseCommand(RemotingSysResponseCode.SYSTEM_ERROR,
                                RemotingHelper.exceptionSimpleDesc(e));
                        response.setOpaque(opaque);
                        ctx.writeAndFlush(response);
                    }
                }
            }
        };

        /*
         * 2 如果该请求处理器拒绝该请求，那么返回系统繁忙的响应SYSTEM_BUSY
         */
        if (pair.getObject1().rejectRequest()) {
   
     
            final RemotingCommand response = RemotingCommand.createResponseCommand(RemotingSysResponseCode.SYSTEM_BUSY,
                    "[REJECTREQUEST]system busy, start flow control for a while");
            response.setOpaque(opaque);
            ctx.writeAndFlush(response);
            return;
        }
        /*
         * 3 构建请求线程任务，然后通过执行器线程池执行
         */
        try {
   
     
            //构建线程任务
            final RequestTask requestTask = new RequestTask(run, ctx.channel(), cmd);
            //通过对应的请求执行器执行，这里支持多线程并发的执行请求处理
            pair.getObject2().submit(requestTask);
        } catch (RejectedExecutionException e) {
   
     
            if ((System.currentTimeMillis() % 10000) == 0) {
   
     
                log.warn(RemotingHelper.parseChannelRemoteAddr(ctx.channel())
                        + ", too many requests and system thread pool busy, RejectedExecutionException "
                        + pair.getObject2().toString()
                        + " request code: " + cmd.getCode());
            }
            //返回系统繁忙响应
            if (!cmd.isOnewayRPC()) {
   
     
                final RemotingCommand response = RemotingCommand.createResponseCommand(RemotingSysResponseCode.SYSTEM_BUSY,
                        "[OVERLOAD]system busy, start flow control for a while");
                response.setOpaque(opaque);
                ctx.writeAndFlush(response);
            }
        }
    } else {
   
     
        //没找到任何请求处理器，返回不支持该请求code的响应
        String error = " request type " + cmd.getCode() + " not supported";
        final RemotingCommand response =
                RemotingCommand.createResponseCommand(RemotingSysResponseCode.REQUEST_CODE_NOT_SUPPORTED, error);
        response.setOpaque(opaque);
        ctx.writeAndFlush(response);
        log.error(RemotingHelper.parseChannelRemoteAddr(ctx.channel()) + error);
    }
}
```

#### 1.3.1 rejectRequest是否拒绝请求

在调用执行器处理请求之前，会调用处理器的rejectRequest方法，判断该处理器能否处理该请求。

不同的处理器对于rejectRequest方法有不同的实现，如果是SendMessageProcessor，那么它的实现为：检查操作系统页缓存PageCache是否繁忙或者检查临时存储池transientStorePool是否不足，如果其中有一个不满足要求，则拒绝处理该请求。

```java
/**
 * SendMessageProcessor的方法
 * <p>
 * 是否需要拒绝处理该请求
 */
@Override
public boolean rejectRequest() {
   
     
    //检查操作系统页缓存PageCache是否繁忙或者检查临时存储池transientStorePool是否不足，如果其中有一个不满足要求，则拒绝处理该请求
    return this.brokerController.getMessageStore().isOSPageCacheBusy() ||
            this.brokerController.getMessageStore().isTransientStorePoolDeficient();
}
```

##### 1.3.1.1 isOSPageCacheBusy操作系统页缓存是否繁忙

一个broker将所有的消息都追加到同一个逻辑CommitLog日志文件中，因此需要通过获取putMessageLock锁来控制并发。

Diff表示锁的持有时间，当前时间减去获取锁开始时间，这个时间可以看作是处理上一个消息目前所花费的时间。

如果broker持有锁的时间超过**osPageCacheBusyTimeOutMills**
，则算作操作系统页缓存繁忙，那么会拒绝处理当前请求，直观现象就是客户端抛出**[REJECTREQUEST]system busy, start flow control
for a while**异常。**osPageCacheBusyTimeOutMills**可以配置，**默认为1000ms，即1s**。

```java
/**
 * DefaultMessageStore的方法
 * <p>
 * 操作系统页缓存是否繁忙
 */
@Override
public boolean isOSPageCacheBusy() {
   
     
    //一个broker将所有的消息都追加到同一个逻辑CommitLog日志文件中，因此需要通过获取putMessageLock锁来控制并发。
    //begin表示获取CommitLog锁的开始时间
    long begin = this.getCommitLog().getBeginTimeInLock();
    //计算锁的持有时间，当前时间减去获取锁开始时间，这个时间可以看作是处理上一个消息目前所花费的时间
    long diff = this.systemClock.now() - begin;
    //如果broker持有锁的时间超过osPageCacheBusyTimeOutMills，则算作操作系统页缓存繁忙，那么会拒绝处理当前请求
    //直观现象就是客户端抛出[REJECTREQUEST]system busy, start flow control for a while异常
    //osPageCacheBusyTimeOutMills可以配置，默认为1000ms，即1s
    return diff < 10000000
            && diff > this.messageStoreConfig.getOsPageCacheBusyTimeOutMills();
}
```

##### 1.3.1.2 isTransientStorePoolDeficient检查临时存储池是否不足

如果启用commitLog临时存储池，那么检查当前可用的buffers堆外内存的数量是否不足。RocketMQ中引入的 transientStorePoolEnable
能缓解 pagecache
的压力，其原理是基于DirectByteBuffer和MappedByteBuffer的读写分离，消息先写入DirectByteBuffer（堆外内存），随后从MappedByteBuffer（pageCache）读取。

```java
/**
 * DefaultMessageStore的方法
 * 检查临时存储池是否不足
 */
@Override
public boolean isTransientStorePoolDeficient() {
   
     
    //如果堆外内存池个数为0，则表示临时存储池是否不足
    return remainTransientStoreBufferNumbs() == 0;
}
public int remainTransientStoreBufferNumbs() {
   
     
    //检查可用buffers
    return this.transientStorePool.availableBufferNums();
}
```

仅当**transientStorePoolEnable**为true（默认false）且FlushDiskType为**ASYNC_FLUSH**
且当前broker不是SLAVE角色时，才启用commitLog临时存储池。如果没开启commitLog临时存储池，那么返回最大int值。

```java
/**
 * TransientStorePool的方法
 * @return
 */
public int availableBufferNums() {
   
     
    //如果启动，则返回可用的堆外内存池的数量
    if (storeConfig.isTransientStorePoolEnable()) {
   
     
        return availableBuffers.size();
    }
    //如果没开启则返回最大int值
    return Integer.MAX_VALUE;
}

/**
 * MessageStoreConfig的方法
 * <p>
 * 仅当transientStorePoolEnable为true（默认false）且FlushDiskType为ASYNC_FLUSH且当前broker不是SLAVE角色时，才启用commitLog临时存储池
 */
public boolean isTransientStorePoolEnable() {
   
     
    return transientStorePoolEnable && FlushDiskType.ASYNC_FLUSH == getFlushDiskType()
            && BrokerRole.SLAVE != getBrokerRole();
}
```

## 2 asyncProcessRequest异步处理请求

生产者发送消息的请求，将会被Broker的SendMessageProcessor处理器处理，并且被SendMessageProcessor执行器并发执行。

SendMessageProcessor属于AsyncNettyRequestProcessor，因此会调用asyncProcessRequest方法执行请求和响应回调函数。

```java
/**
 * SendMessageProcessor的方法
 * <p>
 * 异步处理请求，默认走该方法
 */
@Override
public void asyncProcessRequest(ChannelHandlerContext ctx, RemotingCommand request, RemotingResponseCallback responseCallback) throws Exception {
   
     
    //调用asyncProcessRequest处理请求，然后调用thenAcceptAsync异步的执行回调
    asyncProcessRequest(ctx, request).thenAcceptAsync(responseCallback::callback, this.brokerController.getPutMessageFutureExecutor());
}
```

该方法调用另一个**asyncProcessRequest**方法异步处理请求，然后调用**thenAcceptAsync**方法异步的执行回调。

### 2.1 asyncProcessRequest异步处理请求

asyncProcessRequest方法根据不同的RequestCode异步处理请求。如果RequestCode是CONSUMER_SEND_MSG_BACK，即消费者发送的消息回退请求，那么调用asyncConsumerSendMsgBack方法处理，其他情况下走默认处理逻辑。
默认处理逻辑中，首先解析请求头，然后构建发送请求消息轨迹上下文，随后执行发送消息前钩子方法，最后判断如果是批量消息请求，那么调用asyncSendBatchMessage方法执行处理批量发送消息逻辑，否则调用asyncSendMessage方法处理其他发送消息逻辑，例如单条消息。

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

#### 2.1.1 parseRequestHeader解析请求头

该方法会解析请求头为SendMessageRequestHeader对象，在该方法中会通过不同的RequestCode选择不同的解析方法，如果是批量消息或者轻量（压缩）消息，那么先解析为SendMessageRequestHeaderV2，然后转换为SendMessageRequestHeader，否则直接解析为SendMessageRequestHeader。

我们之前讲过，在Producer发送消息的时候可能会使用轻量级消息头SendMessageRequestHeaderV2，SendMessageRequestHeaderV2相比于SendMessageRequestHeader，其field
全为 a,b,c,d 等短变量名，可以加快FastJson反序列化过程，提升传输效率。

```java
/**
 * AbstractSendMessageProcessor的方法
 * <p>
 * 解析消息请求头
 */
protected SendMessageRequestHeader parseRequestHeader(RemotingCommand request)
        throws RemotingCommandException {
   
     

    SendMessageRequestHeaderV2 requestHeaderV2 = null;
    SendMessageRequestHeader requestHeader = null;
    //根据RequestCode解析为不同类型的请求头对象
    switch (request.getCode()) {
   
     
        case RequestCode.SEND_BATCH_MESSAGE:
        case RequestCode.SEND_MESSAGE_V2:
            //如果是SEND_BATCH_MESSAGE和SEND_MESSAGE_V2，那么解析为SendMessageRequestHeaderV2，即轻量级请求头
            requestHeaderV2 = decodeSendMessageHeaderV2(request);
        case RequestCode.SEND_MESSAGE:
            if (null == requestHeaderV2) {
   
     
                //解析为SendMessageRequestHeader，即普通请求头
                requestHeader =
                        (SendMessageRequestHeader) request
                                .decodeCommandCustomHeader(SendMessageRequestHeader.class);
            } else {
   
     
                //将v2转换为v1，即普通的SendMessageRequestHeader
                requestHeader = SendMessageRequestHeaderV2.createSendMessageRequestHeaderV1(requestHeaderV2);
            }
        default:
            break;
    }
    return requestHeader;
}
```

## 3 总结

本次我们学习了broker接收消息源码入口的处理逻辑，可以看到最终是通过调用**asyncSendMessage**方法来处理来自producer发送的消息的。
**asyncSendMessage**方法内部要做的事情就多了，包括存储消息，构建索引，分发消费等等，这部分我们下回专门学习。