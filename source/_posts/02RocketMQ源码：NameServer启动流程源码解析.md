---

layout: 02 RocketMQ源码：NameServer启动流程源码解析

title:  02 RocketMQ源码：NameServer启动流程源码解析

tags: RocketMq

categories: Web

top: 56

path: /article/1739713327

abbrlink: 1739713327

date: 2025-02-16 21:42:06


--- 

# RocketMQ源码：NameServer启动流程源码解析

# 02、RocketMQ源码分析：NameServer启动流程源码解析

分类：[RocketMQ源码分析（1）](https://cxykk.com/?cat=318)  2024-03-27 阅读(222)

> 详细介绍了RocketMQ的NameServer启动流程源码解析，包括RocketMQ的RPC通信模型。

#### 文章目录

- 0 NameServer概述
- 1 NamesrvStartup启动入口
- 2 createNamesrvController创建NamesrvController
-
    - 2.1 new NamesrvController创建控制器
- 3 start启动NamesrvController
-
    - 3.1 initialize初始化NettyServer
-
    - 3.1.1 创建NettyRemotingServer
    - 3.1.2 registerProcessor注册默认请求处理器
    - 3.1.3 启动定时任务
- 3.2 注册销毁钩子函数
- 3.3 start启动NettyServer
- 4 RocaktMQ的RPC通信模型设计初探
- 5 NameServer启动流程总结

## 0 NameServer概述

我们要先学会了如何使用RocketMQ，并且看了官方文档之后再来看源码，那样就能节约很多的时间。比如RocketMQ的[架构设计](https://github.com/apache/rocketmq/blob/master/docs/cn/architecture.md)
，以及[Apache RocketMQ开发者指南](https://github.com/apache/rocketmq/tree/master/docs/cn)。

下面是RocketMQ的[架构设计](https://github.com/apache/rocketmq/blob/master/docs/cn/architecture.md)图：

![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162021048.png)

在[官方文档](https://github.com/apache/rocketmq/blob/master/docs/cn/architecture.md)
中可以得知，NameServer是一个非常简单的Topic路由注册中心，其角色类似Dubbo中的zookeeper，支持Broker的动态注册与发现。主要包括两个功能：

**1、** Broker管理，NameServer接受Broker集群的注册信息并且保存下来作为路由信息的基本数据然后提供心跳检测机制，检查Broker是否还存活；
**2、**
路由信息管理，每个NameServer将保存关于Broker集群的整个路由信息和用于客户端查询的队列信息然后Producer和Conumser通过NameServer就可以知道整个Broker集群的路由信息，从而进行消息的投递和消费；

从上面可以得知，无论是Producer、Conumser、Broker都会直接和NameServer进行通信，实际上NameServer是非常重要的角色。但是由于大多数程序员都是一个“使用者”的角色，而使用RocketMQ的API的时候一般也不会接触到NameServer，因此对于NameServer的了解较少。更多的NameServer的特性需要查看[官方文档](https://github.com/apache/rocketmq/blob/master/docs/cn/architecture.md)。

**实际上RocketMQ在部署启动时，会首先启动NameServer，因此本系列的源码分析文章中，将会以NameServer的启动作为入口，一步步的向后分析Broker、Consumer、Producer的核心源码。
**

## 1 NamesrvStartup启动入口

NameServer的启动入口就是namesrv模块的NamesrvStartup类的main方法。该方法将会创建并且初始化一个NamesrvController实例。

```java
public static void main(String[] args) {
   
     
     main0(args);
 }

 public static NamesrvController main0(String[] args) {
   
     

     try {
   
     
         /*
          * 1、创建NamesrvController
          */
         NamesrvController controller = createNamesrvController(args);
/*
 * 2、启动NamesrvController
 */
         start(controller);
/*
 * 启动成功打印日志
 */
         String tip = "The Name Server boot success. serializeType=" + RemotingCommand.getSerializeTypeConfigInThisServer();
         log.info(tip);
         System.out.printf("%s%n", tip);
         return controller;
     } catch (Throwable e) {
   
     
         e.printStackTrace();
         System.exit(-1);
     }

     return null;
 }
```

**可以看到入口方法还是比较简单的，我们主要看createNamesrvController创建以及start启动NamesrvController的两个方法的源码。**

## 2 createNamesrvController创建NamesrvController

该方法主要是解析命令行，加载NameServer配置和NettyServer各种配置（解析命令行中-c指定的配置文件）并保存起来然后创建一个NamesrvController。NamesrvController相当于NameServer的一个中央控制器类。

```java
public static NamesrvController createNamesrvController(String[] args) throws IOException, JoranException {
   
     
    //设置RocketMQ的版本信息，属性名为rocketmq.remoting.version
    System.setProperty(RemotingCommand.REMOTING_VERSION_KEY, Integer.toString(MQVersion.CURRENT_VERSION));
    //PackageConflictDetect.detectFastjson();
    /*jar包启动时，构建命令行操作的指令，使用main方法启动可以忽略*/
    Options options = ServerUtil.buildCommandlineOptions(new Options());
    //mqnamesrv命令文件
    commandLine = ServerUtil.parseCmdLine("mqnamesrv", args, buildCommandlineOptions(options), new PosixParser());
    if (null == commandLine) {
   
     
        System.exit(-1);
        return null;
    }
    //创建NameServer的配置类，包含NameServer的配置，比如ROCKETMQ_HOME
    final NamesrvConfig namesrvConfig = new NamesrvConfig();
    //和NettyServer的配置类
    final NettyServerConfig nettyServerConfig = new NettyServerConfig();
    //netty服务的监听端口设置为9876
    nettyServerConfig.setListenPort(9876);
    //判断命令行中是否包含字符'c'，即是否包含通过命令行指定配置文件的命令
    //例如，启动Broker的时候添加的 -c /Volumes/Samsung/Idea/rocketmq/config/conf/broker.conf命令
    if (commandLine.hasOption('c')) {
   
     
        /*解析配置文件并且存入NamesrvConfig和NettyServerConfig中，没有的话就不用管*/
        String file = commandLine.getOptionValue('c');
        if (file != null) {
   
     
            InputStream in = new BufferedInputStream(new FileInputStream(file));
            properties = new Properties();
            properties.load(in);
            MixAll.properties2Object(properties, namesrvConfig);
            MixAll.properties2Object(properties, nettyServerConfig);

            namesrvConfig.setConfigStorePath(file);

            System.out.printf("load config properties file OK, %s%n", file);
            in.close();
        }
    }
    /*判断命令行中是否包含字符'p'，如果存在则打印配置信息并结束jvm运行，没有的话就不用管*/
    if (commandLine.hasOption('p')) {
   
     
        InternalLogger console = InternalLoggerFactory.getLogger(LoggerName.NAMESRV_CONSOLE_NAME);
        MixAll.printObjectProperties(console, namesrvConfig);
        MixAll.printObjectProperties(console, nettyServerConfig);
        System.exit(0);
    }
    //把命令行的配置解析到namesrvConfig
    MixAll.properties2Object(ServerUtil.commandLine2Properties(commandLine), namesrvConfig);
    //如果不存在ROCKETMQ_HOME的配置，那么打印异常并退出程序，这就是最开始启动NameServer是抛出异常的位置
    if (null == namesrvConfig.getRocketmqHome()) {
   
     
        System.out.printf("Please set the %s variable in your environment to match the location of the RocketMQ installation%n", MixAll.ROCKETMQ_HOME_ENV);
        System.exit(-2);
    }
    /*一系列日志的配置*/
    LoggerContext lc = (LoggerContext) LoggerFactory.getILoggerFactory();
    JoranConfigurator configurator = new JoranConfigurator();
    configurator.setContext(lc);
    lc.reset();
    configurator.doConfigure(namesrvConfig.getRocketmqHome() + "/conf/logback_namesrv.xml");

    log = InternalLoggerFactory.getLogger(LoggerName.NAMESRV_LOGGER_NAME);
    //打印nameServer 服务器配置类和 netty 服务器配置类的配置信息
    MixAll.printObjectProperties(log, namesrvConfig);
    MixAll.printObjectProperties(log, nettyServerConfig);
    /*
     * 根据namesrvConfig和nettyServerConfig创建NamesrvController
     */
    final NamesrvController controller = new NamesrvController(namesrvConfig, nettyServerConfig);

    // 将所有的-c的外部配置信息保存到NamesrvController中的Configuration对象属性的allConfigs属性中
    controller.getConfiguration().registerConfig(properties);

    return controller;
}
```

### 2.1 new NamesrvController创建控制器

**createNamesrvController方法中，会根据NamesrvConfig和NettyServerConfig调用NamesrvController的构造器创建一个实例。**

**这个构造器源码也比较简单，就是初始化一些属性。**

```java
public NamesrvController(NamesrvConfig namesrvConfig, NettyServerConfig nettyServerConfig) {
   
     
    //nameserver的配置
    this.namesrvConfig = namesrvConfig;
    //nameserver的netty服务的配置
    this.nettyServerConfig = nettyServerConfig;
    //kv配置管理器
    this.kvConfigManager = new KVConfigManager(this);
    //路由信息管理器
    this.routeInfoManager = new RouteInfoManager();
    //Broker连接的各种事件的处理服务，是处理Broker连接发生变化的服务
    //主要用于监听在Channel通道关闭事件触发时调用RouteInfoManager#onChannelDestroy清除路由信息
    this.brokerHousekeepingService = new BrokerHousekeepingService(this);
    //配置类，并将namesrvConfig和nettyServerConfig的配置注册到内部的allConfigs集合中
    this.configuration = new Configuration(log, this.namesrvConfig, this.nettyServerConfig);
    //存储路径配置
    this.configuration.setStorePathFromConfig(this.namesrvConfig, "configStorePath");
}
```

这里面还会初始化一个**brokerHousekeepingService**，他是一个ChannelEventListener的实现，主要用于主要用于监听Broker的Channel通道关闭事件，并在事件触发时调用
**RouteInfoManager#onChannelDestroy**清除路由信息。

```java
public class BrokerHousekeepingService implements ChannelEventListener {
   
     
    private static final InternalLogger log = InternalLoggerFactory.getLogger(LoggerName.NAMESRV_LOGGER_NAME);
    private final NamesrvController namesrvController;

    public BrokerHousekeepingService(NamesrvController namesrvController) {
   
     
        this.namesrvController = namesrvController;
    }
    //连接事件，不处理
    @Override
    public void onChannelConnect(String remoteAddr, Channel channel) {
   
     
    }
    //连接关闭事件
    @Override
    public void onChannelClose(String remoteAddr, Channel channel) {
   
     
        this.namesrvController.getRouteInfoManager().onChannelDestroy(remoteAddr, channel);
    }
    //连接异常事件
    @Override
    public void onChannelException(String remoteAddr, Channel channel) {
   
     
        this.namesrvController.getRouteInfoManager().onChannelDestroy(remoteAddr, channel);
    }
    //连接闲置事件
    @Override
    public void onChannelIdle(String remoteAddr, Channel channel) {
   
     
        this.namesrvController.getRouteInfoManager().onChannelDestroy(remoteAddr, channel);
    }
}
```

## 3 start启动NamesrvController

在创建NamesrvController之后，调用start方法对其进行启动，实际上就是启动NameServer中的NettyServer服务。

该方法主要做了三件事：

**1、** 调用initialize方法初始化NettyServer创建netty远程服务，初始化Netty线程池，注册请求处理器，配置定时任务，用于扫描并移除不活跃的Broker等操作；
**2、** 对JVM添加关闭钩子方法，在NameServer的JVM关闭之前执行，关闭NameServerController中线程池，NettyServer进行关闭进行一些内存清理、对象销毁等操作；
**3、** 调用start方法启动NettyServer，并进行监听；

```java
public static NamesrvController start(final NamesrvController controller) throws Exception {
   
     
    //不能为null
    if (null == controller) {
   
     
        throw new IllegalArgumentException("NamesrvController is null");
    }
    /*
     * 1 初始化NettyServer
     * 创建netty远程服务，初始化Netty线程池，注册请求处理器，配置定时任务，用于扫描并移除不活跃的Broker等操作。
     */
    boolean initResult = controller.initialize();
    //初始化失败则退出程序
    if (!initResult) {
   
     
        controller.shutdown();
        System.exit(-3);
    }
    /*
     * 2 添加关闭钩子方法，在NameServer关闭之前执行，进行一些内存清理、对象销毁等操作
     */
    Runtime.getRuntime().addShutdownHook(new ShutdownHookThread(log, new Callable<Void>() {
   
     
        @Override
        public Void call() throws Exception {
   
     
            controller.shutdown();
            return null;
        }
    }));
    /*
     * 3 启动NettyServer，并进行监听
     */
    controller.start();

    return controller;
}
```

### 3.1 initialize初始化NettyServer

**该方法用于初始化NettyServer。将会执行创建netty远程服务，初始化Netty线程池，注册请求处理器，配置定时任务，用于扫描并移除不活跃的Broker等初始化操作。
**

**initialize的大概步骤为：**

**1、** 加载KV配置并存储到kvConfigManager内部的configTable属性中；
**2、** 创建NameServer的netty远程服务remotingServer是一个基于Netty的用于NameServer与Broker、Consumer、Producer进行网络通信的服务端；
**3、** 创建netty远程通信执行器线程池remotingExecutor，线程数默认8，线程名以RemotingExecutorThread_为前缀，用作默认的请求处理线程池；
**4、** 注册默认请求处理器DefaultRequestProcessor到remotingServer中；
**5、** 启动两个定时任务其中一个每隔十秒钟检测不活跃的Broker并清理相关路由信息，这是一个核心知识点，另一个任务则是每隔十分钟打印kv配置信息；

```java
public boolean initialize() {
   
     
    /*
     * 1 加载KV配置并存储到kvConfigManager内部的configTable属性中
     * KVConfig配置文件默认路径是 ${user.home}/namesrv/kvConfig.json
     */
    this.kvConfigManager.load();
    /*
     * 2 创建NameServer的netty远程服务
     * 设置了一个ChannelEventListener，为此前创建brokerHousekeepingService
     * remotingServer是一个基于Netty的用于NameServer与Broker、Consumer、Producer进行网络通信的服务端
     */
    this.remotingServer = new NettyRemotingServer(this.nettyServerConfig, this.brokerHousekeepingService);
    /*
     * 3 创建netty远程通信执行器线程池，用作默认的请求处理线程池，线程名以RemotingExecutorThread_为前缀
     */
    this.remotingExecutor =
        Executors.newFixedThreadPool(nettyServerConfig.getServerWorkerThreads(), new ThreadFactoryImpl("RemotingExecutorThread_"));
    /*
     * 4 注册默认请求处理器DefaultRequestProcessor
     * 将remotingExecutor绑定到DefaultRequestProcessor上，用作默认的请求处理线程池
     * DefaultRequestProcessor绑定到remotingServer的defaultRequestProcessor属性上
     */
    this.registerProcessor();
    /*
     * 5 启动一个定时任务
     * 首次启动延迟5秒执行，此后每隔10秒执行一次扫描无效的Broker，并清除Broker相关路由信息的任务
     */
    this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

        @Override
        public void run() {
   
     
            //扫描notActive的broker
            NamesrvController.this.routeInfoManager.scanNotActiveBroker();
        }
    }, 5, 10, TimeUnit.SECONDS);
    /*
     * 6 启动一个定时任务
     * 首次启动延迟1分钟执行，此后每隔10分钟执行一次打印kv配置信息的任务
     */
    this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

        @Override
        public void run() {
   
     
            //打印kv配置信息
            NamesrvController.this.kvConfigManager.printAllPeriodically();
        }
    }, 1, 10, TimeUnit.MINUTES);
    /*
     * Tls传输相关配置，通信安全的文件监听模块，用来观察网络加密配置文件的更改
     */
    if (TlsSystemConfig.tlsMode != TlsMode.DISABLED) {
   
     
        // Register a listener to reload SslContext
        try {
   
     
            fileWatchService = new FileWatchService(
                new String[] {
   
     
                    TlsSystemConfig.tlsServerCertPath,
                    TlsSystemConfig.tlsServerKeyPath,
                    TlsSystemConfig.tlsServerTrustCertPath
                },
                new FileWatchService.Listener() {
   
     
                    boolean certChanged, keyChanged = false;
                    @Override
                    public void onChanged(String path) {
   
     
                        if (path.equals(TlsSystemConfig.tlsServerTrustCertPath)) {
   
     
                            log.info("The trust certificate changed, reload the ssl context");
                            reloadServerSslContext();
                        }
                        if (path.equals(TlsSystemConfig.tlsServerCertPath)) {
   
     
                            certChanged = true;
                        }
                        if (path.equals(TlsSystemConfig.tlsServerKeyPath)) {
   
     
                            keyChanged = true;
                        }
                        if (certChanged && keyChanged) {
   
     
                            log.info("The certificate and private key changed, reload the ssl context");
                            certChanged = keyChanged = false;
                            reloadServerSslContext();
                        }
                    }
                    private void reloadServerSslContext() {
   
     
                        ((NettyRemotingServer) remotingServer).loadSslContext();
                    }
                });
        } catch (Exception e) {
   
     
            log.warn("FileWatchService created error, can't load the certificate dynamically");
        }
    }

    return true;
}
```

#### 3.1.1 创建NettyRemotingServer

**initialize方法的第一步是创建一个NettyRemotingServer，remotingServer是一个基于Netty的用于NameServer与Broker、Consumer、Producer进行网络通信的服务端。
**

**NettyRemotingServer的构造器主要做了以下事：**

**1、** 创建serverBootstrap，这是etty服务端启动类，引导启动服务端；
**2、**
创建一个公共线程池publicExecutor，线程数默认4个线程，线程名以NettyServerPublicExecutor_为前缀用在registerProcessor方法中，在该方法注册Netty事件处理器时如果没指定线程池，则会统一使用publicExecutor来处理具体的业务，用于处理某些特定的请求业务，例如异步发送消息的回调；
**3、**
根据是否使用epoll模型初始化BossEventLoopGroup和WorkerEventLoopGroup这两个事件循环组，线程数分别默认1个和3个线程，线程名分别以NettyEPOLLBoss_和NettyServerEPOLLSelector_为前缀这两个线程组对于熟悉Netty的同学应该不陌生了，boss用于处理连接事件，worker用于处理读写事件；

**1、** 如果是linux内核，并且指定开启epoll，并且系统支持epoll，才会使用EpollEventLoopGroup类型，否则使用NioEventLoopGroup类型；

```java
public NettyRemotingServer(final NettyServerConfig nettyServerConfig,
    final ChannelEventListener channelEventListener) {
   
     
    //设置服务器单向、异步发送信号量
    super(nettyServerConfig.getServerOnewaySemaphoreValue(), nettyServerConfig.getServerAsyncSemaphoreValue());
    //创建Netty服务端启动类，引导启动服务端
    this.serverBootstrap = new ServerBootstrap();
    this.nettyServerConfig = nettyServerConfig;
    this.channelEventListener = channelEventListener;
    //服务器回调执行线程数量，默认设置为4
    int publicThreadNums = nettyServerConfig.getServerCallbackExecutorThreads();
    if (publicThreadNums <= 0) {
   
     
        publicThreadNums = 4;
    }
    //创建一个公共线程池，负责处理某些请求业务，例如发送异步消息回调，线程名以NettyServerPublicExecutor_为前缀
    this.publicExecutor = Executors.newFixedThreadPool(publicThreadNums, new ThreadFactory() {
   
     
        private AtomicInteger threadIndex = new AtomicInteger(0);

        @Override
        public Thread newThread(Runnable r) {
   
     
            return new Thread(r, "NettyServerPublicExecutor_" + this.threadIndex.incrementAndGet());
        }
    });
    /*
     * 是否使用epoll模型，并且初始化Boss EventLoopGroup和Worker EventLoopGroup这两个事件循环组
     * 如果是linux内核，并且指定开启epoll，并且系统支持epoll，才会使用EpollEventLoopGroup，否则使用NioEventLoopGroup
     */
    if (useEpoll()) {
   
     
        /*采用了epoll*/
        this.eventLoopGroupBoss = new EpollEventLoopGroup(1, new ThreadFactory() {
   
     
            private AtomicInteger threadIndex = new AtomicInteger(0);

            @Override
            public Thread newThread(Runnable r) {
   
     
                return new Thread(r, String.format("NettyEPOLLBoss_%d", this.threadIndex.incrementAndGet()));
            }
        });

        this.eventLoopGroupSelector = new EpollEventLoopGroup(nettyServerConfig.getServerSelectorThreads(), new ThreadFactory() {
   
     
            private AtomicInteger threadIndex = new AtomicInteger(0);
            private int threadTotal = nettyServerConfig.getServerSelectorThreads();

            @Override
            public Thread newThread(Runnable r) {
   
     
                return new Thread(r, String.format("NettyServerEPOLLSelector_%d_%d", threadTotal, this.threadIndex.incrementAndGet()));
            }
        });
    } else {
   
     
        /*未采用epoll*/
        //Boss EventLoopGroup 默认1个线程，线程名以NettyNIOBoss_为前缀
        this.eventLoopGroupBoss = new NioEventLoopGroup(1, new ThreadFactory() {
   
     
            private AtomicInteger threadIndex = new AtomicInteger(0);

            @Override
            public Thread newThread(Runnable r) {
   
     
                return new Thread(r, String.format("NettyNIOBoss_%d", this.threadIndex.incrementAndGet()));
            }
        });
        //Worker EventLoopGroup 默认3个线程，线程名以NettyServerNIOSelector_为前缀
        this.eventLoopGroupSelector = new NioEventLoopGroup(nettyServerConfig.getServerSelectorThreads(), new ThreadFactory() {
   
     
            private AtomicInteger threadIndex = new AtomicInteger(0);
            private int threadTotal = nettyServerConfig.getServerSelectorThreads();

            @Override
            public Thread newThread(Runnable r) {
   
     
                return new Thread(r, String.format("NettyServerNIOSelector_%d_%d", threadTotal, this.threadIndex.incrementAndGet()));
            }
        });
    }
    //加载ssl信息
    loadSslContext();
}
```

#### 3.1.2 registerProcessor注册默认请求处理器

**该方法将remotingExecutor绑定到DefaultRequestProcessor上，用作默认的请求处理线程池，并且将DefaultRequestProcessor注册到remotingServer中。
**

*
*当有请求到来时，首先根据请求的业务code，获取对应的RequestProcessor进行处理，如果该Code没有注册的RequestProcessor，则采用DefaultRequestProcessor处理（逻辑位于NettyRemotingAbstract#processRequestCommand方法中）。
**

```java
private void registerProcessor() {
   
     
    if (namesrvConfig.isClusterTest()) {
   
     

        this.remotingServer.registerDefaultProcessor(new ClusterTestRequestProcessor(this, namesrvConfig.getProductEnvName()),
            this.remotingExecutor);
    } else {
   
     
        //将remotingExecutor绑定到DefaultRequestProcessor上，用作默认的请求处理线程池
        //将DefaultRequestProcessor绑定到remotingServer的defaultRequestProcessor属性上
        this.remotingServer.registerDefaultProcessor(new DefaultRequestProcessor(this), this.remotingExecutor);
    }
}
```

**设置为NettyRemotingServer的defaultRequestProcessor属性：**

```java
@Override
public void registerDefaultProcessor(NettyRequestProcessor processor, ExecutorService executor) {
   
     
    //defaultRequestProcessor属性
    this.defaultRequestProcessor = new Pair<NettyRequestProcessor, ExecutorService>(processor, executor);
}
```

#### 3.1.3 启动定时任务

**在创建了remotingServer并且注册了默认请求处理器之后，将会创建两个定时任务：**

**1、** 其中一个首次启动延迟5秒执行，此后每隔10秒执行一次扫描无效的Broker，并清除Broker相关路由信息的任务；
**2、** 另一个首次启动延迟1分钟执行，此后每隔10分钟执行一次打印kvConfig配置信息的任务；

```java
/*
 * 5 启动一个定时任务
 * 首次启动延迟5秒执行，此后每隔10秒执行一次扫描无效的Broker，并清除Broker相关路由信息的任务
 */
this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

    @Override
    public void run() {
   
     
        //扫描notActive的broker
        NamesrvController.this.routeInfoManager.scanNotActiveBroker();
    }
}, 5, 10, TimeUnit.SECONDS);
/*
 * 6 启动一个定时任务
 * 首次启动延迟1分钟执行，此后每隔10分钟执行一次打印kv配置信息的任务
 */
this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

    @Override
    public void run() {
   
     
        //打印kv配置信息
        NamesrvController.this.kvConfigManager.printAllPeriodically();
    }
}, 1, 10, TimeUnit.MINUTES);
```

我们主要关注第一个定时任务，它是非常重要的！但是现在我们不会分析具体的源码，后面会专门的分析。

### 3.2 注册销毁钩子函数

**initialize方法执行完毕之后，对JVM添加关闭钩子方法，在NameServer的JVM关闭之前执行，关闭NameServerController中线程池，NettyServer进行关闭进行一些内存清理、对象销毁等操作。
**

**内部主要是调用controller的shutdown方法：**

```java
public void shutdown() {
   
     
    //关闭nettyserver
    this.remotingServer.shutdown();
    //关闭线程池
    this.remotingExecutor.shutdown();
    //关闭定时任务
    this.scheduledExecutorService.shutdown();

    if (this.fileWatchService != null) {
   
     
        this.fileWatchService.shutdown();
    }
}
```

### 3.3 start启动NettyServer

**在初始化NettyServer完毕并且注册了钩子函数之后，将会启动NettyServer。**

```java
/**
 * NamesrvController的方法
 */
public void start() throws Exception {
   
     
    //调用remotingServer的启动方法
    this.remotingServer.start();

    if (this.fileWatchService != null) {
   
     
        //监听tts相关文件是否发生变化
        this.fileWatchService.start();
    }
}
```

*
*内部会调用remotingServer（NettyRemotingServer）的start方法，该方法才是核心方法，将会启动一个Netty服务端。实际上NettyRemotingServer类属于remoting远程通信模块，因此它是NameServer和Broker共用的进入网络通信类。
**

```java
@Override
public void start() {
   
     
    /*
     * 1 创建默认事件处理器组，线程数默认8个线程，线程名以NettyServerCodecThread_为前缀。
     * 主要用于执行在真正执行业务逻辑之前需要进行的SSL验证、编解码、空闲检查、网络连接管理等操作
     * 其工作时间位于IO线程组之后，process线程组之前
     */
    this.defaultEventExecutorGroup = new DefaultEventExecutorGroup(
            nettyServerConfig.getServerWorkerThreads(),
            new ThreadFactory() {
   
     

                private AtomicInteger threadIndex = new AtomicInteger(0);

                @Override
                public Thread newThread(Runnable r) {
   
     
                    return new Thread(r, "NettyServerCodecThread_" + this.threadIndex.incrementAndGet());
                }
            });
    /*
     * 2 准备一些共享handler
     * 包括handshakeHandler、encoder、connectionManageHandler、serverHandler
     */
    prepareSharableHandlers();
    /*
     * 3 配置NettyServer的启动参数
     * 包括handshakeHandler、encoder、connectionManageHandler、serverHandler
     */
    ServerBootstrap childHandler =
            //配置bossGroup为此前创建的eventLoopGroupBoss，默认1个线程，用于处理连接时间
            //配置workerGroup为此前创建的eventLoopGroupSelector，默认三个线程，用于处理IO事件
            this.serverBootstrap.group(this.eventLoopGroupBoss, this.eventLoopGroupSelector)
                    //IO模型
                    .channel(useEpoll() ? EpollServerSocketChannel.class : NioServerSocketChannel.class)
                    /*设置通道的选项参数， 对于服务端而言就是ServerSocketChannel， 客户端而言就是SocketChannel*/
                    /*option主要是针对boss线程组，child主要是针对worker线程组*/
                    //对应的是tcp/ip协议listen函数中的backlog参数
                    .option(ChannelOption.SO_BACKLOG, nettyServerConfig.getServerSocketBacklog())
                    //对应于套接字选项中的SO_REUSEADDR，这个参数表示允许重复使用本地地址和端口
                    .option(ChannelOption.SO_REUSEADDR, true)
                    //对应于套接字选项中的SO_KEEPALIVE，该参数用于设置TCP连接，当设置该选项以后，连接会测试链接的状态
                    .option(ChannelOption.SO_KEEPALIVE, false)
                    //对应于套接字选项中的TCP_NODELAY，该参数的使用与Nagle算法有关
                    .childOption(ChannelOption.TCP_NODELAY, true)
                    //配置本地地址，监听端口为此前设置的9876
                    .localAddress(new InetSocketAddress(this.nettyServerConfig.getListenPort()))
                    /*设置用于为 Channel 的请求提供服务的 ChannelHandler*/
                    .childHandler(new ChannelInitializer<SocketChannel>() {
   
     
                        @Override
                        public void initChannel(SocketChannel ch) throws Exception {
   
     
                            //ChannelPipeline一个ChannelHandler的链表，Netty处理请求基于责任链默认
                            //里面的ChannelHandler就是用于处理请求的
                            ch.pipeline()
                                    //处理TSL协议握手的Handler
                                    .addLast(defaultEventExecutorGroup, HANDSHAKE_HANDLER_NAME, handshakeHandler)
                                    //为defaultEventExecutorGroup，添加handler
                                    .addLast(defaultEventExecutorGroup,
                                            //RocketMQ自定义的请求解码器
                                            encoder,
                                            //RocketMQ自定义的请求编码器
                                            new NettyDecoder(),
                                            //Netty自带的心跳管理器，主要是用来检测远端是否存活
                                            //即测试端一定时间内未接受到被测试端消息和一定时间内向被测试端发送消息的超时时间为120秒
                                            new IdleStateHandler(0, 0, nettyServerConfig.getServerChannelMaxIdleTimeSeconds()),
                                            //连接管理器，他负责连接的激活、断开、超时、异常等事件
                                            connectionManageHandler,
                                            //服务请求处理器，处理RemotingCommand消息，即请求和响应的业务处理，并且返回相应的处理结果。这是重点
                                            //例如broker注册、producer/consumer获取Broker、Topic信息等请求都是该处理器处理
                                            //serverHandler最终会将请求根据不同的消息类型code分发到不同的process线程池处理
                                            serverHandler
                                    );
                        }
                    });
    //对应于套接字选项中的SO_SNDBUF，接收缓冲区，默认是65535
    if (nettyServerConfig.getServerSocketSndBufSize() > 0) {
   
     
        log.info("server set SO_SNDBUF to {}", nettyServerConfig.getServerSocketSndBufSize());
        childHandler.childOption(ChannelOption.SO_SNDBUF, nettyServerConfig.getServerSocketSndBufSize());
    }
    //对应于套接字选项中的SO_SNDBUF，发送缓冲区，默认是65535
    if (nettyServerConfig.getServerSocketRcvBufSize() > 0) {
   
     
        log.info("server set SO_RCVBUF to {}", nettyServerConfig.getServerSocketRcvBufSize());
        childHandler.childOption(ChannelOption.SO_RCVBUF, nettyServerConfig.getServerSocketRcvBufSize());
    }
    //用于设置写缓冲区的低水位线和高水位线。
    if (nettyServerConfig.getWriteBufferLowWaterMark() > 0 && nettyServerConfig.getWriteBufferHighWaterMark() > 0) {
   
     
        log.info("server set netty WRITE_BUFFER_WATER_MARK to {},{}",
                nettyServerConfig.getWriteBufferLowWaterMark(), nettyServerConfig.getWriteBufferHighWaterMark());
        childHandler.childOption(ChannelOption.WRITE_BUFFER_WATER_MARK, new WriteBufferWaterMark(
                nettyServerConfig.getWriteBufferLowWaterMark(), nettyServerConfig.getWriteBufferHighWaterMark()));
    }
    //分配缓冲区
    if (nettyServerConfig.isServerPooledByteBufAllocatorEnable()) {
   
     
        childHandler.childOption(ChannelOption.ALLOCATOR, PooledByteBufAllocator.DEFAULT);
    }

    try {
   
     
        /*
         * 启动Netty服务
         */
        ChannelFuture sync = this.serverBootstrap.bind().sync();
        InetSocketAddress addr = (InetSocketAddress) sync.channel().localAddress();
        //设置端口号，默认9876
        this.port = addr.getPort();
    } catch (InterruptedException e1) {
   
     
        throw new RuntimeException("this.serverBootstrap.bind().sync() InterruptedException", e1);
    }
    //如果channelEventListener不为null，那么启动netty事件执行器
    //这里的listener就是之前初始化的BrokerHousekeepingService
    if (this.channelEventListener != null) {
   
     
        this.nettyEventExecutor.start();
    }
    /*
     * 启动定时任务，初始启动3秒后执行，此后每隔1秒执行一次
     * 扫描responseTable，将超时的ResponseFuture直接移除，并且执行这些超时ResponseFuture的回调
     */
    this.timer.scheduleAtFixedRate(new TimerTask() {
   
     

        @Override
        public void run() {
   
     
            try {
   
     
                NettyRemotingServer.this.scanResponseTable();
            } catch (Throwable e) {
   
     
                log.error("scanResponseTable exception", e);
            }
        }
    }, 1000 * 3, 1000);
}
```

Rocketmq的远程通信是基于**Netty**的，从上面的start方法中可以明显的看出来典型的netty服务的启动流程，通过serverBootstrap的一系列方法帮助设置启动配置，包括配置
**parentGroup**和childGroup，配置IO模型，配置连接属性，配置服务端口固定为**9876**
，配置用于执行在真正执行业务逻辑之前需要进行的SSL验证、编解码、空闲检查、网络连接管理等操作的**defaultEventExecutorGroup**
，配置真正处理请求的**serverHandler**等等。

我们主要看上面几个handler。如果Channel是出现了连接/读/写等事件，是会在Pipeline的ChannelHandler之间流转，当然这是Netty架构的特性，我们不做过多讲述，所以说要想看懂这些框架的底层源码，我们最好能够明白Netty的主要源码和流程，因为很多的框架的通信都是基于Netty这个框架的。

**上面设置的Handler包括：**

**1、** handshakeHandler：这是用来处理TSL协议握手的Handler，无需过多关注；
**2、** NettyEncoder和NettyDecoder：这是RocketMQ自定义的请求解码和编码器，处理报文的编解码操作负责网络传输数据和RemotingCommand之间的编解码；
**3、** IdleStateHandler：这是Netty自带的心跳管理器，主要是用来检测远端是否存活默认情况下，测试端一定时间内未接受到被测试端消息和一定时间内向被测试端发送消息的超时时间为120秒心跳检测就是在这里；
**4、** connectionManageHandler：处理连接事件的handler，负责连接的激活、断开、超时、异常等事件；
**5、** serverHandler：处理读写事件的handler，简单的说真正处理业务请求的，这是重点，后面会在专门学习通信的时候解析；

最后，通过**serverBootstrap#sync**方法启动netty服务端的，方法执行完毕后，NameServer启动完毕，此时NameServer就可以对外提供远程通信服务了，然后就可以启动Broker服务了。

start方法的最后，还启动了一个定时任务**scanResponseTable**。这里主要是**用于处理通信时的异常情况**
。RocketMQ会将请求结果封装为一个ResponseFuture并且存入responseTable中。那么在发送消息时候，如果遇到服务端没有response返回给客户端或者response因网络而丢失等异常情况。此时可能造成responseTable中的ResponseFuture累积，因此该任务会每隔一秒扫描一次responseTable，将超时的ResponseFuture直接移除，并且执行这些超时ResponseFuture的回调。具体的源码和逻辑，我们同样会在RocketMQ的请求和相应部分解析。

## 4 RocaktMQ的RPC通信模型设计初探

**从上面的源码也能大概看出来NettyRemotingServer的线程模型，实际上这就是RocaktMQ的RPC通信模型，RPC设计是RocketMQ源码中的精华，其中有非常好的思想可以让我们学习，如何实现高性能的RPC通信。
**

**因为RocketMQ的RPC通信采用Netty组件作为底层通信库，同样也遵循了Reactor多线程模型，同时又在这之上做了一些扩展和优化。RocketMQ中RPC通信的通过1+N+M1+M2的Reactor多线程实现：
**

**1、** **1**就是parentGroup，即eventLoopGroupBoss，内部只包含1个线程，线程名以NettyNIOBoss_为前缀负责监听TCP网络连接请求事件，并建立好连接随后将连接交给childGroup；
**2、** **N**就是childGroup，即eventLoopGroupSelector，内部默认包含3个线程线程名以NettyServerNIOSelector_为前缀用于监听IO读写事件，并负责从网络读取数据；
**3、** **M1**
就是defaultEventExecutorGroup，当线程数默认8个线程，线程名以NettyServerCodecThread_为前缀主要用于执行在真正执行业务逻辑之前需要进行的SSL验证、编解码、空闲检查、网络连接管理等操作；
**4、** **M2**
是什么呢？我们上面说执行的业务请求的ChannelHandler是serverHandler，这个serverHander的源码如果进入看就会知道，它实际上也是一个分发请求的handler，也就是说serverHandler最终会将请求根据不同的消息类型code分发到不同的process线程池处理具体的源码我们后面会分析不同类型的请求可能会使用不同的process线程池，这就是M2当然我如果某个也i按没有设置线程池，那就会使用默认的process线程池，即前面初始化的defaultRequestProcessor内部的remotingExecutor线程池（默认8个线程）；

**可以看到，从入口到业务逻辑的几个步骤中线程池一直再增加，这跟每一步逻辑复杂性相关，越复杂，需要的并发通道越宽，这就是RocketMQ的PRC通信设计。
**

下面是官方的描述：[Reactor多线程设计](https://github.com/apache/rocketmq/blob/master/docs/cn/design.md#24-reactor多线程设计)：

![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162021582.png)

> 上面的框图中可以大致了解RocketMQ中NettyRemotingServer的Reactor 多线程模型。一个 Reactor
> 主线程（eventLoopGroupBoss，即为上面的1）负责监听
>
TCP网络连接请求，建立好连接，创建SocketChannel，并注册到selector上。RocketMQ的源码中会自动根据OS的类型选择NIO和Epoll，也可以通过参数配置）,然后监听真正的网络数据。拿到网络数据后，再丢给Worker线程池（eventLoopGroupSelector，即为上面的“N”，源码中默认设置为3），在真正执行业务逻辑之前需要进行SSL验证、编解码、空闲检查、网络连接管理，这些工作交给defaultEventExecutorGroup（即为上面的“M1”，源码中默认设置为8）去做。而处理业务操作放在业务线程池中执行，根据
> RomotingCommand 的业务请求码code去processorTable这个本地缓存变量中找到对应的
> processor，然后封装成task任务后，提交给对应的业务processor处理线程池来执行（sendMessageExecutor，以发送消息为例，即为上面的
> “M2”）。从入口到业务逻辑的几个步骤中线程池一直再增加，这跟每一步逻辑复杂性相关，越复杂，需要的并发通道越宽。

## 5 NameServer启动流程总结

**通过对NameServer模块启动源码的整体通读，其实我们可以发现NameServer启动的源码和原理还是比较简单的，就是进行一些初始化的配置的读取，然后最重要的是启动一个基于Netty的服务端，端口为9876。
**

*
*在启动的时候，还会启动一些定时任务，比如printAllPeriodically每一分钟打印kv信息，比如scanResponseTable每一秒钟清除无效ResponseFuture，最重要的就是scanNotActiveBroker这个定时任务，该定时任务每隔10秒执行一次扫描，检测无效的Broker，并清除Broker相关路由信息的任务，用于实现Broker相关数据的更新。
**

**后面我们会学习Broker的启动流程源码，它的源码将会更加复杂！NameServer的启动源码仅仅是开胃菜而已！**