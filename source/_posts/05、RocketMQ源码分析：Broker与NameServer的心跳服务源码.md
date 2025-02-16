---

layout: 05、RocketMQ源码分析：Broker与NameServer的心跳服务源码

title:  05、RocketMQ源码分析：Broker与NameServer的心跳服务源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713330

abbrlink: 1739713330

date: 2025-02-16 21:42:06


--- 

# 05、RocketMQ源码分析：Broker与NameServer的心跳服务源码

# 05、RocketMQ源码分析：Broker与NameServer的心跳服务源码

分类：[RocketMQ源码分析（1）](https://cxykk.com/?cat=318)  2024-03-27 阅读(142)

详细介绍了RocketMQ的Broker与NameServer的心跳服务源码，主要包括三部分：

**1、** Broker发送心跳注册请求源码；
**2、** NameServer处理心跳注册请求源码；
**3、** NameServer的心跳检测服务源码；

#### 文章目录

- 1 Broker发送心跳注册请求
-
    - 1.1 发送心跳包入口
- 1.2 registerBrokerAll注册broker信息
-
    - 1.2.1 needRegister是否需要注册
    -
        - 1.2.1.1 DataVersion介绍
    - 1.2.2 doRegisterBrokerAll注册broker信息
    -
        - 1.2.2.1 registerBroker注册broker
- 2 NameServer处理心跳注册请求
-
    - 2.1 处理心跳包入口
- 2.2 Nameserver注册broker信息
-
    - 2.3.1 RouteInfoManager的介绍
    - 2.3.2 registerBroker注册broker
- 3 NameServer的心跳检测服务
-
    - 3.1 scanNotActiveBroker扫描清除不活跃broker
-
    - 3.1.1 onChannelDestroy清除路由信息
- 4 总结

## 1 Broker发送心跳注册请求

Broker启动过程中，会跟所有的NameServer建立并保持长连接，然后开启定时任务定时发送心跳包，心跳包中包含当前Broker信息，包括地址、名字、id等等，以及存储的所有Topic的信息。注册成功后，NameServer集群中就有Topic跟Broker的映射关系。

### 1.1 发送心跳包入口

具体的入口就是BrokerController#start方法：

```java
/**
 * BrokerController的方法
 * 启动BrokerController
 */
public void start() throws Exception {
   
     
    //启动消息存储服务
    if (this.messageStore != null) {
   
     
        this.messageStore.start();
    }
    //启动netty远程服务
    if (this.remotingServer != null) {
   
     
        this.remotingServer.start();
    }
    //启动快速netty远程服务
    if (this.fastRemotingServer != null) {
   
     
        this.fastRemotingServer.start();
    }
    //文件监听器启动
    if (this.fileWatchService != null) {
   
     
        this.fileWatchService.start();
    }
    //broker对外api启动
    if (this.brokerOuterAPI != null) {
   
     
        this.brokerOuterAPI.start();
    }
    //长轮询拉取消息挂起服务启动
    if (this.pullRequestHoldService != null) {
   
     
        this.pullRequestHoldService.start();
    }
    //客户端连接心跳服务启动
    if (this.clientHousekeepingService != null) {
   
     
        this.clientHousekeepingService.start();
    }
    //过滤服务管理器启动
    if (this.filterServerManager != null) {
   
     
        this.filterServerManager.start();
    }
    //如果没有开启DLeger的相关设置，默认没有启动
    if (!messageStoreConfig.isEnableDLegerCommitLog()) {
   
     
        //如果不是SLAVE，那么启动transactionalMessageCheckService事务消息检查服务
        startProcessorByHa(messageStoreConfig.getBrokerRole());
        //如果是SLAVE，那么启动定时任务每隔10s与master机器同步数据，采用slave主动拉取的方法
        //同步的内容包括topic配置，消费者消费位移、延迟消息偏移量、订阅组信息等
        handleSlaveSynchronize(messageStoreConfig.getBrokerRole());
        /*
         * 强制注册当前broker信息到所有的nameserver
         */
        this.registerBrokerAll(true, false, true);
    }
    //启动定时任务，默认情况下每隔30s向nameServer进行一次注册，
    //时间间隔可以配置registerNameServerPeriod属性，允许的值是在1万到6万毫秒之间。
    this.scheduledExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

        @Override
        public void run() {
   
     
            try {
   
     
                //定时发送心跳包并上报数据
                BrokerController.this.registerBrokerAll(true, false, brokerConfig.isForceRegister());
            } catch (Throwable e) {
   
     
                log.error("registerBrokerAll Exception", e);
            }
        }
    }, 1000 * 10, Math.max(10000, Math.min(brokerConfig.getRegisterNameServerPeriod(), 60000)), TimeUnit.MILLISECONDS);
    //broker相关统计服务启动
    if (this.brokerStatsManager != null) {
   
     
        this.brokerStatsManager.start();
    }
    //broker快速失败服务启动
    if (this.brokerFastFailure != null) {
   
     
        this.brokerFastFailure.start();
    }
}
```

在start方法中，可以看到在最后启动了一个定时任务，默认情况下每隔30s调用registerBrokerAll方法向所有的nameServer进行一次注册broker信息，时间间隔可以配置registerNameServerPeriod属性，允许的值是在1万到6万毫秒之间。这个定时任务就是Broker向nameserver发送的心跳包的定时任务，包括topic名、读、写队列个数、队列权限、是否有序等信息。

在这个定时任务之前，实际上还会调用一次registerBrokerAll方法，在broker首次启动时强制进行Broker注册。

![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162028761.png)

### 1.2 registerBrokerAll注册broker信息

registerBrokerAll方法用于当前Broker将自身信息注册到所有的NameServer中。

内部调用的doRegisterBrokerAll方法执行注册，调用该方法之前，会判断是否需要注册，如果如果forceRegister为true，表示强制注册，或者如果当前broker应该注册，那么向nameServer进行注册。

在start方法中调用的registerBrokerAll方法，其forceRegister参数都为true，表示一定会强制注册的。

```java
/**
 * BrokerController的方法
 * 注册Broker信息到NameServer，发送心跳包
 *
 * @param checkOrderConfig 是否检测顺序topic
 * @param oneway           是否是单向
 * @param forceRegister    是否强制注册
 */
public synchronized void registerBrokerAll(final boolean checkOrderConfig, boolean oneway, boolean forceRegister) {
   
     
    //根据TopicConfigManager中的topic信息构建topic信息的传输协议对象，
    //在此前的topicConfigManager.load()方法中已经加载了所有topic信息，topic配置文件加载路径为{user.home}/store/config/topics.json
    TopicConfigSerializeWrapper topicConfigWrapper = this.getTopicConfigManager().buildTopicConfigSerializeWrapper();
    //如果当前broker权限不支持写或者读
    if (!PermName.isWriteable(this.getBrokerConfig().getBrokerPermission())
            || !PermName.isReadable(this.getBrokerConfig().getBrokerPermission())) {
   
     
        ConcurrentHashMap<String, TopicConfig> topicConfigTable = new ConcurrentHashMap<String, TopicConfig>();
        for (TopicConfig topicConfig : topicConfigWrapper.getTopicConfigTable().values()) {
   
     
            //那么重新配置topic权限
            TopicConfig tmp =
                    new TopicConfig(topicConfig.getTopicName(), topicConfig.getReadQueueNums(), topicConfig.getWriteQueueNums(),
                            this.brokerConfig.getBrokerPermission());
            topicConfigTable.put(topicConfig.getTopicName(), tmp);
        }
        topicConfigWrapper.setTopicConfigTable(topicConfigTable);
    }
    /*
     * 如果forceRegister为true，表示强制注册，或者如果当前broker应该注册，那么向nameServer进行注册
     */
    if (forceRegister || needRegister(this.brokerConfig.getBrokerClusterName(),
            this.getBrokerAddr(),
            this.brokerConfig.getBrokerName(),
            this.brokerConfig.getBrokerId(),
            this.brokerConfig.getRegisterBrokerTimeoutMills())) {
   
     
        /*
         * 执行注册
         */
        doRegisterBrokerAll(checkOrderConfig, oneway, topicConfigWrapper);
    }
}
```

#### 1.2.1 needRegister是否需要注册

该方法用于判断当前broker是否需要向nameserver进行注册，当forceRegister参数为true的时候，表示强制注册，那么该方法的结果是无所谓的，如果forceRegister为false，那么borker是否需要向nameserver注册就得看这个方法的结果了。

其内部调用brokerOuterAPI#needRegister方法：

```java
/**
 * BrokerController的方法
 * <p>
 * broker是否需要向nemeserver中注册
 *
 * @param clusterName  集群名
 * @param brokerAddr   broker地址
 * @param brokerName   broker名字
 * @param brokerId     brkerid
 * @param timeoutMills 超时时间
 * @return broker是否需要向nemeserver中注册
 */
private boolean needRegister(final String clusterName,
                             final String brokerAddr,
                             final String brokerName,
                             final long brokerId,
                             final int timeoutMills) {
   
     
    //根据TopicConfigManager中的topic信息构建topic信息的传输协议对象，
    //在此前的topicConfigManager.load()方法中已经加载了所有topic信息，topic配置文件加载路径为{user.home}/store/config/topics.json
    TopicConfigSerializeWrapper topicConfigWrapper = this.getTopicConfigManager().buildTopicConfigSerializeWrapper();
    /*
     * 获取所有nameServer的DataVersion数据，一一对比自身数据是否一致，如果有一个nameserver的DataVersion数据版本不一致则重新注册
     */
    List<Boolean> changeList = brokerOuterAPI.needRegister(clusterName, brokerAddr, brokerName, brokerId, topicConfigWrapper, timeoutMills);
    boolean needRegister = false;
    //如果和一个nameServer的数据版本不一致，则需要重新注册
    for (Boolean changed : changeList) {
   
     
        if (changed) {
   
     
            needRegister = true;
            break;
        }
    }
    return needRegister;
}
```

needRegister方法的逻辑也很简单，就是向所有nameServer发起请求（请求code为QUERY_DATA_VERSION，322），获取所有nameserver的DataVersion数据，然后一一对比自身的DataVersion数据是否一致，如果有一个nameserver的数据版本不一致则重新注册。

```java
/**
 * BrokerOuterAPI的方法
 */
public List<Boolean> needRegister(
        final String clusterName,
        final String brokerAddr,
        final String brokerName,
        final long brokerId,
        final TopicConfigSerializeWrapper topicConfigWrapper,
        final int timeoutMills) {
   
     
    //创建一个CopyOnWriteArrayList类型的集合，用来保存请求的返回结果
    final List<Boolean> changedList = new CopyOnWriteArrayList<>();
    //获取全部nameServer地址
    List<String> nameServerAddressList = this.remotingClient.getNameServerAddressList();
    if (nameServerAddressList != null && nameServerAddressList.size() > 0) {
   
     
        final CountDownLatch countDownLatch = new CountDownLatch(nameServerAddressList.size());
        for (final String namesrvAddr : nameServerAddressList) {
   
     
            brokerOuterExecutor.execute(new Runnable() {
   
     
                @Override
                public void run() {
   
     
                    try {
   
     
                        /*
                         * 构造请求头，将一些broker信息放入请求头
                         */
                        QueryDataVersionRequestHeader requestHeader = new QueryDataVersionRequestHeader();
                        requestHeader.setBrokerAddr(brokerAddr);
                        requestHeader.setBrokerId(brokerId);
                        requestHeader.setBrokerName(brokerName);
                        requestHeader.setClusterName(clusterName);
                        //构建远程调用请求对象，code为QUERY_DATA_VERSION，322
                        RemotingCommand request = RemotingCommand.createRequestCommand(RequestCode.QUERY_DATA_VERSION, requestHeader);
                        request.setBody(topicConfigWrapper.getDataVersion().encode());
                        RemotingCommand response = remotingClient.invokeSync(namesrvAddr, request, timeoutMills);
                        DataVersion nameServerDataVersion = null;
                        Boolean changed = false;
                        switch (response.getCode()) {
   
     
                            case ResponseCode.SUCCESS: {
   
     
                                //
                                QueryDataVersionResponseHeader queryDataVersionResponseHeader =
                                        (QueryDataVersionResponseHeader) response.decodeCommandCustomHeader(QueryDataVersionResponseHeader.class);
                                changed = queryDataVersionResponseHeader.getChanged();
                                byte[] body = response.getBody();
                                if (body != null) {
   
     
                                    //获取nameserver的dataversion
                                    nameServerDataVersion = DataVersion.decode(body, DataVersion.class);
                                    //如果当前broker的dataversion与nameserver的dataversion不相等，则表示需要继续宁更新
                                    if (!topicConfigWrapper.getDataVersion().equals(nameServerDataVersion)) {
   
     
                                        changed = true;
                                    }
                                }
                                if (changed == null || changed) {
   
     
                                    changedList.add(Boolean.TRUE);
                                }
                            }
                            default:
                                break;
                        }
                        log.warn("Query data version from name server {} OK,changed {}, broker {},name server {}", namesrvAddr, changed, topicConfigWrapper.getDataVersion(), nameServerDataVersion == null ? "" : nameServerDataVersion);
                    } catch (Exception e) {
   
     
                        changedList.add(Boolean.TRUE);
                        log.error("Query data version from name server {}  Exception, {}", namesrvAddr, e);
                    } finally {
   
     
                        countDownLatch.countDown();
                    }
                }
            });

        }
        try {
   
     
            countDownLatch.await(timeoutMills, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
   
     
            log.error("query dataversion from nameserver countDownLatch await Exception", e);
        }
    }
    return changedList;
}
```

##### 1.2.1.1 DataVersion介绍

DataVersion是RocketMQ的数据版本控制机制。其结构比较简单，核心属性方法如下：

```java
/**
 * 时间戳毫秒值
 */
private long timestamp = System.currentTimeMillis();
/**
 * 版本号
 */
private AtomicLong counter = new AtomicLong(0);

/**
 * 拷贝目标dataVersion的数据，在从文件恢复数据的时候会用到
 */
public void assignNewOne(final DataVersion dataVersion) {
   
     
    this.timestamp = dataVersion.timestamp;
    this.counter.set(dataVersion.counter.get());
}
/**
 * 更新时间戳以及counter到下一个版本
 */
public void nextVersion() {
   
     
    this.timestamp = System.currentTimeMillis();
    this.counter.incrementAndGet();
}
```

他的nextVersion方法被调用时，将会引起timestamp和counter的改变，一般来说，当新创建broker，或者更新topic的信息的时候nextVersion方法会被调用。

Dataversion和topic的配置都被持久化到topics.json文件中，其格式如下：

```java
{
   
     
   "dataVersion":{
   
     
      "counter":3,
      "timestamp":1651398321850
   },
   "topicConfigTable":{
   
     
      "SCHEDULE_TOPIC_XXXX":{
   
     
         "order":false,
         "perm":6,
         "readQueueNums":18,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"SCHEDULE_TOPIC_XXXX",
         "topicSysFlag":0,
         "writeQueueNums":18
      },
      "TopicTest":{
   
     
         "order":false,
         "perm":6,
         "readQueueNums":4,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"TopicTest",
         "topicSysFlag":0,
         "writeQueueNums":4
      },
      "SELF_TEST_TOPIC":{
   
     
         "order":false,
         "perm":6,
         "readQueueNums":1,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"SELF_TEST_TOPIC",
         "topicSysFlag":0,
         "writeQueueNums":1
      },
      "DefaultCluster":{
   
     
         "order":false,
         "perm":7,
         "readQueueNums":16,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"DefaultCluster",
         "topicSysFlag":0,
         "writeQueueNums":16
      },
      "DefaultCluster_REPLY_TOPIC":{
   
     
         "order":false,
         "perm":6,
         "readQueueNums":1,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"DefaultCluster_REPLY_TOPIC",
         "topicSysFlag":0,
         "writeQueueNums":1
      },
      "RMQ_SYS_TRANS_HALF_TOPIC":{
   
     
         "order":false,
         "perm":6,
         "readQueueNums":1,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"RMQ_SYS_TRANS_HALF_TOPIC",
         "topicSysFlag":0,
         "writeQueueNums":1
      },
      "broker-a":{
   
     
         "order":false,
         "perm":7,
         "readQueueNums":1,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"broker-a",
         "topicSysFlag":0,
         "writeQueueNums":1
      },
      "TBW102":{
   
     
         "order":false,
         "perm":7,
         "readQueueNums":8,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"TBW102",
         "topicSysFlag":0,
         "writeQueueNums":8
      },
      "BenchmarkTest":{
   
     
         "order":false,
         "perm":6,
         "readQueueNums":1024,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"BenchmarkTest",
         "topicSysFlag":0,
         "writeQueueNums":1024
      },
      "OFFSET_MOVED_EVENT":{
   
     
         "order":false,
         "perm":6,
         "readQueueNums":1,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"OFFSET_MOVED_EVENT",
         "topicSysFlag":0,
         "writeQueueNums":1
      },
      "%RETRY%please_rename_unique_group_name_4":{
   
     
         "order":false,
         "perm":6,
         "readQueueNums":1,
         "topicFilterType":"SINGLE_TAG",
         "topicName":"%RETRY%please_rename_unique_group_name_4",
         "topicSysFlag":0,
         "writeQueueNums":1
      }
   }
}
```

Dataversion和topic的配置被加载到内存之后，分别会解析成为topicConfigManager的topicConfigTablehe属性和dataVersion属性。

#### 1.2.2 doRegisterBrokerAll注册broker信息

doRegisterBrokerAll方法的逻辑也很简单，就是向所有nameServer发起请求。

```java
/**
 * BrokerController的方法
 *
 * @param checkOrderConfig   是否检测顺序topic
 * @param oneway             是否是单向
 * @param topicConfigWrapper topic信息的传输协议包装对象
 */
private void doRegisterBrokerAll(boolean checkOrderConfig, boolean oneway,
                                 TopicConfigSerializeWrapper topicConfigWrapper) {
   
     
    /*
     * 执行注册，broker作为客户端向所有的nameserver发起注册请求
     */
    List<RegisterBrokerResult> registerBrokerResultList = this.brokerOuterAPI.registerBrokerAll(
            this.brokerConfig.getBrokerClusterName(),
            this.getBrokerAddr(),
            this.brokerConfig.getBrokerName(),
            this.brokerConfig.getBrokerId(),
            this.getHAServerAddr(),
            //包含了携带topic信息的topicConfigTable，以及版本信息的dataVersion
            //这两个信息保存在持久化文件topics.json中
            topicConfigWrapper,
            this.filterServerManager.buildNewFilterServerList(),
            oneway,
            this.brokerConfig.getRegisterBrokerTimeoutMills(),
            this.brokerConfig.isCompressedRegister());
    /*
     * 对执行结果进行处理，选择抵押给调用的结果作为默认数据设置
     */
    if (registerBrokerResultList.size() > 0) {
   
     
        RegisterBrokerResult registerBrokerResult = registerBrokerResultList.get(0);
        if (registerBrokerResult != null) {
   
     
            if (this.updateMasterHAServerAddrPeriodically && registerBrokerResult.getHaServerAddr() != null) {
   
     
                this.messageStore.updateHaMasterAddress(registerBrokerResult.getHaServerAddr());
            }

            this.slaveSynchronize.setMasterAddr(registerBrokerResult.getMasterAddr());

            if (checkOrderConfig) {
   
     
                this.getTopicConfigManager().updateOrderTopicConfig(registerBrokerResult.getKvTable());
            }
        }
    }
}
```

内部调用BrokerOuterAPI#registerBrokerAll方法，BrokerOuterAPI类专门提供了broker向外部发起请求的api方法。

因为broker要向所有的nameServer进行注册，为了提升性能，registerBrokerAll方法里面使用了多线程机制，使用brokerOuterExecutor线程池并行的发起对于每个nameserver的注册请求。

有了多线程提升效率，自然就需要保证线程安全和控制并发：

**1、**
因为需要在多线程中将执行结果并行存入集合中，RocketMQ使用了[CopyOnWriteArrayList](https://blog.csdn.net/weixin_43767015/article/details/107397247)
这个并发集合来保证线程安全CopyOnWriteArrayList采用COW（CopyOnWrite）机制，即写是复制，读数据时完全没有控制，即不会加锁写数据时加独占锁，并且会复制出一个新的List，在新的List中写入数据，写完了之后使用新的List替换旧的List；
**2、**
虽然对于注册的请求使用了线程池异步执行，但是主线程却需要等待这些请求都执行完毕，所有的结果才能继续向下执行，对于这种并发控制，RocketMQ使用了[CountDownLatch](https://blog.csdn.net/weixin_43767015/article/details/108035192)
倒计数器，它能够使得主线程阻塞，确保在其他线程任务执行完毕之后，才会唤醒主线程继续执行后续逻辑；

```java
/**
 * BrokerOuterAPI的方法
 * <p>
 * broker向nameserver进行注册
 */
public List<RegisterBrokerResult> registerBrokerAll(
        final String clusterName,
        final String brokerAddr,
        final String brokerName,
        final long brokerId,
        final String haServerAddr,
        final TopicConfigSerializeWrapper topicConfigWrapper,
        final List<String> filterServerList,
        final boolean oneway,
        final int timeoutMills,
        final boolean compressed) {
   
     
    //创建一个CopyOnWriteArrayList类型的集合，用来保存请求的返回结果
    final List<RegisterBrokerResult> registerBrokerResultList = new CopyOnWriteArrayList<>();
    //获取全部nameServer地址
    List<String> nameServerAddressList = this.remotingClient.getNameServerAddressList();
    if (nameServerAddressList != null && nameServerAddressList.size() > 0) {
   
     
        /*
         * 构造请求头，将一些broker信息放入请求头
         */
        final RegisterBrokerRequestHeader requestHeader = new RegisterBrokerRequestHeader();
        requestHeader.setBrokerAddr(brokerAddr);
        requestHeader.setBrokerId(brokerId);
        requestHeader.setBrokerName(brokerName);
        requestHeader.setClusterName(clusterName);
        requestHeader.setHaServerAddr(haServerAddr);
        requestHeader.setCompressed(compressed);
        /*
         * 构造请求体，将携带topic信息的topicConfigTable，以及版本信息的dataVersion，以及消费过滤信息集合放入请求体
         */
        RegisterBrokerBody requestBody = new RegisterBrokerBody();
        requestBody.setTopicConfigSerializeWrapper(topicConfigWrapper);
        requestBody.setFilterServerList(filterServerList);
        final byte[] body = requestBody.encode(compressed);
        final int bodyCrc32 = UtilAll.crc32(body);
        requestHeader.setBodyCrc32(bodyCrc32);
        /*
         * 使用CountDownLatch作为倒计数器，用于并发控制
         * CountDownLatch可以让主线程等待，直到任务全部执行完毕之后，再唤醒主线程继续后面的逻辑
         */
        final CountDownLatch countDownLatch = new CountDownLatch(nameServerAddressList.size());
        /*
         * 采用线程池的方式，即多线程并发的向所有的nameserver发起注册请求
         */
        for (final String namesrvAddr : nameServerAddressList) {
   
     
            //并发的执行线程任务
            brokerOuterExecutor.execute(new Runnable() {
   
     
                @Override
                public void run() {
   
     
                    try {
   
     
                        //发起注册请求
                        RegisterBrokerResult result = registerBroker(namesrvAddr, oneway, timeoutMills, requestHeader, body);
                        if (result != null) {
   
     
                            registerBrokerResultList.add(result);
                        }

                        log.info("register broker[{}]to name server {} OK", brokerId, namesrvAddr);
                    } catch (Exception e) {
   
     
                        log.warn("registerBroker Exception, {}", namesrvAddr, e);
                    } finally {
   
     
                        /*
                         * 每一个请求执行完毕，无论是正常还是异常，都需要减少一个计数
                         */
                        countDownLatch.countDown();
                    }
                }
            });
        }

        try {
   
     
            /*
             * 主线程在此限时等待6000ms，直到上面的任务全部执行完毕之后，计数变为0，会唤醒主线程继续后面的逻辑
             */
            countDownLatch.await(timeoutMills, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
   
     
        }
    }

    return registerBrokerResultList;
}
```

##### 1.2.2.1 registerBroker注册broker

在上面的多线程代码中，线程任务是调用另一个registerBroker方法，该方法真正的执行向一个nameserver发起注册的请求。

broker注册请求为同步请求，code为REGISTER_BROKER，103，注册的信息主要包括自身的所有topic数据、dataVersion、filterServerList、以及包括集群名、broker地址、broker名、brokerId等等在内的一些broker自身的信息。

```java
/**
 * BrokerOuterAPI的方法
 * <p>
 * 注册broker
 */
private RegisterBrokerResult registerBroker(
        final String namesrvAddr,
        final boolean oneway,
        final int timeoutMills,
        final RegisterBrokerRequestHeader requestHeader,
        final byte[] body
) throws RemotingCommandException, MQBrokerException, RemotingConnectException, RemotingSendRequestException, RemotingTimeoutException,
        InterruptedException {
   
     
    //构建远程调用请求对象，code为REGISTER_BROKER，103
    RemotingCommand request = RemotingCommand.createRequestCommand(RequestCode.REGISTER_BROKER, requestHeader);
    request.setBody(body);

    //如果是单向请求，则broker发起异步请求即可返回，不必关心执行结果，注册请求不是单向请求
    if (oneway) {
   
     
        try {
   
     
            this.remotingClient.invokeOneway(namesrvAddr, request, timeoutMills);
        } catch (RemotingTooMuchRequestException e) {
   
     
            // Ignore
        }
        return null;
    }
    /*
     * 通过remotingClient发起同步调用，非单向请求，即需要同步的获取结果
     */
    RemotingCommand response = this.remotingClient.invokeSync(namesrvAddr, request, timeoutMills);
    assert response != null;
    switch (response.getCode()) {
   
     
        case ResponseCode.SUCCESS: {
   
     
            /*
             * 解析响应数据，封装结果
             */
            RegisterBrokerResponseHeader responseHeader =
                    (RegisterBrokerResponseHeader) response.decodeCommandCustomHeader(RegisterBrokerResponseHeader.class);
            RegisterBrokerResult result = new RegisterBrokerResult();
            result.setMasterAddr(responseHeader.getMasterAddr());
            result.setHaServerAddr(responseHeader.getHaServerAddr());
            if (response.getBody() != null) {
   
     
                result.setKvTable(KVTable.decode(response.getBody(), KVTable.class));
            }
            return result;
        }
        default:
            break;
    }

    throw new MQBrokerException(response.getCode(), response.getRemark(), requestHeader == null ? null : requestHeader.getBrokerAddr());
}
```

## 2 NameServer处理心跳注册请求

Broker发送了心跳包之后，nameserver会进行专门的处理，保存或者更新broker上报的心跳包数据。

### 2.1 处理心跳包入口

NameServer的默认网络处理器是DefaultRequestProcessor，因此心跳请求的入口也就是DefaultRequestProcessor#processRequest方法。

processRequest方法是一个通用的请求处理入口方法，内部会根据请求的不同requestCode进入分发处理，心跳请求的requestCode就是REGISTER_BROKER，103。

```java
case RequestCode.REGISTER_BROKER:
    /*
     * 处理broker心跳请求的逻辑
     */
    //获取broker版本
    Version brokerVersion = MQVersion.value2Version(request.getVersion());
    //如果大于3.0.11版本则调用registerBrokerWithFilterServer，否则调用registerBroker
    if (brokerVersion.ordinal() >= MQVersion.Version.V3_0_11.ordinal()) {
   
     
        return this.registerBrokerWithFilterServer(ctx, request);
    } else {
   
     
        return this.registerBroker(ctx, request);
    }
case RequestCode.UNREGISTER_BROKER:
    /*
     * 处理解除broker注册的逻辑
     */
    return this.unregisterBroker(ctx, request);
```

可以看到nameserver会调用registerBrokerWithFilterServer方法来处理大于3.0.11版本的broker的注册请求。

我们进入registerBrokerWithFilterServer方法，可以看到，该方法会解析请求头、请求体中的内容，内容包括topic信息、版本信息dataVersion、消息过滤信息filterServerList、以及broker基本信息，例如broker地址、名字等等。最后会调用routeInfoManager#registerBroker方法实现broker信息的注册。

```java
/**
 * DefaultRequestProcessor的方法
 * <p>
 * 处理broker的心跳请求
 * 心跳请求的内容包括topic信息、版本信息dataVersion、消息过滤信息filterServerList、以及broker基本信息，例如broker地址、名字等等
 */
public RemotingCommand registerBrokerWithFilterServer(ChannelHandlerContext ctx, RemotingCommand request)
        throws RemotingCommandException {
   
     
    //创建返回数据
    final RemotingCommand response = RemotingCommand.createResponseCommand(RegisterBrokerResponseHeader.class);
    //构建响应头
    final RegisterBrokerResponseHeader responseHeader = (RegisterBrokerResponseHeader) response.readCustomHeader();
    //获取请求头
    final RegisterBrokerRequestHeader requestHeader =
            (RegisterBrokerRequestHeader) request.decodeCommandCustomHeader(RegisterBrokerRequestHeader.class);
    //校验crc32
    if (!checksum(ctx, request, requestHeader)) {
   
     
        response.setCode(ResponseCode.SYSTEM_ERROR);
        response.setRemark("crc32 not match");
        return response;
    }
    /*
     * 解析请求体的信息成为RegisterBrokerBody对象，内部包含发送请求时封装的filterServerList和topicConfigSerializeWrapper对象
     * 包括topic信息、版本信息dataVersion、消息过滤信息filterServerList
     */
    RegisterBrokerBody registerBrokerBody = new RegisterBrokerBody();

    if (request.getBody() != null) {
   
     
        try {
   
     
            //解析请求体的信息
            registerBrokerBody = RegisterBrokerBody.decode(request.getBody(), requestHeader.isCompressed());
        } catch (Exception e) {
   
     
            throw new RemotingCommandException("Failed to decode RegisterBrokerBody", e);
        }
    } else {
   
     
        registerBrokerBody.getTopicConfigSerializeWrapper().getDataVersion().setCounter(new AtomicLong(0));
        registerBrokerBody.getTopicConfigSerializeWrapper().getDataVersion().setTimestamp(0);
    }
    /*
     * broker信息注册
     */
    RegisterBrokerResult result = this.namesrvController.getRouteInfoManager().registerBroker(
            requestHeader.getClusterName(),
            requestHeader.getBrokerAddr(),
            requestHeader.getBrokerName(),
            requestHeader.getBrokerId(),
            requestHeader.getHaServerAddr(),
            registerBrokerBody.getTopicConfigSerializeWrapper(),
            registerBrokerBody.getFilterServerList(),
            ctx.channel());

    responseHeader.setHaServerAddr(result.getHaServerAddr());
    responseHeader.setMasterAddr(result.getMasterAddr());
    //从configTable获取顺序消息的配置，configTable可用于存储一些配置信息，实现匹配的namespace隔离。
    //目前版本似乎不太起作用，或许是当初设想但未利用起来的设计，返回null
    byte[] jsonValue = this.namesrvController.getKvConfigManager().getKVListByNamespace(NamesrvUtil.NAMESPACE_ORDER_TOPIC_CONFIG);
    response.setBody(jsonValue);

    response.setCode(ResponseCode.SUCCESS);
    response.setRemark(null);
    return response;
}
```

### 2.2 Nameserver注册broker信息

#### 2.3.1 RouteInfoManager的介绍

Nameserver通过routeInfoManager#registerBroker方法实现broker信息的注册。我们先来看看RouteInfoManager的基本属性，这个类位于namesrv模块中，用来管理nameServer上的关于真个RocketMQ集群的各种路由信息，nameServer作为轻量级的注册中心，RouteInfoManager这个类非常的重要。

```java
/**
 * Broker过期时间，默认120秒，如果当前时间大于最后修改时间加上Broker过期时间，那么就剔除该Broker
 */
private final static long BROKER_CHANNEL_EXPIRED_TIME = 1000 * 60 * 2;
/**
 * 读写锁，用于在获取路由信息时保证并发安全的同时提升效率
 */
private final ReadWriteLock lock = new ReentrantReadWriteLock();
/**
 * Topic到Topic下面的队列集合的路由信息
 */
private final HashMap<String/* topic */, List<QueueData>> topicQueueTable;
/**
 * brokerName到BrokerData的路由信息，BrokerData包含broker的基础信息，例如brokerName、brokerAddr、cluster等
 */
private final HashMap<String/* brokerName */, BrokerData> brokerAddrTable;
/**
 * clusterName到cluster下面的brokerName的路由信息
 */
private final HashMap<String/* clusterName */, Set<String/* brokerName */>> clusterAddrTable;
/**
 * brokerAddr名到BrokerLiveInfo的路由信息，BrokerLiveInfo存储broker的状态信息，包括上次接收心跳时间，数据版本号等
 */
private final HashMap<String/* brokerAddr */, BrokerLiveInfo> brokerLiveTable;
/**
 * brokerAddr名到Filter Server集合的路由信息，用于类模式消息过滤。
 */
private final HashMap<String/* brokerAddr */, List<String>/* Filter Server */> filterServerTable;
```

#### 2.3.2 registerBroker注册broker

该方法用于注册broker，也就是对broker的各种路由信息进行更新或者注册。

其主要步骤为：

**1、** 加写锁，保证线程安全；
**2、** 存入或者更新brokerName信息集合clusterAddrTable；
**3、** 存入或者更新broker基本信息集合brokerAddrTable存入一个brokerData对象；
**4、** 如果当前broker是主broker节点更新或者创建topic的队列配置信息集合topicQueueTable；
**5、** 存入或者更新中broker状态信息集合brokerLiveTable存入或者更新的信息包括最新的更新时间戳设置为当前时间，brokerLiveTable被nameServer用于执行心跳检测操作；
**6、** 存入或者更新消费过滤信息集合filterServerListClassFilter模式的消费过滤集合的操作；
**7、** 如果当前broker不是主broker节点对返回结果result设置HaServerAddr以及MasterAddr的地址；
**8、** 释放写锁；

```java
/**
 * RouteInfoManager的方法
 *
 * @param clusterName        集群名
 * @param brokerAddr         broker地址
 * @param brokerName         broker名
 * @param brokerId           broker Id
 * @param haServerAddr       高可用服务地址
 * @param topicConfigWrapper topic配置
 * @param filterServerList   消费过滤
 * @param channel            通道
 * @return 注册的结果
 */
public RegisterBrokerResult registerBroker(
        final String clusterName,
        final String brokerAddr,
        final String brokerName,
        final long brokerId,
        final String haServerAddr,
        final TopicConfigSerializeWrapper topicConfigWrapper,
        final List<String> filterServerList,
        final Channel channel) {
   
     
    //构建注册结果对象
    RegisterBrokerResult result = new RegisterBrokerResult();
    try {
   
     
        try {
   
     
            /*
             * 加本地写锁，防止并发
             */
            this.lock.writeLock().lockInterruptibly();

            /*
             * 1 存入或者更新brokerName信息集合clusterAddrTable
             * brokerName的操作
             */
            //获取集群下所有的brokerName集合
            Set<String> brokerNames = this.clusterAddrTable.get(clusterName);
            if (null == brokerNames) {
   
     
                //如果此前没有此集群的broker的话就新创建一个，并且将当前brokerName加入brokerName集合中
                brokerNames = new HashSet<String>();
                this.clusterAddrTable.put(clusterName, brokerNames);
            }
            //将当前brokerName加入brokerName集合中，set集合不会重复
            brokerNames.add(brokerName);

            /*
             * 2 存入或者更新broker基本信息集合brokerAddrTable
             * brokerId和brokerAddr的操作
             */
            //是否是第一次注册的标志位
            boolean registerFirst = false;
            //从brokerAddrTable获取当前brokerName对应的BrokerData信息
            BrokerData brokerData = this.brokerAddrTable.get(brokerName);
            if (null == brokerData) {
   
     
                //如果brokerData为null，则表示是第一次注册，那么新建brokerData并且存入brokerAddrTable
                registerFirst = true;
                brokerData = new BrokerData(clusterName, brokerName, new HashMap<Long, String>());
                this.brokerAddrTable.put(brokerName, brokerData);
            }
            //获取此集群的此brokerName下面的  brokerId到brokerAdder的映射map
            //相同的clusterName和brokerName下面可能有多个broker节点，比如主从架构
            Map<Long, String> brokerAddrsMap = brokerData.getBrokerAddrs();
            //Switch slave to master: first remove <1, IP:PORT> in namesrv, then add <0, IP:PORT>
            //The same IP:PORT must only have one record in brokerAddrTable
            Iterator<Entry<Long, String>> it = brokerAddrsMap.entrySet().iterator();
            while (it.hasNext()) {
   
     
                Entry<Long, String> item = it.next();
                //如果broker地址一样，但是brokerId不一样，那么此时的情况应该是： 主从架构下，master节点挂了，slave节点成为master
                //我需要首先移除此前存在的相同brokerAddr的元素
                //例如，此前存在<0, IP1:PORT> <1, IP2:PORT> 两个元素。此时主节点挂了，从节点成为主节点，上报的数据会变成<0, IP2:PORT>
                if (null != brokerAddr && brokerAddr.equals(item.getValue()) && brokerId != item.getKey()) {
   
     
                    it.remove();
                }
            }
            //更新，将当前broekr的Id到地址的关系存入brokerAddrsMap
            String oldAddr = brokerData.getBrokerAddrs().put(brokerId, brokerAddr);
            registerFirst = registerFirst || (null == oldAddr);
            /*
             * 3 更新或者创建topic的队列配置信息集合topicQueueTable
             * 针对Master节点的操作
             */
            //如果当前broker是主broker节点
            if (null != topicConfigWrapper
                    && MixAll.MASTER_ID == brokerId) {
   
     
                //如果当前broker的topic配置信息的数据版本DataVersion发生了变化
                if (this.isBrokerTopicConfigChanged(brokerAddr, topicConfigWrapper.getDataVersion())
                        || registerFirst) {
   
     
                    //获取上报的topic配置信息map集合
                    ConcurrentMap<String, TopicConfig> tcTable =
                            topicConfigWrapper.getTopicConfigTable();
                    if (tcTable != null) {
   
     
                        for (Map.Entry<String, TopicConfig> entry : tcTable.entrySet()) {
   
     
                            //更新或者新建topic配置信息
                            this.createAndUpdateQueueData(brokerName, entry.getValue());
                        }
                    }
                }
            }
            /*
             * 4 存入或者更新中broker状态信息集合brokerLiveTable
             * 存入或者更新的信息包括最新的更新时间戳设置为当前时间，brokerLiveTable被nameServer用于执行心跳检测操作
             */
            BrokerLiveInfo prevBrokerLiveInfo = this.brokerLiveTable.put(brokerAddr,
                    new BrokerLiveInfo(
                            System.currentTimeMillis(),
                            topicConfigWrapper.getDataVersion(),
                            channel,
                            haServerAddr));
            //如果此前的prevBrokerLiveInfo为null，那么表示新上报broker，打印日志
            if (null == prevBrokerLiveInfo) {
   
     
                log.info("new broker registered, {} HAServer: {}", brokerAddr, haServerAddr);
            }
            /*
             * 5 存入或者更新消费过滤信息集合filterServerList
             * ClassFilter模式的消费过滤集合的操作
             */
            if (filterServerList != null) {
   
     
                if (filterServerList.isEmpty()) {
   
     
                    this.filterServerTable.remove(brokerAddr);
                } else {
   
     
                    this.filterServerTable.put(brokerAddr, filterServerList);
                }
            }
            /*
             * 6 对返回结果设置HaServerAddr以及MasterAddr的地址
             * 针对slave节点的操作
             */
            if (MixAll.MASTER_ID != brokerId) {
   
     
                //获取mater节点的地址
                String masterAddr = brokerData.getBrokerAddrs().get(MixAll.MASTER_ID);
                if (masterAddr != null) {
   
     
                    //获取master节点的brokerLiveInfo信息
                    BrokerLiveInfo brokerLiveInfo = this.brokerLiveTable.get(masterAddr);
                    if (brokerLiveInfo != null) {
   
     
                        //将master节点的HaServerAddr以及mater节点的地址存入result中返回给slave节点
                        result.setHaServerAddr(brokerLiveInfo.getHaServerAddr());
                        result.setMasterAddr(masterAddr);
                    }
                }
            }
        } finally {
   
     
            /*
             * 解锁
             */
            this.lock.writeLock().unlock();
        }
    } catch (Exception e) {
   
     
        log.error("registerBroker Exception", e);
    }

    return result;
}
```

## 3 NameServer的心跳检测服务

NameServer在启动的时候，会启动一个定时周期任务。默认每隔10秒执行一次扫描无效的Broker，并清除Broker相关路由信息的任务。

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
```

### 3.1 scanNotActiveBroker扫描清除不活跃broker

这个方法就是nameserver中每隔10秒执行一次扫描无效的Broker，并清除无效的Broker的连接以及路由信息的任务方法。

方法很简单，就是扫描RouteInfoManager的brokerLiveTable集合中的每一个BrokerLiveInfo。然后判断如果当前时间戳 大于
上次接收心跳的时间戳 + Broker过期时间，那么就剔除该Broker，Broker过期时间默认120秒。

所谓的剔除该Broker，就是两件事：

1. 调用RemotingUtil#closeChannel关闭和当前broker的通道，即关闭与此broker的socket连接。
2. 调用RouteInfoManager#onChannelDestroy清除该broker的无效的路由信息。

```java
/**
 * RouteInfoManager的方法
 * <p>
 * 扫描brokerLiveTable，清除无效的broker连接和路由信息
 */
public void scanNotActiveBroker() {
   
     
    //根据brokerLiveTable进行路由信息的校验和移除
    Iterator<Entry<String, BrokerLiveInfo>> it = this.brokerLiveTable.entrySet().iterator();
    while (it.hasNext()) {
   
     
        Entry<String, BrokerLiveInfo> next = it.next();
        //获取上次接收心跳的时间戳
        long last = next.getValue().getLastUpdateTimestamp();
        //如果当前时间戳 大于 上次接收心跳的时间戳 + Broker过期时间，那么就剔除该Broker，Broker过期时间默认120秒
        //即如果某个Broker 120秒内没有上报心跳包，那么任务该broker失效了，可能是宕机了，于是移除相关路由信息
        if ((last + BROKER_CHANNEL_EXPIRED_TIME) < System.currentTimeMillis()) {
   
     
            /*
             * 1 关闭和当前broker的通道，即关闭与此broker的socket连接
             */
            RemotingUtil.closeChannel(next.getValue().getChannel());
            //从brokerLiveTable中移除此项
            it.remove();
            //记录日志
            log.warn("The broker channel expired, {} {}ms", next.getKey(), BROKER_CHANNEL_EXPIRED_TIME);
            /*
             * 2 清除无效的路由信息
             */
            this.onChannelDestroy(next.getKey(), next.getValue().getChannel());
        }
    }
}
```

#### 3.1.1 onChannelDestroy清除路由信息

该方法用于在断开连接之后请求与该broker相关的无效路由信息。

删除信息的时候同样需要先加写锁，然后从brokerLiveTable、filterServerTable、brokerAddrTable、clusterAddrTable、topicQueueTable这五个路由表中删除数据，可以看作是registerBroker注册broker信息方法的逆向操作，比较简单。

```java
/**
 * 清除无效路由信息
 *
 * @param remoteAddr 无效的brokerAddr
 * @param channel    通道
 */
public void onChannelDestroy(String remoteAddr, Channel channel) {
   
     
    String brokerAddrFound = null;
    if (channel != null) {
   
     
        try {
   
     
            try {
   
     
                //加读锁在brokerLiveTable中查找channel相等的brokerAddr
                this.lock.readLock().lockInterruptibly();
                Iterator<Entry<String, BrokerLiveInfo>> itBrokerLiveTable =
                        this.brokerLiveTable.entrySet().iterator();
                while (itBrokerLiveTable.hasNext()) {
   
     
                    Entry<String, BrokerLiveInfo> entry = itBrokerLiveTable.next();
                    if (entry.getValue().getChannel() == channel) {
   
     
                        brokerAddrFound = entry.getKey();
                        break;
                    }
                }
            } finally {
   
     
                //释放读锁
                this.lock.readLock().unlock();
            }
        } catch (Exception e) {
   
     
            log.error("onChannelDestroy Exception", e);
        }
    }
    if (null == brokerAddrFound) {
   
     
        brokerAddrFound = remoteAddr;
    } else {
   
     
        log.info("the broker's channel destroyed, {}, clean it's data structure at once", brokerAddrFound);
    }
    /*
     * 请求无效的broker路由信息
     */
    if (brokerAddrFound != null && brokerAddrFound.length() > 0) {
   
     

        try {
   
     
            try {
   
     
                //加写锁
                this.lock.writeLock().lockInterruptibly();
                /*
                 * 1 从brokerLiveTable中移除数据
                 */
                this.brokerLiveTable.remove(brokerAddrFound);
                /*
                 * 2 从filterServerTable中移除数据
                 */
                this.filterServerTable.remove(brokerAddrFound);
                String brokerNameFound = null;
                boolean removeBrokerName = false;
                /*
                 * 3 从brokerAddrTable中删除数据
                 */
                Iterator<Entry<String, BrokerData>> itBrokerAddrTable =
                        this.brokerAddrTable.entrySet().iterator();
                while (itBrokerAddrTable.hasNext() && (null == brokerNameFound)) {
   
     
                    BrokerData brokerData = itBrokerAddrTable.next().getValue();
                    //遍历brokerData里面的BrokerAddrs
                    Iterator<Entry<Long, String>> it = brokerData.getBrokerAddrs().entrySet().iterator();
                    while (it.hasNext()) {
   
     
                        Entry<Long, String> entry = it.next();
                        Long brokerId = entry.getKey();
                        String brokerAddr = entry.getValue();
                        //将BrokerAddrs中对应的brokerAddr删除
                        if (brokerAddr.equals(brokerAddrFound)) {
   
     
                            brokerNameFound = brokerData.getBrokerName();
                            it.remove();
                            log.info("remove brokerAddr[{}, {}] from brokerAddrTable, because channel destroyed",
                                    brokerId, brokerAddr);
                            break;
                        }
                    }
                    //如果BrokerAddrs为空了，那么直接移除整个brokerAddrTable的项目
                    if (brokerData.getBrokerAddrs().isEmpty()) {
   
     
                        removeBrokerName = true;
                        itBrokerAddrTable.remove();
                        log.info("remove brokerName[{}] from brokerAddrTable, because channel destroyed",
                                brokerData.getBrokerName());
                    }
                }
                /*
                 * 4 从clusterAddrTable中删除数据
                 */
                if (brokerNameFound != null && removeBrokerName) {
   
     
                    Iterator<Entry<String, Set<String>>> it = this.clusterAddrTable.entrySet().iterator();
                    while (it.hasNext()) {
   
     
                        Entry<String, Set<String>> entry = it.next();
                        String clusterName = entry.getKey();
                        Set<String> brokerNames = entry.getValue();
                        //将brokerNames中对应的brokerName删除
                        boolean removed = brokerNames.remove(brokerNameFound);
                        if (removed) {
   
     
                            log.info("remove brokerName[{}], clusterName[{}] from clusterAddrTable, because channel destroyed",
                                    brokerNameFound, clusterName);
                            //如果brokerNames为空了，那么直接移除整个clusterAddrTable的项目
                            if (brokerNames.isEmpty()) {
   
     
                                log.info("remove the clusterName[{}] from clusterAddrTable, because channel destroyed and no broker in this cluster",
                                        clusterName);
                                it.remove();
                            }

                            break;
                        }
                    }
                }
                /*
                 * 5 从topicQueueTable中删除数据
                 */
                if (removeBrokerName) {
   
     
                    Iterator<Entry<String, List<QueueData>>> itTopicQueueTable =
                            this.topicQueueTable.entrySet().iterator();
                    while (itTopicQueueTable.hasNext()) {
   
     
                        Entry<String, List<QueueData>> entry = itTopicQueueTable.next();
                        String topic = entry.getKey();
                        List<QueueData> queueDataList = entry.getValue();

                        Iterator<QueueData> itQueueData = queueDataList.iterator();
                        while (itQueueData.hasNext()) {
   
     
                            QueueData queueData = itQueueData.next();
                            //将queueDataList中与brokerName一致的queueData删除
                            if (queueData.getBrokerName().equals(brokerNameFound)) {
   
     
                                itQueueData.remove();
                                log.info("remove topic[{} {}], from topicQueueTable, because channel destroyed",
                                        topic, queueData);
                            }
                        }
                        //如果queueDataList为空了，那么直接移除整个topicQueueTable的项目
                        if (queueDataList.isEmpty()) {
   
     
                            itTopicQueueTable.remove();
                            log.info("remove topic[{}] all queue, from topicQueueTable, because channel destroyed",
                                    topic);
                        }
                    }
                }
            } finally {
   
     
                //释放锁
                this.lock.writeLock().unlock();
            }
        } catch (Exception e) {
   
     
            log.error("onChannelDestroy Exception", e);
        }
    }
}
```

如果broker和nameserver之间的长连接异常关闭，那么此前绑定的BrokerHousekeepingService就发挥了作用，BrokerHousekeepingService继承了ChannelEventListener，当触发连接异常事件时，BrokerHousekeepingService内部的方法同样会调用RouteInfoManager#onChannelDestroy清除路由信息。

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

## 4 总结

本那次我们学习了Broker和NameServer之间的心跳服务的源码。包括Broker的心跳上报、NameServer的心跳处理、NameServer的心跳检测三部分的源码。从这些源码可以知道：

**1、**
broker的信息会向nameServer集群中的每一个节点都上报数据，即心跳包，上报的数据包括broker的基本信息，例如brokerAddr、brokerId、brokerName、clusterName等，以及该broker的topic配置信息，比如topicName名字、perm权限、读写队列数量等等属性，当前上报的数据的时间戳版本Dataversion，以及消费过滤信息集合filterServerList；
**2、**
nameServer收到心跳包之后会解析数据并存储在RouteInfoManager的5个map属性中topicQueueTable、brokerAddrTable、clusterAddrTable、brokerLiveTable、filterServerTable；
**3、** 每个nameserver之间不会互相通信，数据不会同步，另外，Nameserver的所有路由数据都存储在内存中，不存在持久化操作，所以nameserver非常的轻量级；
**4、**
nameServer没有数据同步、持久化等机制，这可能会造成数据的不一致，但是能够保证服务的高可用，而对于RocketMQ这样的组件来说，可以牺牲一时的数据不一致，但是不能容忍服务的不可，即nameServer保证了CAP中的AP；