---

layout: XXL-JOB源码分析

title: XXL-JOB源码分析

tags: redis

categories: Web

top: 40

path: /article/1717408917

abbrlink: 1717408917

date: 2023-05-19 21:21:21


---

# XXL-JOB源码分析

架构图：

![image-20240110150652050](https://gitee.com/fadeway32/fadeway32/raw/master/img/image-20240110150652050.png)

代码结构：

xxl-job-core

![image-20240110150841306](https://gitee.com/fadeway32/fadeway32/raw/master/img/image-20240110150841306.png)

xxl-job-admin

![image-20240110150755787](https://gitee.com/fadeway32/fadeway32/raw/master/img/image-20240110150755787.png)

源码解析：

一、核心类
JobTriggerPoolHelper 触发器线程池帮助类
JobRegistryHelper 注册帮助类
JobFailMonitorHelper 失败监控帮助类
JobLogReportHelper 日志报告帮助类
JobScheduleHelper 定时任务帮助类

### 二、XXLJob-core执行流程

![image-20240110151034220](https://gitee.com/fadeway32/fadeway32/raw/master/img/image-20240110151034220.png)

问题一？IJobHandler什么适合被初始化呢？实现主要有三个MethodJobHandler、ScriptJobHandler、GlueJobHandler

XxlJobAdminConfig是核心的配置类，实现了InitializingBean接口，重写了afterPropertiesSet（）方法，代码如下：

~~~java
   @Override
    public void afterPropertiesSet() throws Exception {
        adminConfig = this;
 
        xxlJobScheduler = new XxlJobScheduler();
        xxlJobScheduler.init();
    }
~~~

init方法实现了一系列的初始化，看看有没有跟IJobHandler有关。

~~~java
    public void init() throws Exception {
        // init i18n
        initI18n();
 
        // admin trigger pool start
        JobTriggerPoolHelper.toStart();
 
        // admin registry monitor run
        JobRegistryHelper.getInstance().start();
 
        // admin fail-monitor run
        JobFailMonitorHelper.getInstance().start();
 
        // admin lose-monitor run ( depend on JobTriggerPoolHelper )
        JobCompleteHelper.getInstance().start();
 
        // admin log report start
        JobLogReportHelper.getInstance().start();
 
        // start-schedule  ( depend on JobTriggerPoolHelper )
        JobScheduleHelper.getInstance().start();
 
        logger.info(">>>>>>>>> init xxl-job admin success.");
    }
~~~

这里做了一些列的事情，包括开启触发池启动，用来定时触发任务的、注册监控的运行等。可以看到JobScheduleHelper.getInstance()
.start()是开启任务的核心方法，JobScheduleHelper.getInstance()单例的方式，调用方法代码如下：

~~~java
  // Scan Job
  // 1、pre read
  // 2、push time-ring
  // 3、update trigger info
~~~

这里的start方法主要是扫描所有的任务，包括下面的部分

1、首先是通过查询数据库，把所有的任务扫描出来

2、遍历所有的任务执行JobTriggerPoolHelper.trigger(jobInfo.getId(), TriggerTypeEnum.MISFIRE, -1, null, null, null);触发这条任务

3、refreshNextValidTime(jobInfo, new Date()) 刷新下次过期的时间

这里的核心方法就是JobTriggerPoolHelper.trigger方法，是一个静态方法，代码如下：

~~~java
private static JobTriggerPoolHelper helper = new JobTriggerPoolHelper();
 
 public static void trigger(int jobId, TriggerTypeEnum triggerType, int failRetryCount, String 	                           executorShardingParam, String executorParam, String addressList) {
        helper.addTrigger(jobId, triggerType, failRetryCount, executorShardingParam, executorParam, addressList);
    }
~~~

1、根据判断是否超过10次重试，选择快速[线程池](https://so.csdn.net/so/search?q=线程池&spm=1001.2101.3001.7020)还是慢速线程池

2、XxlJobTrigger执行触发，也是一个静态的方法

这里是**XxlJobTrigger**，是任务触发类。主要做了三个事情

~~~javascript
       // load data

XxlJobInfo
jobInfo = XxlJobAdminConfig.getAdminConfig().getXxlJobInfoDao().loadById(jobId);


// cover addressList
if (addressList != null && addressList.trim().length() > 0) {
     group.setAddressType(1);
     group.setAddressList(addressList.trim());
}

// sharding param

//如果是分片触发的话，就要在这里进行处理
if (ExecutorRouteStrategyEnum.SHARDING_BROADCAST == ExecutorRouteStrategyEnum.match(jobInfo.getExecutorRouteStrategy(), null)
        && group.getRegistryList() != null && !group.getRegistryList().isEmpty()
        && shardingParam == null) {
     for (int i = 0;
     i < group.getRegistryList().size();
     i++
)
     {
          processTrigger(group, jobInfo, finalFailRetryCount, triggerType, i, group.getRegistryList().size());
     }
} else {
     if (shardingParam == null) {
          shardingParam = new int[]
          {
               0, 1
          }
          ;
     }
     processTrigger(group, jobInfo, finalFailRetryCount, triggerType, shardingParam[0], shardingParam[1]);
}
1.
加载数据
2.
转化地址
3.
分片参数处理
~~~

## X触发任务核心逻辑

这里的核心方法是**processTrigger**
方法，核心的处理触发的逻辑，包括阻塞策略选择，页面配置的路由策略选择。保存日志，初始化触发任务的参数，从jobInfo中获取。初始化调用地址，会根据各种算法进行选择地址，比如FIFO，轮询等。代码如下：

~~~java
 private static void processTrigger(XxlJobGroup group, XxlJobInfo jobInfo, int finalFailRetryCount, TriggerTypeEnum triggerType, int index, int total){
 
        // param
        ExecutorBlockStrategyEnum blockStrategy = ExecutorBlockStrategyEnum.match(jobInfo.getExecutorBlockStrategy(), ExecutorBlockStrategyEnum.SERIAL_EXECUTION);  // block strategy
        ExecutorRouteStrategyEnum executorRouteStrategyEnum = ExecutorRouteStrategyEnum.match(jobInfo.getExecutorRouteStrategy(), null);    // route strategy
        String shardingParam = (ExecutorRouteStrategyEnum.SHARDING_BROADCAST==executorRouteStrategyEnum)?String.valueOf(index).concat("/").concat(String.valueOf(total)):null;
 
        // 1、save log-id
        XxlJobLog jobLog = new XxlJobLog();
        jobLog.setJobGroup(jobInfo.getJobGroup());
        jobLog.setJobId(jobInfo.getId());
        jobLog.setTriggerTime(new Date());
        XxlJobAdminConfig.getAdminConfig().getXxlJobLogDao().save(jobLog);
        logger.debug(">>>>>>>>>>> xxl-job trigger start, jobId:{}", jobLog.getId());
 
        // 2、init trigger-param
        TriggerParam triggerParam = new TriggerParam();
        //省略代码
        triggerParam.setBroadcastTotal(total);
 
        // 3、init address
        String address = null;
        ReturnT<String> routeAddressResult = null;
        if (group.getRegistryList()!=null && !group.getRegistryList().isEmpty()) {
            if (ExecutorRouteStrategyEnum.SHARDING_BROADCAST == executorRouteStrategyEnum) {
                if (index < group.getRegistryList().size()) {
                    address = group.getRegistryList().get(index);
                } else {
                    address = group.getRegistryList().get(0);
                }
            } else {
                routeAddressResult = executorRouteStrategyEnum.getRouter().route(triggerParam, group.getRegistryList());
                if (routeAddressResult.getCode() == ReturnT.SUCCESS_CODE) {
                    address = routeAddressResult.getContent();
                }
            }
        } else {
            routeAddressResult = new ReturnT<String>(ReturnT.FAIL_CODE, I18nUtil.getString("jobconf_trigger_address_empty"));
        }
 
        // 4、trigger remote executor
        ReturnT<String> triggerResult = null;
        if (address != null) {
            triggerResult = runExecutor(triggerParam, address);
        } else {
            triggerResult = new ReturnT<String>(ReturnT.FAIL_CODE, null);
        }
 
        // 5、collection trigger info
        StringBuffer triggerMsgSb = new StringBuffer();
 
        // 6、save log trigger-info
        jobLog.setExecutorAddress(address);
        //省略代码
        XxlJobAdminConfig.getAdminConfig().getXxlJobLogDao().updateTriggerInfo(jobLog);
 
        logger.debug(">>>>>>>>>>> xxl-job trigger end, jobId:{}", jobLog.getId());
    }
~~~

简单总结流程: // param1、save log-id 2、init trigger-param 3、init address 4、trigger remote executor 5、collection trigger
info 6、save log trigger-info

最核心的操作是**runExecutor**(triggerParam, address)执行远程任务方法，委托**ExecutorBiz**

执行run方法，代码如下：

~~~java
  public static ReturnT<String> runExecutor(TriggerParam triggerParam, String address){
        ReturnT<String> runResult = null;
        try {
            ExecutorBiz executorBiz = XxlJobScheduler.getExecutorBiz(address);
            runResult = executorBiz.run(triggerParam);
        } catch (Exception e) {
            logger.error(">>>>>>>>>>> xxl-job trigger error, please check if the executor[{}] is running.", address, e);
            runResult = new ReturnT<String>(ReturnT.FAIL_CODE, ThrowableUtil.toString(e));
        }
 
        StringBuffer runResultSB = new StringBuffer(I18nUtil.getString("jobconf_trigger_run") + "：");
        runResultSB.append("<br>address：").append(address);
        runResultSB.append("<br>code：").append(runResult.getCode());
        runResultSB.append("<br>msg：").append(runResult.getMsg());
 
        runResult.setMsg(runResultSB.toString());
        return runResult;
    }
~~~

runExecutor是一个静态方法，其中委托了ExecutorBiz执行run方法。是通过XxlJobScheduler.getExecutorBiz(address)
来获取到ExecutorBiz对象。这个对象定义了执行业务的统一接口。核心的操作方法包括run运行，还有beat心跳方法，以及kill方法等。

实现类主要是ExecutorBizImpl和ExecutorBizClient。我们核心看run方法

![image-20240110151443859](https://gitee.com/fadeway32/fadeway32/raw/master/img/image-20240110151443859.png)

#### 2.xxIjobHandler的初始化

这里有加载**IJobHandler**的实现！！！终于可以解释什么适合初始化**IJobHandler的**问题了.

~~~java
  @Override
    public ReturnT<String> run(TriggerParam triggerParam) {
 
         // load old：jobHandler + jobThread
        JobThread jobThread = XxlJobExecutor.loadJobThread(triggerParam.getJobId());
        IJobHandler jobHandler = jobThread!=null?jobThread.getHandler():null;
}
~~~

run方法的主要核心逻辑是：

1、首先尝试从缓存中加载 IJobHandler

2、如果加载不了，判断执行执行任务的累心GlueTypeEnum

3、从XxlJobExecutor中加载IJobHandler，也就是XxlJobExecutor.loadJobHandler方法。那么问题就来了，这个ijobHandler什么时候去注册呢，也就是XxlJobExecutor.registJobHandler注册执行器的时机是什么呢？

三、IjobHandler注册流程
很重要的@XxlJob注解的方法是如何注册的呢？我们首先来看XxlJobSpringExecutor这个执行器，继承了XxlJobExecutor，同时实现了ApplicationContextAware，SmartInitializingSingleton，DisposableBean等接口，熟悉Spring生命周期的朋友都知道。实现这几个接口必须重写afterSingletonsInstantiated、setApplicationContext、destroy方法。

~~~java
 public class XxlJobSpringExecutor extends XxlJobExecutor implements ApplicationContextAware, SmartInitializingSingleton, DisposableBean {
    //省略代码
}
~~~

核心关注**afterSingletonsInstantiated**方法。这里面包含了初始化JobHandler的核心逻辑以及父类start方法。

~~~java
   @Override
    public void afterSingletonsInstantiated() {
 
        // init JobHandler Repository
        /*initJobHandlerRepository(applicationContext);*/
 
        // init JobHandler Repository (for method)
        initJobHandlerMethodRepository(applicationContext);
 
        // refresh GlueFactory
        GlueFactory.refreshInstance(1);
 
        // super start
        try {
            super.start();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
~~~

首先来看**initJobHandlerMethodRepository**
（applicationContext），这里依赖了SpringApplication容器的上下文，就可以从Spring中读取这里@Xxljob注解的方法，然后进行[handler](https://so.csdn.net/so/search?q=handler&spm=1001.2101.3001.7020)
的初始化。！！

```javascript
private
void initJobHandlerMethodRepository(ApplicationContext
applicationContext
)
{
     if (applicationContext == null) {
          return;
     }
     // init job handler from method
     String[]
     beanDefinitionNames = applicationContext.getBeanNamesForType(Object.class, false, true);
     for (String beanDefinitionName : beanDefinitionNames
)
     {
          Object
          bean = applicationContext.getBean(beanDefinitionName);

          Map < Method, XxlJob > annotatedMethods = null;   // referred to ：org.springframework.context.event.EventListenerMethodProcessor.processBean
          try {
               annotatedMethods = MethodIntrospector.selectMethods(bean.getClass(),
                       new MethodIntrospector.MetadataLookup < XxlJob > ()
               {
               @Override
                    public
                    XxlJob
                    inspect(Method
                    method
               )
                    {
                         return AnnotatedElementUtils.findMergedAnnotation(method, XxlJob.class);
                    }
               }
          )
               ;
          } catch (Throwable
          ex
     )
          {
               logger.error("xxl-job method-jobhandler resolve error for bean[" + beanDefinitionName + "].", ex);
          }
          if (annotatedMethods == null || annotatedMethods.isEmpty()) {
               continue;
          }

          for (Map.Entry < Method, XxlJob > methodXxlJobEntry :
          annotatedMethods.entrySet()
     )
          {
               Method
               executeMethod = methodXxlJobEntry.getKey();
               XxlJob
               xxlJob = methodXxlJobEntry.getValue();
               if (xxlJob == null) {
                    continue;
               }

               String
               name = xxlJob.value();
               if (name.trim().length() == 0) {
                    throw new RuntimeException("xxl-job method-jobhandler name invalid, for[" + bean.getClass() + "#" + executeMethod.getName() + "] .");
               }
               if (loadJobHandler(name) != null) {
                    throw new RuntimeException("xxl-job jobhandler[" + name + "] naming conflicts.");
               }

               // execute method
               /*if (!(method.getParameterTypes().length == 1 && method.getParameterTypes()[0].isAssignableFrom(String.class))) {
                   throw new RuntimeException("xxl-job method-jobhandler param-classtype invalid, for[" + bean.getClass() + "#" + method.getName() + "] , " +
                           "The correct method format like \" public ReturnT<String> execute(String param) \" .");
               }
               if (!method.getReturnType().isAssignableFrom(ReturnT.class)) {
                   throw new RuntimeException("xxl-job method-jobhandler return-classtype invalid, for[" + bean.getClass() + "#" + method.getName() + "] , " +
                           "The correct method format like \" public ReturnT<String> execute(String param) \" .");
               }*/

               executeMethod.setAccessible(true);

               // init and destory
               Method
               initMethod = null;
               Method
               destroyMethod = null;

               if (xxlJob.init().trim().length() > 0) {
                    try {
                         initMethod = bean.getClass().getDeclaredMethod(xxlJob.init());
                         initMethod.setAccessible(true);
                    } catch (NoSuchMethodException
                    e
               )
                    {
                         throw new RuntimeException("xxl-job method-jobhandler initMethod invalid, for[" + bean.getClass() + "#" + executeMethod.getName() + "] .");
                    }
               }
               if (xxlJob.destroy().trim().length() > 0) {
                    try {
                         destroyMethod = bean.getClass().getDeclaredMethod(xxlJob.destroy());
                         destroyMethod.setAccessible(true);
                    } catch (NoSuchMethodException
                    e
               )
                    {
                         throw new RuntimeException("xxl-job method-jobhandler destroyMethod invalid, for[" + bean.getClass() + "#" + executeMethod.getName() + "] .");
                    }
               }

               // registry jobhandler
               registJobHandler(name, new MethodJobHandler(bean, executeMethod, initMethod, destroyMethod));
          }
     }

}
```

简单总结逻辑如下：

1、从Spring上下文读取所有的Bean定义

2、过滤所有带XxlJob注解方法，是一个Map,key是Method,value是XxlJob注解

3、再次遍历Map,获得方法和对应的Xxljob注解

4、反射出init方法和destroy方法

5、执行注册registJobHandler注册任务处理器的方法

最核心部分是2中过滤器出所有带@Xxljob注解的方法和注解的值。和5部分执行注册处理器的逻辑。我们来看一下注册处理器的方法。

~~~java
 private static ConcurrentMap<Integer, JobThread> jobThreadRepository = new ConcurrentHashMap<Integer, JobThread>();
    
public static IJobHandler registJobHandler(String name, IJobHandler jobHandler){
        logger.info(">>>>>>>>>>> xxl-job register jobhandler success, name:{}, jobHandler:{}", name, jobHandler);
        return jobHandlerRepository.put(name, jobHandler);
    }
~~~

直接丢在了XxlJobExecutor中的一个静态变量中jobThreadRepository。这就跟上面如何注册JobHandler联系起来了

### 总结

1、声明核心接口

2、提供不同的实现类

3、提供初始化的入口

4、需要从数据库加载这些配置信息。

总图

![image-20240110154028192](https://gitee.com/fadeway32/fadeway32/raw/master/img/image-20240110154028192.png)

xxl 调度中心流程

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202401101553746.png)

本篇内容主要是在探索执行器注册到调度中心的流程以及代码实现，流程如下：

调度中心启动了一个Tomcat作为Web容器，暴露出注册与注销的接口，可以供执行器调用。
执行器在启动Netty服务暴露出调度接口后，将自己的name、ip、端口信息通过调度中心的注册接口传输到调度中心，同时每30秒会调用一次注册接口，用于更新注册信息。
同理，在执行器停止的时候，也会请求调度中心的注销接口，进行注销。
调度中心在接收到注册或注销请求后，会操作xxl_job_registry表，新增或删除执行器的注册信息。
调度中心会启动一个探活线程，将90秒都没有更新注册信息的执行器删除掉。

