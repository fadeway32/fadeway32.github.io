---

layout: Nacos服务注册源码分析

title: Nacos服务注册源码分析

tags: WEB

categories: Web

top: 52

path: /article/1718893282

abbrlink: 1718893282

date: 2024-06-20 22:21:22


---

# Nacos服务注册源码分析

<img src="https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082039283.png" alt="在这里插入图片描述" style="zoom:100%;" />

## 服务注册表serviceMap

```
/**
 * Map(namespace, Map(group::serviceName, Service)).
 */
private final Map<String, Map<String, Service>> serviceMap = new ConcurrentHashMap<>();
```

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082039447.png)

# 二、Nacos服务注册入口

## 1、SpringBoot自动装配

使用Nacos做为注册中心，首先要在pom中引入：

```
<dependency>
    <groupId>com.alibaba.cloud</groupId>
    <artifactId>spring-cloud-starter-alibaba-nacos-discovery</artifactId>
</dependency>
```

嗯，然后呢？SpringBoot项目大家都知道有一个很重要的东西：spring.factories，这个是针对引入的jar包做自动装配用的；在SpringBoot项目运行时，SpringFactoriesLoader
类会去寻找`META-INF/spring.factories`
文件，spring.factories用键值对的方式记录了所有需要加入容器的类，key为：`org.springframework.boot.autoconfigure.EnableAutoConfiguration`
，value为各种`xxxAutoConfiguration`；或key为：`org.springframework.cloud.bootstrap.BootstrapConfiguration`
，value为各种`xxxBootstrapConfiguration`。

大家对`EnableAutoConfiguration`都比较熟悉了，自动装配的撒；而`BootstrapConfiguration`
可能会相对陌生一点，它呢是做自定义启动配置的，也就是说：所有的Bean都会在SpingApplicatin启动前加入到它的上下文中。

## 2、Nacos中的spring.factories

查看引入的nacos-discovery包的层级结构，找到spring.factories文件；
![在这里插入图片描述](https://ucc.alicdn.com/images/user-upload-01/4763464c9b8e4efaa3d607865cf948e1.png?x-oss-process=image/watermark,type_d3F5LXplbmhlaQ,shadow_50,text_Q1NETiBA5qWg546W5p-S,size_20,color_FFFFFF,t_70,g_se,x_16&x-oss-process=image/resize,w_1400/format,webp)
打开这文件瞅一瞅：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041169.png)
上面我有聊到`BootstrapConfiguration`是在SpringBoot项目启动时自动加载配置到SpingApplicatin的上下文中。
我们进去点进去看一下这个类`NacosDiscoveryClientConfigServiceBootstrapConfiguration`：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041120.png)
emmm，它好像啥也没干，就引入了两个自动配置类：`NacosDiscoveryClientAutoConfiguration`，`NacosDiscoveryAutoConfiguration`
；咱也不知道哪个是和服务注册相关的，先都点进去看看撒。

（1）NacosDiscoveryClientAutoConfiguration：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041190.png)
额额额，从命名来看，好像没有和注册相关的，先看看下一个类吧。

（2）NacosDiscoveryAutoConfiguration：

![在这里插入图片描述](https://ucc.alicdn.com/images/user-upload-01/d4bae685920841f38789f227ec999fd2.png?x-oss-process=image/watermark,type_d3F5LXplbmhlaQ,shadow_50,text_Q1NETiBA5qWg546W5p-S,size_20,color_FFFFFF,t_70,g_se,x_16&x-oss-process=image/resize,w_1400/format,webp)
卧槽，这个好。这个类里能看到用注册register命名的方法；感觉就它了。

## 3、客户端自动注册入口类NacosDiscoveryClientAutoConfiguration

`NacosDiscoveryAutoConfiguration`类内部内部管理了三个类：`NacosServiceRegistry`
（完成服务注册功能，实现ServiceRegistry接口），`NacosRegistration`
（注册时用来存储nacos服务端的相关信息），`NacosAutoServiceRegistration`（自动注册功能）。

这个自动注册功能是怎么实现的呢？从类的命名上来看，感觉是在`NacosAutoServiceRegistration`中的，我们跟进去看一下：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041349.png)
`NacosAutoServiceRegistration`类继承自`AbstractAutoServiceRegistration`类；
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041601.webp)
再看`AbstractAutoServiceRegistration`类实现了`ApplicationListener`
接口。ApplicationListener接口实际是一个事件监听器，其监听`WebServerInitializedEvent`事件。

在`AbstractAutoServiceRegistration`类的bind()方法中会绑定一个事件，启动调用start()方法进行事件的绑定操作。
![在这里插入图片描述](https://ucc.alicdn.com/images/user-upload-01/69ec2713d72f4eb9b705a1201cc4b419.png?x-oss-process=image/watermark,type_d3F5LXplbmhlaQ,shadow_50,text_Q1NETiBA5qWg546W5p-S,size_20,color_FFFFFF,t_70,g_se,x_16&x-oss-process=image/resize,w_1400/format,webp)
start()方法中再调用register()方法实现注册功能，具体的register()内部逻辑由子类实现。
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041112.png)
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041795.png)

> 这里和AQS一样，是典型模板方法设计模式。

go on，go on；我们接着看`ServiceRegistry`接口的实现类，点一下发现直接蹦到了`NacosServiceRegistry`类上；感觉对味了。

虽然我们找到了服务注册的入口，但是呢，其实`spring-cloud-commons`包中定义了一套服务注册规范，集成Spring
Cloud实现服务注册的组件都会实现`ServiceRegistry`接口。

## 4、Nacos服务注册类NacosServiceRegistry

现在我们继续接着NacosServiceRegistry#register()方法来看：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041896.png)
先是组装服务实例信息，然后走入到了`NamingService`接口#registerInstance()方法，我跟，我继续往里跟；点到`NamingService`
接口的实现类`NacosNamingService`；

NacosNamingService类在初始化的时候会实例几个比较关键的类：

```
// 1）发送心跳的
private BeatReactor beatReactor;

// 2）事件分发器：订阅的服务发生改变时，Nacos服务端就会通知到当前Nacos Client端；
//    Client端收到这个通知后，将通知的事件给到观察者，也就是我们自己实现的listener
private EventDispatcher eventDispatcher;

// 3）与Nacos服务端通信的
private NamingProxy serverProxy;
```

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041318.png)

`NacosNamingService`#registerInstance()方法套娃如下：

```java
@Override
public void registerInstance(String serviceName, Instance instance) throws NacosException {
    registerInstance(serviceName, Constants.DEFAULT_GROUP, instance);
}


@Override
public void registerInstance(String serviceName, String groupName, Instance instance) throws NacosException {

    if (instance.isEphemeral()) {
        // 组装心跳信息
        BeatInfo beatInfo = new BeatInfo();
        beatInfo.setServiceName(NamingUtils.getGroupedName(serviceName, groupName));
        beatInfo.setIp(instance.getIp());
        beatInfo.setPort(instance.getPort());
        beatInfo.setCluster(instance.getClusterName());
        beatInfo.setWeight(instance.getWeight());
        beatInfo.setMetadata(instance.getMetadata());
        beatInfo.setScheduled(false);
        long instanceInterval = instance.getInstanceHeartBeatInterval();
        beatInfo.setPeriod(instanceInterval == 0 ? DEFAULT_HEART_BEAT_INTERVAL : instanceInterval);
        
        // 1）发送心跳
        beatReactor.addBeatInfo(NamingUtils.getGroupedName(serviceName, groupName), beatInfo);
    }

    // 2）注册服务    
    serverProxy.registerService(NamingUtils.getGroupedName(serviceName, groupName), groupName, instance);
}
```

这里有两个重要的点：

> 1、如果实例节点是临时节点的话（默认是临时的），会组装一个心跳信息，然后通过 `BeatReactor`组件 `发送心跳到服务端`
> ，也就是 `服务续约`；
> 2、调用 `ServerProxy`组件 `注册服务`到服务端，即 `服务上线`。

在聊服务续约和服务注册之前，我们先看一下serviceName的组成，其实就是就是上面传递下来的groupName和serviceName用@@拼接起来作为新的serviceName，以达到Group层的数据隔离。

```java
NamingUtils.getGroupedName(serviceName, groupName)

// NamingUtils
public static String getGroupedName(String serviceName, String groupName) {
        return groupName + Constants.SERVICE_INFO_SPLITER + serviceName;
    }
```

### 1）Client服务续约

即Nacos Client端定时发送心跳到服务端。
在`BeatReactor`#addBeatInfo()方法中，会启动一个定时任务，立即执行BeatTask这个任务。
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041554.png)
我们接着来看BeatTask这个Runnable接口的实现类，是如何运行的？
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041835.png)

我们可以看到它主要展现两个能力：

> （1）调用 `NamingProxy`向Nacos服务端发送心跳；
> （2）再开启一个定时任务，延时5S再持续发送心跳到Nacos服务端，即默认每5s向Nacos服务端发送一次心跳。

发送心跳就很简单了，直接采用`HTTP接口调用`的方式，调用服务端的`/nacos/v1/ns/instance/beat`接口。
![在这里插入图片描述](https://ucc.alicdn.com/images/user-upload-01/1d10fa39daea4f12917f7384a78e5aca.png?x-oss-process=image/watermark,type_d3F5LXplbmhlaQ,shadow_50,text_Q1NETiBA5qWg546W5p-S,size_20,color_FFFFFF,t_70,g_se,x_16&x-oss-process=image/resize,w_1400/format,webp)

### 2）Client服务注册

在`NamingProxy`#registerService()方法中直接做HTTP请求调用Nacos Server的接口`/nacos/v1/ns/instance`做服务注册：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041208.png)

```java
public static String WEB_CONTEXT = "/nacos";

public static String NACOS_URL_BASE = WEB_CONTEXT + "/v1/ns";

public static String NACOS_URL_INSTANCE = NACOS_URL_BASE + "/instance";
```

## 5、Nacos Server端如何接收心跳、服务注册请求

上面我们聊到了Nacos Client端分别调用服务端的`/nacos/v1/ns/instance/beat`、`/nacos/v1/ns/instance`
接口进行服务续约和服务注册，下面我们聊一下服务端对这个两个请求是如何处理的？

### 0）先找入口

Nacos Client通过`NamingProxy`类调用Nacos Server，以开源框架的命名规范来看，Nacos Server的源码中应该有个和naming相关命名的模块；
![在这里插入图片描述](https://ucc.alicdn.com/images/user-upload-01/a275b527d6e540d2ab8312e2d2247bf2.png?x-oss-process=image/watermark,type_d3F5LXplbmhlaQ,shadow_50,text_Q1NETiBA5qWg546W5p-S,size_20,color_FFFFFF,t_70,g_se,x_16&x-oss-process=image/resize,w_1400/format,webp)
接着往下展开，找到controllers包下的`InstanceController`：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041865.png)

### 1）Server端接收服务注册请求

`InstanceController#register()`方法是Nacos Server接收服务注册请求的入口：

```java
@CanDistro
@PostMapping
@Secured(parser = NamingResourceParser.class, action = ActionTypes.WRITE)
public String register(HttpServletRequest request) throws Exception {
    
    final String namespaceId = WebUtils
            .optional(request, CommonParams.NAMESPACE_ID, Constants.DEFAULT_NAMESPACE_ID);
    final String serviceName = WebUtils.required(request, CommonParams.SERVICE_NAME);
    NamingUtils.checkServiceNameFormat(serviceName);
    
    final Instance instance = HttpRequestInstanceBuilder.newBuilder()
            .setDefaultInstanceEphemeral(switchDomain.isDefaultInstanceEphemeral()).setRequest(request).build();
    // 真正注册服务的地方，serviceName为注册的服务名，namespaceId默认为public
    getInstanceOperator().registerInstance(namespaceId, serviceName, instance);
    return "ok";
}
```

其中namespaceId可以做一层数据隔离；
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041014.png)
我们接着往里看`getInstanceOperator().registerInstance()`：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041456.webp)
InstanceOperator接口有两个实现类，分别是：`InstanceOperatorClientImpl`，`InstanceOperatorServiceImpl`
，由于我这里是作为服务端，我们关注`InstanceOperatorServiceImpl`；
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041509.png)

> 1、组装服务的实例信息，包含：IP、Port
> 2、调用ServiceManager的registerInstanc()方法，完成真正的服务注册操作。

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041640.png)

ServiceManager#registerInstanc()方法中主要做四件事：

> 1、如果服务不存在，则创建一个服务；
> 2、从本地缓存《Map(namespace, Map(group::serviceName, Service))》中获取服务信息；
> 3、校验服务不能为null；
> 4、将服务的实例信息添加到DataStore的dataMap缓存中

#### （1）创建服务

这里的操作也很简单，套娃套娃套娃，不对是封装、抽象。最终将服务信息保存到本地缓存serviceMap中。

```java
public void createEmptyService(String namespaceId, String serviceName, boolean local) throws NacosException {
    createServiceIfAbsent(namespaceId, serviceName, local, null);
}

public void createServiceIfAbsent(String namespaceId, String serviceName, boolean local, Cluster cluster)
        throws NacosException {
    Service service = getService(namespaceId, serviceName);
    if (service == null) {
        
        Loggers.SRV_LOG.info("creating empty service {}:{}", namespaceId, serviceName);
        service = new Service();
        service.setName(serviceName);
        service.setNamespaceId(namespaceId);
        service.setGroupName(NamingUtils.getGroupName(serviceName));
        // now validate the service. if failed, exception will be thrown
        service.setLastModifiedMillis(System.currentTimeMillis());
        service.recalculateChecksum();
        if (cluster != null) {
            cluster.setService(service);
            service.getClusterMap().put(cluster.getName(), cluster);
        }
        service.validate();

        // 存储服务信息和初始化，点进去
        putServiceAndInit(service);
        if (!local) {
            addOrReplaceService(service);
        }
    }
}

private void putServiceAndInit(Service service) throws NacosException {
    putService(service);
    service = getService(service.getNamespaceId(), service.getName());
    // 服务初始化，会做健康检查
    service.init();

    // 添加两个监听器，使用Raft协议和 Distro协议维护数据一致性的，，包括：Nacos Client感知服务提供者实例变更
    consistencyService
            .listen(KeyBuilder.buildInstanceListKey(service.getNamespaceId(), service.getName(), true), service);
    consistencyService
            .listen(KeyBuilder.buildInstanceListKey(service.getNamespaceId(), service.getName(), false), service);
    Loggers.SRV_LOG.info("[NEW-SERVICE] {}", service.toJson());
}

// ”服务注册“操作，也就是将服务信息保存到本地缓存serviceMap中。
public void putService(Service service) {
    if (!serviceMap.containsKey(service.getNamespaceId())) {
        serviceMap.putIfAbsent(service.getNamespaceId(), new ConcurrentSkipListMap<>());
    }
    serviceMap.get(service.getNamespaceId()).putIfAbsent(service.getName(), service);
}
```

注意：在service.init()初始化服务时，会启动一个定时任务做不健康服务的`服务剔除`：

```java
/**
 * Service#init()
 */
public void init() {
    // 开始一个定时任务，对不健康的服务实例做服务下线/剔除，点进去
    HealthCheckReactor.scheduleCheck(clientBeatCheckTask);
    for (Map.Entry<String, Cluster> entry : clusterMap.entrySet()) {
        entry.getValue().setService(this);
        entry.getValue().init();
    }
}

@JsonIgnore
private ClientBeatCheckTask clientBeatCheckTask = new ClientBeatCheckTask(this);
```

走到`HealthCheckReactor.scheduleCheck()`方法中，会延时5s开启一个固定延时5s的FixedDelay类型的定时任务执行服务剔除操作；
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041684.png)
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041746.webp)

另外：由于`ClientBeatCheckTask`不是`NacosHealthCheckTask`的实现类，所以定时任务中执行的方法为`ClientBeatCheckTask`
中的run()方法；
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041875.webp)
看一下`ClientBeatCheckTask`的run()方法：

> 通过判断当前时间和实例最后一次心跳时间的间隔是否大于阈值（默认15s），决定是否进行服务剔除/下线；
> ![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041335.png)

#### （2）从本地缓存Map中获取服务信息

从本地缓存serviceMap中获取服务信息，没别的啥操作

```java
public Service getService(String namespaceId, String serviceName) {
   // 如果namespaceId没有的话
    if (serviceMap.get(namespaceId) == null) {
        return null;
    }
    // 点进去
    return chooseServiceMap(namespaceId).get(serviceName);
}

public Map<String, Service> chooseServiceMap(String namespaceId) {
    return serviceMap.get(namespaceId);
}
```

#### （3）校验服务不能为null

一个单纯的判空处理；

```java
public void checkServiceIsNull(Service service, String namespaceId, String serviceName) throws NacosException {
    if (service == null) {
        throw new NacosException(NacosException.INVALID_PARAM,
                "service not found, namespace: " + namespaceId + ", serviceName: " + serviceName);
    }
}
```

#### （4）**服务实例信息"持久化"

将服务的相应实例信息保存到DataStore的serviceMap中；由于存在多个服务实例同时注册的场景，所以要加一个synchronized锁。

```java
public void addInstance(String namespaceId, String serviceName, boolean ephemeral, Instance... ips)
        throws NacosException {
    
    String key = KeyBuilder.buildInstanceListKey(namespaceId, serviceName, ephemeral);
    
    Service service = getService(namespaceId, serviceName);
    
    synchronized (service) {
        List<Instance> instanceList = addIpAddresses(service, ephemeral, ips);
        
        Instances instances = new Instances();
        instances.setInstanceList(instanceList);

        // 保存服务信息，key为namespaceId和serviceName的结合体，点进去
        consistencyService.put(key, instances);
    }
}
```

`ConsistencyService`是一个接口，由于我们默认是采用`ephemeral`方式（在聊Nacos
Client时我们也有提到，服务端见`Instance#isEphemeral()` 或 `SwitchDomain#isDefaultInstanceEphemeral()`
），所以以临时Client为例，我们看一下`DistroConsistencyServiceImpl`；**如果是持久client，则关注RaftConsistencyServiceImpl。**
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041744.png)

```java
@Override
public void put(String key, Record value) throws NacosException {
    // 服务实例信息持久化，点进去
    onPut(key, value);
    // If upgrade to 2.0.X, do not sync for v1.
    if (ApplicationUtils.getBean(UpgradeJudgement.class).isUseGrpcFeatures()) {
        return;
    }

    // Nacos集群间数据同步
    distroProtocol.sync(new DistroKey(key, KeyBuilder.INSTANCE_LIST_KEY_PREFIX), DataOperation.CHANGE,
            DistroConfig.getInstance().getSyncDelayMillis());
}
```

进入到`DistroConsistencyServiceImpl`类的onPut()方法：

```java
public void onPut(String key, Record value) {
    
    if (KeyBuilder.matchEphemeralInstanceListKey(key)) {
        Datum<Instances> datum = new Datum<>();
        datum.value = (Instances) value;
        datum.key = key;
        datum.timestamp.incrementAndGet();
        // 往DataStore的dataMap中添加数据，点进去
        dataStore.put(key, datum);
    }

    // 如果listener中没有这个key的话直接返回，key是在创建Service时添加进去的，见ServiceManager#putServiceAndInit()方法
    if (!listeners.containsKey(key)) {
        return;
    }

    // 通知Nacos client服务端服务实例信息发生变更，这里是先添加任务；点进去
    notifier.addTask(key, DataOperation.CHANGE);
}
```

##### 1. 往DataStore的dataMap中添加数据

```java
@Component
public class DataStore {
    
    private Map<String, Datum> dataMap = new ConcurrentHashMap<>(1024);
    
    public void put(String key, Datum value) {
        // 单纯的往一个Map缓存放一下数据
        dataMap.put(key, value);
    }
}
```

##### 2. 进入到Notifier类内部，通知服务实例信息变更

进入到DistroConsistencyServiceImpl的内部类`Notifier`，先看其addTask()方法：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041651.png)
![在这里插入图片描述](https://ucc.alicdn.com/images/user-upload-01/371886888b5b43b58af622977c853260.png?x-oss-process=image/resize,w_1400/format,webp)
最重要的一步将服务实例信息添加到tasks任务队列中，按常理来说到这也就结束了；但是添加到任务队列之后呢，怎么处理嘞？
我们注意到`DistroConsistencyServiceImpl`中有一个`@PostConstruct`修饰的init()
方法，也就是说在`DistroConsistencyServiceImpl`类构造器执行之后会执行这个方法`启动Notifier通知器`:
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041691.webp)
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041949.webp)
我们走入`Notifer#run()`方法：

首先从tasks任务丢列中取出任务，调用自己的handle()方法处理任务：
![在这里插入图片描述](https://ucc.alicdn.com/images/user-upload-01/8f8b355d405a4cd4831792df6a51e1a7.png?x-oss-process=image/watermark,type_d3F5LXplbmhlaQ,shadow_50,text_Q1NETiBA5qWg546W5p-S,size_20,color_FFFFFF,t_70,g_se,x_16&x-oss-process=image/resize,w_1400/format,webp)
handle()方法中调用监听器listener的onChange()/onDelete()方法执行相应通知数据更新、删除的逻辑。
![在这里插入图片描述](https://ucc.alicdn.com/images/user-upload-01/88586cd76f564b10bdbd0c54285f1478.png?x-oss-process=image/watermark,type_d3F5LXplbmhlaQ,shadow_50,text_Q1NETiBA5qWg546W5p-S,size_20,color_FFFFFF,t_70,g_se,x_16&x-oss-process=image/resize,w_1400/format,webp)
下面我着重看一下通知数据变更的onChange()方法：

`RecordListener`是一个接口，它有三个实现，我们进入到它的实现类`Service`中；
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041580.webp)
着重看一下updateIPs()方法，其他代码不涉及到主链路；
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041728.png)
遍历要注册的instance集合，采用一个临时的Map记录clusterName和Instance实例的对应关系，然后更新clusterMap<clusterName,
Cluster>：

> 维护 `Cluster`中实例的代码大家感兴趣可以点进去看看，主要思想还是比对新老数据，找出新的instance，与挂掉的instance，最后更新
> cluster对象里面的存放临时节点的集合 `或 存放永久节点的集合`。

最后调用PushService通知单客户端服务信息发生变更。
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041826.png)

OK，fine！Nacos服务注册，服务端主要是将服务信息和服务的实例信息保存到两个Map（serviceMap、dataMap）中；启动一个延时5s执行的定时任务做服务剔除/下线；`Notifier`
做普通服务集群实例信息维护，调用PushService通知客户端服务信息发生变更。

### 2）Server端接收心跳请求

`InstanceController#beat()`方法是Nacos Server接收心跳请求的入口：

其内部调用`InstanceOperator`接口的handleBeat()方法做心跳判断；
![在这里插入图片描述](https://ucc.alicdn.com/images/user-upload-01/b4be0067498b4a4f9e51fdf7cf15dde8.png?x-oss-process=image/watermark,type_d3F5LXplbmhlaQ,shadow_50,text_Q1NETiBA5qWg546W5p-S,size_20,color_FFFFFF,t_70,g_se,x_16&x-oss-process=image/resize,w_1400/format,webp)
`InstanceOperator`有两个实现类，我们这里讨论的是服务端如何处理客户端的心跳请求，因此我们看`InstanceOperatorServiceImpl`类；
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041393.png)
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041469.webp)
`InstanceOperatorServiceImpl`#handleBeat()：

> 1、如果服务还没有注册，就先注册；
> 2、接着获取服务信息，校验服务不能为null；
> 3、最后，调用 `Service#processClientBeat()`处理客户端心跳；

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041767.png)

`Service#processClientBeat()`中启动一个只执行一次的任务：
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041751.webp)
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041041.webp)
![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041173.webp)
任务的逻辑体现在`ClientBeatProcessor`#run()方法中：

> 1、更新实例的最后一次心跳时间，进而决定服务是否需要下线/剔除；
> 2、如果服务之前是不可用的，则设置服务为可用的，并调用 `PushService`通知客户端；

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202407082041472.png)

服务端对于心跳的处理，主要两件事：维护心跳的最后一次时间，如果服务变为可用状态则通知客户端；另外在服务注册创建Service服务时会启动一个固定延时5S执行的定时任务做服务的剔除，其中以心跳时间为根本逻辑。