---

layout: 06、RocketMQ源码分析：Producer生产者启动源码【一万字】

title:  06、RocketMQ源码分析：Producer生产者启动源码【一万字】

tags: RocketMq

categories: Web

top: 56

path: /article/1739713331

abbrlink: 1739713331

date: 2025-02-16 21:42:06


--- 

# 06、RocketMQ源码分析：Producer生产者启动源码【一万字】

**meserver和Broker启动之后，RocketMQ就可以使用了。我们先开看看客户端生产者的启动流程源码。源码版本为4.9.3。**

#### 文章目录

- 1 创建DefaultMQProducer实例
- 2 start启动生产者
-
    - 2.1 getOrCreateMQClientInstance获取或者创建MQClientInstance
-
    - 2.1.1 创建MQClientInstance
- 2.2 registerProducer注册生产者
- 3 start启动MQClientInstance
-
    - 3.1 mQClientAPIImpl#start启动netty客户端
- 3.2 startScheduledTask启动各种定时任务
-
    - 3.2.1 updateTopicRouteInfoFromNameServer更新topic路由信息
    -
        - 3.2.1.1 updateTopicRouteInfoFromNameServer更新topic路由信息
        - 3.2.1.2 getTopicRouteInfoFromNameServer从nameServer获取路由信息
        - 3.2.1.3 getAndCreateChannel随机选择nameServer建立连接
    - 3.2.2 cleanOfflineBroker清除下线的broker
    - 3.2.3 sendHeartbeatToAllBrokerWithLock发送心跳包
    -
        - 3.2.3.1 sendHeartbeatToAllBroker给所有broker发送心跳包
        - 3.2.3.2 prepareHeartbeatData准备心跳数据包
- 4 总结

**客户端常用的生产者类是DefaultMQProducer，此类的简单生产者案例如下，在RocketMQ源码的example模块下的org/apache/rocketmq/example/quickstart包中可以找到该快速案例。
**

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
        
        for (int i = 0; i < 1000; i++) {
   
     
            try {
   
     
                
                /*
                * Create a message instance, specifying topic, tag and message body.
                */
                Message msg = new Message("TopicTest" /* Topic */,
                                          "TagA" /* Tag */,
                                          ("Hello RocketMQ " + i).getBytes(RemotingHelper.DEFAULT_CHARSET) /* Message body */
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
        }
        
        /*
        * Shut down once the producer instance is not longer in use.
        */
        producer.shutdown();
    }
}
```

我们本次分析RocketMQ生产者启动的源码。实际上就是分析DefaultMQProducer的构造器以及start方法的源码。
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162029565.png)

## 1 创建DefaultMQProducer实例

DefaultMQProducer的构造器有很多，但最终都是调用下面三个参数的构造函数：

```java
/**
 * Constructor specifying namespace, producer group and RPC hook.
 * 指定命名空间、生产者组和RPC钩子的构造函数。
 *
 * @param namespace Namespace for this MQ Producer instance.
 * @param producerGroup Producer group, see the name-sake field.
 * @param rpcHook RPC hook to execute per each remoting command execution.
 */
public DefaultMQProducer(final String namespace, final String producerGroup, RPCHook rpcHook) {
   
     
    //命名空间
    this.namespace = namespace;
    //生产者组
    this.producerGroup = producerGroup;
    //根据RPC钩子创建DefaultMQProducerImpl实例，负责发送消息
    defaultMQProducerImpl = new DefaultMQProducerImpl(this, rpcHook);
}
```

这个构造器是指定了命名空间、生产者组和RPC钩子的构造器，其内部创建了一个DefaultMQProducerImpl实例，DefaultMQProducer可以看作是DefaultMQProducerImpl的包装类，开放给开发人员使用，DefaultMQProducer中的几乎所有的方法内部都是由DefaultMQProducerImpl实现的。这是门面模式设计模式。

下面是DefaultMQProducerImpl的构造器，也很简单。主要是初始化了一个异步发送消息的线程池，核心线程和最大线程数量都是当前服务器的可用线程数，线程池队列采用LinkedBlockingQueue，大小为50000。

```java
/**
 * @param defaultMQProducer defaultMQProducer
 * @param rpcHook           rpc钩子
 */
public DefaultMQProducerImpl(final DefaultMQProducer defaultMQProducer, RPCHook rpcHook) {
   
     
    //保存defaultMQProducer和rpcHook
    this.defaultMQProducer = defaultMQProducer;
    this.rpcHook = rpcHook;
    /*
     * 异步发送消息的线程池队列
     */
    this.asyncSenderThreadPoolQueue = new LinkedBlockingQueue<Runnable>(50000);
    /*
     * 默认的异步发送消息的线程池
     * 核心线程和最大线程数量都是当前服务器的可用线程数
     */
    this.defaultAsyncSenderExecutor = new ThreadPoolExecutor(
            Runtime.getRuntime().availableProcessors(),
            Runtime.getRuntime().availableProcessors(),
            1000 * 60,
            TimeUnit.MILLISECONDS,
            this.asyncSenderThreadPoolQueue,
            new ThreadFactory() {
   
     
                private AtomicInteger threadIndex = new AtomicInteger(0);

                @Override
                public Thread newThread(Runnable r) {
   
     
                    return new Thread(r, "AsyncSenderExecutor_" + this.threadIndex.incrementAndGet());
                }
            });
}
```

## 2 start启动生产者

DefaultMQProducer的构造器实际上没做什么太多的操作，主要是start方法内部会执行很多初始化操作，因此使用时，我们需要在发送或者查询消息之前调用该方法。

```java
/**
 * 启动生产者实例
 * 为了准备这个实例，需要执行许多内部初始化过程，因此，必须在发送或查询消息之前调用这个方法。
 */
@Override
public void start() throws MQClientException {
   
     
    //根据namespace和producerGroup设置生产者组
    this.setProducerGroup(withNamespace(this.producerGroup));
    //默认生产者实现启动
    this.defaultMQProducerImpl.start();
    //消息轨迹跟踪服务，默认null
    if (null != traceDispatcher) {
   
     
        try {
   
     
            traceDispatcher.start(this.getNamesrvAddr(), this.getAccessChannel());
        } catch (MQClientException e) {
   
     
            log.warn("trace dispatcher start failed ", e);
        }
    }
}
```

主要是defaultMQProducerImpl#start方法，该方法实现生产者的启动。主要步骤有如下几步：

**1、**
调用checkConfig方法检查生产者的ProducerGroup是否符合规范，如果ProducerGroup为空，或者长度大于255个字符，或者包含非法字符（正常的匹配模式为`^[%|a-zA-Z0-9_-]+$）`
，或者生产者组名为默认组名DEFAULT_PRODUCER，满足以上任意条件都校验不通过抛出异常；
**2、** 调用getOrCreateMQClientInstance方法，然后根据clientId获取或者创建CreateMQClientInstance实例，并赋给mQClientFactory变量；
**3、** 将当前生产者注册到MQClientInstance实例的producerTable属性中；
**4、** 添加一个默认topic“TBW102”，将会在isAutoCreateTopicEnable属性开启时在broker上自动创建，RocketMQ会基于该Topic的配置创建新的Topic；

5. 调用mQClientFactory#start方法启动CreateMQClientInstance客户端通信实例，初始化netty服务、各种定时任务、拉取消息服务、rebalanceService服务等等。

**6、** 主动调用一次sendHeartbeatToAllBrokerWithLock发送心跳信息给所有broker；
**7、** 启动一个定时任务，移除超时的request方法的请求，并执行异常回调，任务间隔1s；

```java
/**
 * DefaultMQProducerImpl的启动方法
 */
public void start() throws MQClientException {
   
     
    this.start(true);
}

/**
 * DefaultMQProducerImpl的启动方法
 *
 * @param startFactory
 * @throws MQClientException
 */
public void start(final boolean startFactory) throws MQClientException {
   
     
    //根据服务状态选择走不同的代码分支
    switch (this.serviceState) {
   
     
        /**
         * 服务仅仅创建，而不是启动状态，那么启动服务
         */
        case CREATE_JUST:
            //首先修改服务状态为服务启动失败，如果最终启动成功则再修改为RUNNING
            this.serviceState = ServiceState.START_FAILED;
            /*
             * 1 检查生产者的配置信息
             * 主要是检查ProducerGroup是否符合规范，
             * 如果ProducerGroup为空，或者长度大于255个字符，或者包含非法字符（正常的匹配模式为 ^[%|a-zA-Z0-9_-]+$），或者生产者组名为默认组名DEFAULT_PRODUCER
             * 满足以上任意条件都校验不通过抛出异常。
             */
            this.checkConfig();
            //如果ProducerGroup不是CLIENT_INNER_PRODUCER，那么将修改当前的instanceName为当前进程pid，PID就是服务的进程号。
            //CLIENT_INNER_PRODUCER是客户端内部的生产者组名，该生产者用于发送消息回退请求
            if (!this.defaultMQProducer.getProducerGroup().equals(MixAll.CLIENT_INNER_PRODUCER_GROUP)) {
   
     
                this.defaultMQProducer.changeInstanceNameToPID();
            }
            /*
             * 2 获取MQClientManager实例，然后根据clientId获取或者创建CreateMQClientInstance实例，并赋给mQClientFactory变量
             */
            this.mQClientFactory = MQClientManager.getInstance().getOrCreateMQClientInstance(this.defaultMQProducer, rpcHook);
            /*
             * 3 将当前生产者注册到MQClientInstance实例的producerTable属性中
             */
            boolean registerOK = mQClientFactory.registerProducer(this.defaultMQProducer.getProducerGroup(), this);
            //如果注册失败，那么设置服务属性为CREATE_JUST，并抛出异常
            if (!registerOK) {
   
     
                this.serviceState = ServiceState.CREATE_JUST;
                throw new MQClientException("The producer group[" + this.defaultMQProducer.getProducerGroup()
                        + "] has been created before, specify another name please." + FAQUrl.suggestTodo(FAQUrl.GROUP_NAME_DUPLICATE_URL),
                        null);
            }
            //添加一个默认topic “TBW102”，将会在isAutoCreateTopicEnable属性开启时在broker上自动创建，RocketMQ会基于该Topic的配置创建新的Topic
            this.topicPublishInfoTable.put(this.defaultMQProducer.getCreateTopicKey(), new TopicPublishInfo());
            /*
             * 4 启动CreateMQClientInstance客户端通信实例
             * netty服务、各种定时任务、拉取消息服务、rebalanceService服务
             */
            if (startFactory) {
   
     
                mQClientFactory.start();
            }

            log.info("the producer [{}] start OK. sendMessageWithVIPChannel={}", this.defaultMQProducer.getProducerGroup(),
                    this.defaultMQProducer.isSendMessageWithVIPChannel());
            //服务状态改为RUNNING
            this.serviceState = ServiceState.RUNNING;
            break;
        /**
         * 服务状态是其他的，那么抛出异常，即start方法仅能调用一次
         */
        case RUNNING:
        case START_FAILED:
        case SHUTDOWN_ALREADY:
            throw new MQClientException("The producer service state not OK, maybe started once, "
                    + this.serviceState
                    + FAQUrl.suggestTodo(FAQUrl.CLIENT_SERVICE_NOT_OK),
                    null);
        default:
            break;
    }
    /*
     * 5 发送心跳信息给所有broker
     */
    this.mQClientFactory.sendHeartbeatToAllBrokerWithLock();
    /*
     * 6 启动一个定时任务，移除超时的请求，并执行异常回调，任务间隔1s
     */
    RequestFutureHolder.getInstance().startScheduledTask(this);

}
```

### 2.1 getOrCreateMQClientInstance获取或者创建MQClientInstance

该方法会先生成clientId，格式为
clientIP@instanceName@unitName。然后从本地缓存factoryTable中，查找该clientId的MQClientInstance实例。如果缓存中没有找到，则创建实例并存入缓存中。

MQClientInstance封装了RocketMQ底层网络处理API，Producer、Consumer都会使用到这个类，是Producer、Consumer与NameServer、Broker
打交道的网络通道。因此，同一个clientId对应同一个MQClientInstance实例就可以了，即同一个应用中的多个producer和consumer使用同一个MQClientInstance实例即可。

```java
/**
 * MQClientManager的方法
 *
 * @param clientConfig 生产者客户端配置类
 * @param rpcHook      rpc钩子
 * @return MQClientInstance
 */
public MQClientInstance getOrCreateMQClientInstance(final ClientConfig clientConfig, RPCHook rpcHook) {
   
     
    /*
     * 构建clientId，格式为 clientIP@instanceName@unitName
     */
    String clientId = clientConfig.buildMQClientId();
    //从本地缓存factoryTable中，查找该clientId的MQClientInstance实例
    MQClientInstance instance = this.factoryTable.get(clientId);
    //如果不存在则创建并存入factoryTable
    if (null == instance) {
   
     
        instance =
                new MQClientInstance(clientConfig.cloneClientConfig(),
                        this.factoryIndexGenerator.getAndIncrement(), clientId, rpcHook);
        MQClientInstance prev = this.factoryTable.putIfAbsent(clientId, instance);
        if (prev != null) {
   
     
            instance = prev;
            log.warn("Returned Previous MQClientInstance for clientId:[{}]", clientId);
        } else {
   
     
            log.info("Created new MQClientInstance for clientId:[{}]", clientId);
        }
    }

    return instance;
}
```

#### 2.1.1 创建MQClientInstance

MQClientInstance封装了RocketMQ底层网络处理API，Producer、Consumer都会使用到这个类，是Producer、Consumer与NameServer、Broker
打交道的网络通道。

创建MQClientInstance的时候，会初始化netty客户端，各种服务实例等等。

```java
public MQClientInstance(ClientConfig clientConfig, int instanceIndex, String clientId, RPCHook rpcHook) {
   
     
    this.clientConfig = clientConfig;
    this.instanceIndex = instanceIndex;
    //创建netty客户端配置类实例
    this.nettyClientConfig = new NettyClientConfig();
    this.nettyClientConfig.setClientCallbackExecutorThreads(clientConfig.getClientCallbackExecutorThreads());
    this.nettyClientConfig.setUseTLS(clientConfig.isUseTLS());
    //客户端请求处理器
    this.clientRemotingProcessor = new ClientRemotingProcessor(this);
    //创建客户端远程通信API实现类的实例，内部持有一个remotingClient
    this.mQClientAPIImpl = new MQClientAPIImpl(this.nettyClientConfig, this.clientRemotingProcessor, rpcHook, clientConfig);
    //更新namesrvAddr，即根据“;”将namesrvAddr字符串拆分为namesrvAddrList集合
    if (this.clientConfig.getNamesrvAddr() != null) {
   
     
        this.mQClientAPIImpl.updateNameServerAddressList(this.clientConfig.getNamesrvAddr());
        log.info("user specified name server address: {}", this.clientConfig.getNamesrvAddr());
    }
    //客户端id
    this.clientId = clientId;
    //MQ的admin控制台操作的实现
    this.mQAdminImpl = new MQAdminImpl(this);
    //push模式下，拉取消息的服务
    this.pullMessageService = new PullMessageService(this);
    //消息消费的负载均衡服务
    this.rebalanceService = new RebalanceService(this);
    //客户端内部的生产者，该生产者用于发送消息回退请求
    this.defaultMQProducer = new DefaultMQProducer(MixAll.CLIENT_INNER_PRODUCER_GROUP);
    this.defaultMQProducer.resetClientConfig(clientConfig);
    //消费者状态管理器
    this.consumerStatsManager = new ConsumerStatsManager(this.scheduledExecutorService);

    log.info("Created a new client Instance, InstanceIndex:{}, ClientID:{}, ClientConfig:{}, ClientVersion:{}, SerializerType:{}",
            this.instanceIndex,
            this.clientId,
            this.clientConfig,
            MQVersion.getVersionDesc(MQVersion.CURRENT_VERSION), RemotingCommand.getSerializeTypeConfigInThisServer());
}
```

### 2.2 registerProducer注册生产者

registerProducer方法尝试将当前生产者组和生产者实例的映射关系加入到MQClientInstance内部的producerTable属性中。如果此前已存在相同生产者组的数据，那么不会再次添加并返回false。

```java
/**
 * MQClientInstance的方法
 *
 * @param group    生产者组
 * @param producer 生产者实例
 * @return 是否加入成功
 */
public synchronized boolean registerProducer(final String group, final DefaultMQProducerImpl producer) {
   
     
    //任何一个为null直接返回false
    if (null == group || null == producer) {
   
     
        return false;
    }
    //如果生产者组不存在，则添加到producerTable集合中，并返回null，否则返回已存在的producer
    MQProducerInner prev = this.producerTable.putIfAbsent(group, producer);
    //如果已存入相同的生产者组的生产者，则返回false
    if (prev != null) {
   
     
        log.warn("the producer group[{}] exist already.", group);
        return false;
    }

    return true;
}
```

## 3 start启动MQClientInstance

该方法是producer启动的核心方法。启动CreateMQClientInstance客户端通信实例，将会初始化netty服务、各种定时任务、拉取消息服务、rebalanceService服务、内部的生产者服务等等。

### 3.1 mQClientAPIImpl#start启动netty客户端

该方法创建一个netty客户端，以及两个定时任务和netty事件监听器，注意并没有真正执行netty客户端的connect连接操作。

```java
/**
 * MQClientAPIImpl的方法
 */
public void start() {
   
     
    //调用NettyRemotingClient#start
    this.remotingClient.start();
}
```

mQClientAPIImpl#start内部就是调用的NettyRemotingClient#start方法。NettyRemotingClient属于remoting包下面的类，该类被其他模块例如broker共同使用。

```java
/**
 * NettyRemotingClient的方法
 * 创建netty客户端，并没有真正启动
 */
@Override
public void start() {
   
     
    //创建默认事件处理器组，默认4个线程，线程名以NettyClientWorkerThread_为前缀。
    //主要用于执行在真正执行业务逻辑之前需要进行的SSL验证、编解码、空闲检查、网络连接管理等操作
    //其工作时间位于IO线程组之后，process线程组之前
    this.defaultEventExecutorGroup = new DefaultEventExecutorGroup(
            nettyClientConfig.getClientWorkerThreads(),
            new ThreadFactory() {
   
     

                private AtomicInteger threadIndex = new AtomicInteger(0);

                @Override
                public Thread newThread(Runnable r) {
   
     
                    return new Thread(r, "NettyClientWorkerThread_" + this.threadIndex.incrementAndGet());
                }
            });
    /*
     * 初始化netty客户端
     */
    //eventLoopGroupWorker线程组，默认一个线程
    Bootstrap handler = this.bootstrap.group(this.eventLoopGroupWorker).channel(NioSocketChannel.class)
            //对应于套接字选项中的TCP_NODELAY，该参数的使用与Nagle算法有关
            .option(ChannelOption.TCP_NODELAY, true)
            //对应于套接字选项中的SO_KEEPALIVE，该参数用于设置TCP连接，当设置该选项以后，连接会测试链接的状态
            .option(ChannelOption.SO_KEEPALIVE, false)
            //用来设置连接超时时长，单位是毫秒，默认3000
            .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, nettyClientConfig.getConnectTimeoutMillis())
            .handler(new ChannelInitializer<SocketChannel>() {
   
     
                @Override
                public void initChannel(SocketChannel ch) throws Exception {
   
     
                    ChannelPipeline pipeline = ch.pipeline();
                    if (nettyClientConfig.isUseTLS()) {
   
     
                        if (null != sslContext) {
   
     
                            pipeline.addFirst(defaultEventExecutorGroup, "sslHandler", sslContext.newHandler(ch.alloc()));
                            log.info("Prepend SSL handler");
                        } else {
   
     
                            log.warn("Connections are insecure as SSLContext is null!");
                        }
                    }
                    //为defaultEventExecutorGroup，添加handler
                    pipeline.addLast(
                            defaultEventExecutorGroup,
                            //RocketMQ自定义的请求解码器
                            new NettyEncoder(),
                            //RocketMQ自定义的请求编码器
                            new NettyDecoder(),
                            //Netty自带的心跳管理器，主要是用来检测远端是否存活
                            //即测试端一定时间内未接受到被测试端消息和一定时间内向被测试端发送消息的超时时间为120秒
                            new IdleStateHandler(0, 0, nettyClientConfig.getClientChannelMaxIdleTimeSeconds()),
                            //连接管理器，他负责连接的激活、断开、超时、异常等事件
                            new NettyConnectManageHandler(),
                            //服务请求处理器，处理RemotingCommand消息，即请求和响应的业务处理，并且返回相应的处理结果。这是重点
                            //例如broker注册、producer/consumer获取Broker、Topic信息等请求都是该处理器处理
                            //serverHandler最终会将请求根据不同的消息类型code分发到不同的process线程池处理
                            new NettyClientHandler());
                }
            });
    if (nettyClientConfig.getClientSocketSndBufSize() > 0) {
   
     
        log.info("client set SO_SNDBUF to {}", nettyClientConfig.getClientSocketSndBufSize());
        handler.option(ChannelOption.SO_SNDBUF, nettyClientConfig.getClientSocketSndBufSize());
    }
    if (nettyClientConfig.getClientSocketRcvBufSize() > 0) {
   
     
        log.info("client set SO_RCVBUF to {}", nettyClientConfig.getClientSocketRcvBufSize());
        handler.option(ChannelOption.SO_RCVBUF, nettyClientConfig.getClientSocketRcvBufSize());
    }
    if (nettyClientConfig.getWriteBufferLowWaterMark() > 0 && nettyClientConfig.getWriteBufferHighWaterMark() > 0) {
   
     
        log.info("client set netty WRITE_BUFFER_WATER_MARK to {},{}",
                nettyClientConfig.getWriteBufferLowWaterMark(), nettyClientConfig.getWriteBufferHighWaterMark());
        handler.option(ChannelOption.WRITE_BUFFER_WATER_MARK, new WriteBufferWaterMark(
                nettyClientConfig.getWriteBufferLowWaterMark(), nettyClientConfig.getWriteBufferHighWaterMark()));
    }
    /*
     * 启动定时任务，初始启动3秒后执行，此后每隔1秒执行一次
     * 扫描responseTable，将超时的ResponseFuture直接移除，并且执行这些超时ResponseFuture的回调
     */
    this.timer.scheduleAtFixedRate(new TimerTask() {
   
     
        @Override
        public void run() {
   
     
            try {
   
     
                NettyRemotingClient.this.scanResponseTable();
            } catch (Throwable e) {
   
     
                log.error("scanResponseTable exception", e);
            }
        }
    }, 1000 * 3, 1000);
    /*
     * 启动netty事件监听器，处理各种事件
     */
    if (this.channelEventListener != null) {
   
     
        this.nettyEventExecutor.start();
    }
}
```

start方法的最后，还启动了一个定时任务scanResponseTable。这里主要是用于处理通信时的异常情况。RocketMQ会将请求结果封装为一个ResponseFuture并且存入responseTable中。那么在发送消息时候，如果遇到服务端没有response返回给客户端或者response因网络而丢失等异常情况。此时可能造成responseTable中的ResponseFuture累积，因此该任务会每隔一秒扫描一次responseTable，将超时的ResponseFuture直接移除，并且执行这些超时ResponseFuture的回调。具体的源码和逻辑，我们同样会在RocketMQ的请求和相应部分解析。

### 3.2 startScheduledTask启动各种定时任务

该方法启动五个定时任务：

**1、** 如果没有手动指定namesrvAddr，那么每隔2m从nameServer地址服务器拉取最新的nameServer地址并更新；
**2、** 每隔30S尝试从nameServer更新topic路由信息；
**3、** 每隔30S尝试清除无效的broker信息，以及发送心跳信息给所有broker；
**4、** 每隔5S尝试持久化消费者偏移量，即消费进度广播消费模式下持久化到本地，集群消费模式下推送到broker端该定时任务针对消费者，后面学习消费者的时候再学习源码；
**5、** 每隔1m尝试调整push模式的消费线程池的线程数量，该定时任务针对消费者，目前默认没有实现该功能，是一个空方法实现；

注意，这些定时任务是MQClientInstance实例启动的，而一个应用的所有consumer和producer共用该MQClientInstance实例，因此，这些定时任务也可以说属于该应用的每一个consumer和producer。

```java
/**
 * MQClientInstance的方法
 */
private void startScheduledTask() {
   
     
    /**
     * 1 如果没有手动指定namesrvAddr，那么每隔2m从nameServer地址服务器拉取最新的nameServer地址并更新
     * 要想动态更新nameServer地址，需要指定一个地址服务器的url
     */
    if (null == this.clientConfig.getNamesrvAddr()) {
   
     
        this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

            @Override
            public void run() {
   
     
                try {
   
     
                    MQClientInstance.this.mQClientAPIImpl.fetchNameServerAddr();
                } catch (Exception e) {
   
     
                    log.error("ScheduledTask fetchNameServerAddr exception", e);
                }
            }
        }, 1000 * 10, 1000 * 60 * 2, TimeUnit.MILLISECONDS);
    }
    /**
     * 2 每隔30S尝试从nameServer更新topic路由信息
     */
    this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

        @Override
        public void run() {
   
     
            try {
   
     
                MQClientInstance.this.updateTopicRouteInfoFromNameServer();
            } catch (Exception e) {
   
     
                log.error("ScheduledTask updateTopicRouteInfoFromNameServer exception", e);
            }
        }
    }, 10, this.clientConfig.getPollNameServerInterval(), TimeUnit.MILLISECONDS);
    /**
     * 3 每隔30S尝试清除无效的broker信息，以及发送心跳信息给所有broker
     */
    this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

        @Override
        public void run() {
   
     
            try {
   
     
                MQClientInstance.this.cleanOfflineBroker();
                MQClientInstance.this.sendHeartbeatToAllBrokerWithLock();
            } catch (Exception e) {
   
     
                log.error("ScheduledTask sendHeartbeatToAllBroker exception", e);
            }
        }
    }, 1000, this.clientConfig.getHeartbeatBrokerInterval(), TimeUnit.MILLISECONDS);
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
    /**
     * 5 每隔1min尝试调整push模式的消费线程池的线程数量，目前默认没有实现该功能
     */
    this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

        @Override
        public void run() {
   
     
            try {
   
     
                MQClientInstance.this.adjustThreadPool();
            } catch (Exception e) {
   
     
                log.error("ScheduledTask adjustThreadPool exception", e);
            }
        }
    }, 1, 1, TimeUnit.MINUTES);
}
```

#### 3.2.1 updateTopicRouteInfoFromNameServer更新topic路由信息

该方法是每隔30s从nameServer拉取并更新topic的路由信息的定时任务方法。

首先会从MQClientInstance内部的consumerTable以及producerTable这两个map中获取配置的所有topic集合topicList，包括consumer订阅的topic集合以及producer中topicPublishInfoTable集合中的数据。

```java
/**
 * MQClientInstance的方法
 * 从nameServer拉取并更新topic信息
 */
public void updateTopicRouteInfoFromNameServer() {
   
     
    //使用set集合存储topic，去除重复的数据
    Set<String> topicList = new HashSet<String>();

    // Consumer
    /*
     * 从consumerTable中获取所有的内部生产者DefaultMQPushConsumerImpl的实例，然后获取内部的rebalanceImpl#subscriptionInner集合中的topic
     */
    {
   
     
        Iterator<Entry<String, MQConsumerInner>> it = this.consumerTable.entrySet().iterator();
        while (it.hasNext()) {
   
     
            Entry<String, MQConsumerInner> entry = it.next();
            MQConsumerInner impl = entry.getValue();
            if (impl != null) {
   
     
                Set<SubscriptionData> subList = impl.subscriptions();
                if (subList != null) {
   
     
                    for (SubscriptionData subData : subList) {
   
     
                        topicList.add(subData.getTopic());
                    }
                }
            }
        }
    }

    // Producer
    /*
     * 从producerTable中获取所有的内部生产者DefaultMQProducerImpl的实例，然后获取内部的topicPublishInfoTable集合中的topic
     */
    {
   
     
        Iterator<Entry<String, MQProducerInner>> it = this.producerTable.entrySet().iterator();
        while (it.hasNext()) {
   
     
            Entry<String, MQProducerInner> entry = it.next();
            MQProducerInner impl = entry.getValue();
            if (impl != null) {
   
     
                Set<String> lst = impl.getPublishTopicList();
                topicList.addAll(lst);
            }
        }
    }
    /*
     * 遍历每一个topic，从nameServer获取topic的路由信息
     * 然后比较topic是否改变，如果改变了，对客户端本地保存的路由信息进行更新
     */
    for (String topic : topicList) {
   
     
        this.updateTopicRouteInfoFromNameServer(topic);
    }
}
```

##### 3.2.1.1 updateTopicRouteInfoFromNameServer更新topic路由信息

该方法用于从nameServer拉取并更新topic的路由信息，topic的路由信息由broker上报给nameServer。
从nameSerer拉取到topic路由信息之后，调用topicRouteDataIsChange方法与本地的旧topic路由信息比较看是否更改，比较的数据包括：topic的队列信息queueDatas，topic的broker信息brokerDatas，顺序topic配置orderTopicConf，消费过滤信息filterServerTable。
当判断需要更新的时候，会更新本地的topic缓存，包括：

**1、** 更新brokerName到brokerAddr的地址的映射关系，即brokerAddrTable；
**2、** 更新生产者的producerTable集合，更新MQProducerInner的topicPublishInfoTable属性；
**3、** 更新消费者的consumerTable集合，更新MQConsumerInner的rebalanceImpl.topicSubscribeInfoTable属性；
**4、** 更新topicRouteTable集合，更新本地topic路由信息；

```java
/**
 * MQClientInstance的方法
 * 从nameServer拉取并更新topic信息
 */
public boolean updateTopicRouteInfoFromNameServer(final String topic, boolean isDefault,
                                                  DefaultMQProducer defaultMQProducer) {
   
     
    try {
   
     
        //加锁防止并发
        if (this.lockNamesrv.tryLock(LOCK_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
   
     
            try {
   
     
                TopicRouteData topicRouteData;
                /*
                 * 1 通过默认topic和producer去获取路由信息时走此逻辑
                 */
                if (isDefault && defaultMQProducer != null) {
   
     
                    //获取指定的topic “TBW102” 的路由信息
                    topicRouteData = this.mQClientAPIImpl.getDefaultTopicRouteInfoFromNameServer(defaultMQProducer.getCreateTopicKey(),
                            clientConfig.getMqClientApiTimeout());
                    if (topicRouteData != null) {
   
     
                        //更新队列数据，设置读写队列数量
                        for (QueueData data : topicRouteData.getQueueDatas()) {
   
     
                            int queueNums = Math.min(defaultMQProducer.getDefaultTopicQueueNums(), data.getReadQueueNums());
                            data.setReadQueueNums(queueNums);
                            data.setWriteQueueNums(queueNums);
                        }
                    }
                } else {
   
     
                    /*
                     * 2 定时任务会走该逻辑
                     * 从nameServer获取当前指定topic的路由信息
                     */
                    topicRouteData = this.mQClientAPIImpl.getTopicRouteInfoFromNameServer(topic, clientConfig.getMqClientApiTimeout());
                }
                /*
                 * 3 如果获取到的路由信息不为空，那么比较看是否需要更新本地路由信息
                 */
                if (topicRouteData != null) {
   
     
                    //从topicRouteTable中获取本地缓存的topic路由信息
                    TopicRouteData old = this.topicRouteTable.get(topic);
                    /*
                     * 4 比较nameServer的topic路由和本地topic路由，看是否不相同
                     */
                    boolean changed = topicRouteDataIsChange(old, topicRouteData);
                    if (!changed) {
   
     
                        //如果相同，看本地是否还存在当前topic的配置，如果不存在则还是需要更新topic路由
                        changed = this.isNeedUpdateTopicRouteInfo(topic);
                    } else {
   
     
                        log.info("the topic[{}] route info changed, old[{}] ,new[{}]", topic, old, topicRouteData);
                    }
                    /*
                     * 5 如果需要更新本地路由信息，那么执行更新操作
                     */
                    if (changed) {
   
     
                        //克隆一个TopicRouteData
                        TopicRouteData cloneTopicRouteData = topicRouteData.cloneTopicRouteData();
                        /*
                         * 更新更新brokerName到brokerAddr的地址的映射关系，即brokerAddrTable
                         */
                        for (BrokerData bd : topicRouteData.getBrokerDatas()) {
   
     
                            this.brokerAddrTable.put(bd.getBrokerName(), bd.getBrokerAddrs());
                        }

                        // Update Pub info
                        /*
                         * 更新生产者的producerTable集合，更新MQProducerInner的topicPublishInfoTable属性
                         */
                        if (!producerTable.isEmpty()) {
   
     
                            TopicPublishInfo publishInfo = topicRouteData2TopicPublishInfo(topic, topicRouteData);
                            publishInfo.setHaveTopicRouterInfo(true);
                            Iterator<Entry<String, MQProducerInner>> it = this.producerTable.entrySet().iterator();
                            while (it.hasNext()) {
   
     
                                Entry<String, MQProducerInner> entry = it.next();
                                MQProducerInner impl = entry.getValue();
                                if (impl != null) {
   
     
                                    impl.updateTopicPublishInfo(topic, publishInfo);
                                }
                            }
                        }

                        // Update sub info
                        /*
                         * 更新消费者的consumerTable集合，更新MQConsumerInner的rebalanceImpl.topicSubscribeInfoTable属性
                         */
                        if (!consumerTable.isEmpty()) {
   
     
                            Set<MessageQueue> subscribeInfo = topicRouteData2TopicSubscribeInfo(topic, topicRouteData);
                            Iterator<Entry<String, MQConsumerInner>> it = this.consumerTable.entrySet().iterator();
                            while (it.hasNext()) {
   
     
                                Entry<String, MQConsumerInner> entry = it.next();
                                MQConsumerInner impl = entry.getValue();
                                if (impl != null) {
   
     
                                    impl.updateTopicSubscribeInfo(topic, subscribeInfo);
                                }
                            }
                        }
                        log.info("topicRouteTable.put. Topic = {}, TopicRouteData[{}]", topic, cloneTopicRouteData);
                        /*
                         * 更新topicRouteTable集合，更新本地topic信息
                         */
                        this.topicRouteTable.put(topic, cloneTopicRouteData);
                        return true;
                    }
                } else {
   
     
                    log.warn("updateTopicRouteInfoFromNameServer, getTopicRouteInfoFromNameServer return null, Topic: {}. [{}]", topic, this.clientId);
                }
            } catch (MQClientException e) {
   
     
                if (!topic.startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX) && !topic.equals(TopicValidator.AUTO_CREATE_TOPIC_KEY_TOPIC)) {
   
     
                    log.warn("updateTopicRouteInfoFromNameServer Exception", e);
                }
            } catch (RemotingException e) {
   
     
                log.error("updateTopicRouteInfoFromNameServer Exception", e);
                throw new IllegalStateException(e);
            } finally {
   
     
                this.lockNamesrv.unlock();
            }
        } else {
   
     
            log.warn("updateTopicRouteInfoFromNameServer tryLock timeout {}ms. [{}]", LOCK_TIMEOUT_MILLIS, this.clientId);
        }
    } catch (InterruptedException e) {
   
     
        log.warn("updateTopicRouteInfoFromNameServer Exception", e);
    }

    return false;
}
```

##### 3.2.1.2 getTopicRouteInfoFromNameServer从nameServer获取路由信息

该方法用于通过remotingClient发起请求调用远程接口，从nameServer获取当前指定topic的路由信息。

```java
/**
 * MQClientAPIImpl的方法
 * <p>
 * 从nameServer获取当前指定topic的路由信息
 *
 * @param topic         指定topic名字
 * @param timeoutMillis 超时时间3s
 */
public TopicRouteData getTopicRouteInfoFromNameServer(final String topic, final long timeoutMillis)
        throws RemotingException, MQClientException, InterruptedException {
   
     
    //允许topic不存在
    return getTopicRouteInfoFromNameServer(topic, timeoutMillis, true);
}

public TopicRouteData getTopicRouteInfoFromNameServer(final String topic, final long timeoutMillis,
                                                      boolean allowTopicNotExist) throws MQClientException, InterruptedException, RemotingTimeoutException, RemotingSendRequestException, RemotingConnectException {
   
     
    //构建请求头
    GetRouteInfoRequestHeader requestHeader = new GetRouteInfoRequestHeader();
    //topic设置到请求头中
    requestHeader.setTopic(topic);
    //获取请求命令对象，请求的Code为GET_ROUTEINFO_BY_TOPIC，105
    RemotingCommand request = RemotingCommand.createRequestCommand(RequestCode.GET_ROUTEINFO_BY_TOPIC, requestHeader);
    //同步远程调用，请求nameServer服务，注意这里的addr参数为nll，即producer会随机连接一个nameServer
    RemotingCommand response = this.remotingClient.invokeSync(null, request, timeoutMillis);
    assert response != null;
    switch (response.getCode()) {
   
     
        case ResponseCode.TOPIC_NOT_EXIST: {
   
     
            if (allowTopicNotExist) {
   
     
                log.warn("get Topic [{}] RouteInfoFromNameServer is not exist value", topic);
            }

            break;
        }
        case ResponseCode.SUCCESS: {
   
     
            //如果响应成功，那么对响应体进行解码
            byte[] body = response.getBody();
            if (body != null) {
   
     
                return TopicRouteData.decode(body, TopicRouteData.class);
            }
        }
        default:
            break;
    }

    throw new MQClientException(response.getCode(), response.getRemark());
}
```

最终通过remotingClient.invokeSync方法同步请求nameServer获取topic路由信息，注意这里的addr参数为null，即producer会随机连接一个nameServer。随机选择nameServer连接的逻辑就在NettyRemotingClient#invokeSync方法里面。

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
    //根据addr建立连接，获取channel，随机选择nameServer连接的逻辑就在这里
    final Channel channel = this.getAndCreateChannel(addr);
    if (channel != null && channel.isActive()) {
   
     
        try {
   
     
            //执行rpc钩子的doBeforeRequest方法
            doBeforeRpcHooks(addr, request);
            long costTime = System.currentTimeMillis() - beginStartTime;
            if (timeoutMillis < costTime) {
   
     
                throw new RemotingTimeoutException("invokeSync call the addr[" + addr + "] timeout");
            }
            //执行同步远程调用，获得调用结果
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

##### 3.2.1.3 getAndCreateChannel随机选择nameServer建立连接

getAndCreateChannel方法根据addr建立连接获取channel，随机选择nameServer连接的逻辑就在这里。

简单的说，首先获取一个随机位于nameServer集合长度范围内的整数，作为第一个被选取的nameServer的地址，然后夯实建立长连接，如果建立成功，那么该长连接还会被放入缓存中，以后可以直接使用，这说明，同一个客户端应用中，不同的consumer和produer可以共用同一个nameServer的长连接。

如果没有建立连接成功，那么选择当前位置开始的下一个nameServer地址继续尝试建立长连接，直到最后成功为止。如果所有nameServer都建立长连接失败，那么最终会抛出异常。

```java
/**
 * NettyRemotingClient的方法
 * <p>
 * 获取并建立连接
 *
 * @param addr 地址
 */
private Channel getAndCreateChannel(final String addr) throws RemotingConnectException, InterruptedException {
   
     
    /*
     * 如果addr为null，则获取并且创建nameServer长连接
     */
    if (null == addr) {
   
     
        return getAndCreateNameserverChannel();
    }
    /*
     * 否则，尝试从缓存中获取长连接，获取不到才会创建
     */
    ChannelWrapper cw = this.channelTables.get(addr);
    if (cw != null && cw.isOK()) {
   
     
        return cw.getChannel();
    }

    return this.createChannel(addr);
}

/**
 * NettyRemotingClient的方法
 * 获取并建立nameServer连接
 */
private Channel getAndCreateNameserverChannel() throws RemotingConnectException, InterruptedException {
   
     
    //如果此前已经选择了nameServer，并且通道存在且是激活状态，那么直接获取该nameServer的通道
    //即通道可以被不同的consumer和producer复用
    String addr = this.namesrvAddrChoosed.get();
    if (addr != null) {
   
     
        ChannelWrapper cw = this.channelTables.get(addr);
        if (cw != null && cw.isOK()) {
   
     
            return cw.getChannel();
        }
    }

    final List<String> addrList = this.namesrvAddrList.get();
    //加锁
    if (this.namesrvChannelLock.tryLock(LOCK_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
   
     
        //加锁之后再次判断，防止并发
        try {
   
     
            addr = this.namesrvAddrChoosed.get();
            if (addr != null) {
   
     
                ChannelWrapper cw = this.channelTables.get(addr);
                if (cw != null && cw.isOK()) {
   
     
                    return cw.getChannel();
                }
            }
            /*
             * 选择一个nameServer建立长连接
             */
            if (addrList != null && !addrList.isEmpty()) {
   
     
                for (int i = 0; i < addrList.size(); i++) {
   
     
                    //获取下一个nameServer的索引，初始化数据是随机生成的
                    int index = this.namesrvIndex.incrementAndGet();
                    //取绝对值
                    index = Math.abs(index);
                    //对nameServer集合长度取余数
                    index = index % addrList.size();
                    //获取最终确定的nameServer地址
                    String newAddr = addrList.get(index);
                    //设置到被选择的namesrvAddrChoosed属性中
                    this.namesrvAddrChoosed.set(newAddr);
                    log.info("new name server is chosen. OLD: {} , NEW: {}. namesrvIndex = {}", addr, newAddr, namesrvIndex);
                    //针对被选择的地址建立长连接
                    Channel channelNew = this.createChannel(newAddr);
                    //如果建立连接成功就返回，否则集训循环选择下一个nameServer地址创建
                    if (channelNew != null) {
   
     
                        return channelNew;
                    }
                }
                //没有一个nameServer地址建立成功，那么抛出异常
                throw new RemotingConnectException(addrList.toString());
            }
        } finally {
   
     
            //解锁
            this.namesrvChannelLock.unlock();
        }
    } else {
   
     
        log.warn("getAndCreateNameserverChannel: try to lock name server, but timeout, {}ms", LOCK_TIMEOUT_MILLIS);
    }

    return null;
}
```

#### 3.2.2 cleanOfflineBroker清除下线的broker

该方法是每隔30s清除下线的broker的定时任务方法。该方法会遍历并且更新brokerAddrTable这个map集合，该集合类型为`ConcurrentMap<String/* Broker Name */, HashMap<Long/* brokerId */, String/* address */>>`。

其主要步骤就是获取每一个address，然后去本地路由信息集合topicRouteTable中查找判断broker地址是否存在于topicRouteTable的任意一个topic的路由信息中，如果不存在，则表示该broker已下线，那么清除该broker地址，否则保留。如果brokerAddrTable中的value集合也是空的，那么直接删除键值对。

```java
/**
 * MQClientInstance的方法
 * <p>
 * 清除下线broker
 */
private void cleanOfflineBroker() {
   
     
    try {
   
     
        //加锁
        if (this.lockNamesrv.tryLock(LOCK_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS))
            try {
   
     
                ConcurrentHashMap<String, HashMap<Long, String>> updatedTable = new ConcurrentHashMap<String, HashMap<Long, String>>();

                Iterator<Entry<String, HashMap<Long, String>>> itBrokerTable = this.brokerAddrTable.entrySet().iterator();
                //遍历brokerAddrTable
                while (itBrokerTable.hasNext()) {
   
     
                    Entry<String, HashMap<Long, String>> entry = itBrokerTable.next();
                    String brokerName = entry.getKey();
                    HashMap<Long, String> oneTable = entry.getValue();

                    HashMap<Long, String> cloneAddrTable = new HashMap<Long, String>();
                    cloneAddrTable.putAll(oneTable);

                    Iterator<Entry<Long, String>> it = cloneAddrTable.entrySet().iterator();
                    while (it.hasNext()) {
   
     
                        Entry<Long, String> ee = it.next();
                        String addr = ee.getValue();
                        //判断broker地址是否存在于topicRouteTable的任意一个topic的路由信息中，如果不存在则移除该broker地址
                        if (!this.isBrokerAddrExistInTopicRouteTable(addr)) {
   
     
                            it.remove();
                            log.info("the broker addr[{} {}] is offline, remove it", brokerName, addr);
                        }
                    }
                    //如果集合为空，则移除brokerAddrTable的此项键值对
                    if (cloneAddrTable.isEmpty()) {
   
     
                        itBrokerTable.remove();
                        log.info("the broker[{}] name's host is offline, remove it", brokerName);
                    } else {
   
     
                        //否则更新剩下的broker地址信息
                        updatedTable.put(brokerName, cloneAddrTable);
                    }
                }
                //更新brokerAddrTable的信息
                if (!updatedTable.isEmpty()) {
   
     
                    this.brokerAddrTable.putAll(updatedTable);
                }
            } finally {
   
     
                this.lockNamesrv.unlock();
            }
    } catch (InterruptedException e) {
   
     
        log.warn("cleanOfflineBroker Exception", e);
    }
}
```

isBrokerAddrExistInTopicRouteTable方法用判断给定的broker地址是否存在于topicRouteTable的任意一个topic的路由信息中。

```java
/**
 * MQClientInstance的方法
 * broker地址是否存在于topicRouteTable的任意一个topic的路由信息中
 */
private boolean isBrokerAddrExistInTopicRouteTable(final String addr) {
   
     
    //遍历topicRouteTable
    Iterator<Entry<String, TopicRouteData>> it = this.topicRouteTable.entrySet().iterator();
    while (it.hasNext()) {
   
     
        Entry<String, TopicRouteData> entry = it.next();
        TopicRouteData topicRouteData = entry.getValue();
        List<BrokerData> bds = topicRouteData.getBrokerDatas();
        for (BrokerData bd : bds) {
   
     
            //broker地址是否存在于topicRouteTable的任意一个topic的路由信息中
            if (bd.getBrokerAddrs() != null) {
   
     
                boolean exist = bd.getBrokerAddrs().containsValue(addr);
                if (exist)
                    return true;
            }
        }
    }

    return false;
}
```

#### 3.2.3 sendHeartbeatToAllBrokerWithLock发送心跳包

该方法是每隔30s向所有broker发送心跳包的定时任务方法。客户的consumer和producer都是通过该定时任务发送心跳数据包的。在其他地方也会主动调用一次该方法，例如DefaultMQProducerImpl、DefaultMQPushConsumerImpl等类的start方法的结尾都会主动调用一次该方法。

```java
/**
 * MQClientInstance的方法
 * 发送心跳包给所有broker
 */
public void sendHeartbeatToAllBrokerWithLock() {
   
     
    //加锁
    if (this.lockHeartbeat.tryLock()) {
   
     
        try {
   
     
            //发送心跳包给所有broker
            this.sendHeartbeatToAllBroker();
            //上传过滤类到Broker对应的所有Filtersrv，push模式消费使用
            //但是在RocketMQ5.0.0中filterServer被整体移除，推荐使用MessageSelector
            this.uploadFilterClassSource();
        } catch (final Exception e) {
   
     
            log.error("sendHeartbeatToAllBroker exception", e);
        } finally {
   
     
            this.lockHeartbeat.unlock();
        }
    } else {
   
     
        log.warn("lock heartBeat, but failed. [{}]", this.clientId);
    }
}
```

##### 3.2.3.1 sendHeartbeatToAllBroker给所有broker发送心跳包

该方法用于给所有broker发送心跳包，首先会通过prepareHeartbeatData方法准备心跳数据包，如果数据包中没有任何生产者和消费者的信息，那么不会发送心跳包，直接返回。

然后会遍历brokerAddrTable中的broker地址，开始循环发送心跳包。此时还需要判断，如果数据包中没有消费者的信息并且当前broker不是Master节点，那么无需向该broker发送心跳包，因为此时该应用中只有生产者启动，而生产者只能给Master发送消息数据。但是如果该应用启动了消费者，由于消费者可以从Master和Slave拉取消息，因此会向所有broker发送心跳包。

发送心跳包的请求编码为请求编码为**HEART_BEAT**。

```java
/**
 * MQClientInstance的方法
 * 给所有broker发送心跳包
 */
private void sendHeartbeatToAllBroker() {
   
     
    /*
     * 1 准备心跳数据包
     */
    final HeartbeatData heartbeatData = this.prepareHeartbeatData();
    //如果没有任何关于生产者和消费者的数据，那么不需要发送心跳包
    final boolean producerEmpty = heartbeatData.getProducerDataSet().isEmpty();
    final boolean consumerEmpty = heartbeatData.getConsumerDataSet().isEmpty();
    if (producerEmpty && consumerEmpty) {
   
     
        log.warn("sending heartbeat, but no consumer and no producer. [{}]", this.clientId);
        return;
    }

    if (!this.brokerAddrTable.isEmpty()) {
   
     
        //发送心跳的次数自增1
        long times = this.sendHeartbeatTimesTotal.getAndIncrement();
        //循环遍历brokerAddrTable
        Iterator<Entry<String, HashMap<Long, String>>> it = this.brokerAddrTable.entrySet().iterator();
        while (it.hasNext()) {
   
     
            Entry<String, HashMap<Long, String>> entry = it.next();
            String brokerName = entry.getKey();
            HashMap<Long, String> oneTable = entry.getValue();
            if (oneTable != null) {
   
     
                for (Map.Entry<Long, String> entry1 : oneTable.entrySet()) {
   
     
                    Long id = entry1.getKey();
                    String addr = entry1.getValue();
                    if (addr != null) {
   
     
                        /*
                         * 2 如果消费者配置为空，并且当前broker节点不是Master，那么跳过当前broker注册，因为producer只需要向和Master维持心跳即可
                         * 如果当前应用中启动了消费者，那么就会向所有的broker注册
                         */
                        if (consumerEmpty) {
   
     
                            if (id != MixAll.MASTER_ID)
                                continue;
                        }

                        try {
   
     
                            /*
                             * 3 给broker发送心跳数据包，返回版本
                             */
                            int version = this.mQClientAPIImpl.sendHearbeat(addr, heartbeatData, clientConfig.getMqClientApiTimeout());
                            if (!this.brokerVersionTable.containsKey(brokerName)) {
   
     
                                this.brokerVersionTable.put(brokerName, new HashMap<String, Integer>(4));
                            }
                            this.brokerVersionTable.get(brokerName).put(addr, version);
                            //每二十次心跳，打印一次日志
                            if (times % 20 == 0) {
   
     
                                log.info("send heart beat to broker[{} {} {}] success", brokerName, id, addr);
                                log.info(heartbeatData.toString());
                            }
                        } catch (Exception e) {
   
     
                            if (this.isBrokerInNameServer(addr)) {
   
     
                                log.info("send heart beat to broker[{} {} {}] failed", brokerName, id, addr, e);
                            } else {
   
     
                                log.info("send heart beat to broker[{} {} {}] exception, because the broker not up, forget it", brokerName,
                                        id, addr, e);
                            }
                        }
                    }
                }
            }
        }
    }
}
```

##### 3.2.3.2 prepareHeartbeatData准备心跳数据包

该方法构建心跳数据包，一个心跳包的内容包括：客户端id、消费者信息集合（消费者组名、消费类型、消费模式、启动消费者时从哪开始消费、订阅信息）、生产者信息集合（生产者组名）。

```java
/**
 * MQClientInstance的方法
 * 准备心跳信息
 */
private HeartbeatData prepareHeartbeatData() {
   
     
    HeartbeatData heartbeatData = new HeartbeatData();

    // clientID
    heartbeatData.setClientID(this.clientId);

    // Consumer
    /*
     * 消费者心跳信息
     */
    for (Map.Entry<String, MQConsumerInner> entry : this.consumerTable.entrySet()) {
   
     
        MQConsumerInner impl = entry.getValue();
        if (impl != null) {
   
     
            //构建ConsumerData数据
            ConsumerData consumerData = new ConsumerData();
            //消费者组名
            consumerData.setGroupName(impl.groupName());
            //消费类型 pull push
            consumerData.setConsumeType(impl.consumeType());
            //消费模式 集群 广播
            consumerData.setMessageModel(impl.messageModel());
            //启动消费者时从哪开始消费
            consumerData.setConsumeFromWhere(impl.consumeFromWhere());
            //订阅信息，包括过滤消息相关标签、SQL规则
            consumerData.getSubscriptionDataSet().addAll(impl.subscriptions());
            consumerData.setUnitMode(impl.isUnitMode());
            //加入到消费者数据集合中
            heartbeatData.getConsumerDataSet().add(consumerData);
        }
    }

    // Producer
    /*
     * 生产者心跳信息
     */
    for (Map.Entry<String/* group */, MQProducerInner> entry : this.producerTable.entrySet()) {
   
     
        MQProducerInner impl = entry.getValue();
        if (impl != null) {
   
     
            ProducerData producerData = new ProducerData();
            //生产者组名
            producerData.setGroupName(entry.getKey());

            heartbeatData.getProducerDataSet().add(producerData);
        }
    }

    return heartbeatData;
}
```

## 4 总结

RocketMQ的生产者客户端的源码并不是很难，入口就是DefaultMQProducer的构造器和start方法。

在Producer启动和初始化过程中，会获取或者创建一个非常重要的对象：MQClientInstance。MQClientInstance封装了RocketMQ底层网络处理API，其本身位于通信层，客户端层的Producer、Consumer都会使用到这个类，是Producer、Consumer与NameServer、Broker
打交道的网络通道。因此，同一个clientId对应同一个MQClientInstance实例就可以了，即同一个应用中的多个producer和consumer使用同一个MQClientInstance实例即可。

MQClientInstance的start方法源码也是本次学习的重中之重，但是，在同一个应用中，即使存在多个不同的consume和producer实例，该MQClientInstance实例的start方法中的初始化操作也仅会被调用一次。

MQClientInstance的start方法将会初始化客户端的netty服务、启动各种定时任务（例如定时更新topic信息、定时发送心跳数据等等）、拉取消息服务（后面消费者模块再学习）、rebalanceService负载均衡服务（后面消费者模块再学习）、内部的生产者服务等等服务，这些服务只需要启动一次就好。

由于同一个应用中不同的consume和producer实例共享这个MQClientInstance实例，因此MQClientInstance中的很多方法均需加锁。

生产者的启动源码中使用了一些设计模式，例如：

**1、** 门面设计模式，DefaultMQProducer是我们使用的生产者，但是其方法几乎均委托给内部的DefaultMQProducerImpl来实现；
**2、** 单例模式，例如MQClientManager，典型的饿汉单例模式；
**3、** 状态模式：MQClientInstance和DefaultMQProducerImpl中均有状态字段serviceState，根据不同的状态，其方法的调用会做出不同的行为；