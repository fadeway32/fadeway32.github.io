---

layout: 15、RocketMQ源码分析：消费者DefaultMQPushConsumer启动主要流程源码

title:  15、RocketMQ源码分析：消费者DefaultMQPushConsumer启动主要流程源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713340

abbrlink: 1739713340

date: 2025-02-16 21:42:06


--- 

# 15、RocketMQ源码分析：消费者DefaultMQPushConsumer启动主要流程源码

此前我们学习了Producer和Broker的启动源码，以及Producer发送消息源码和Broker接收存储消息的源码，现在，我们来学习Consumer的启动以及消费消息的源码。Consumer的启动源码和Producer的启动源码还是有很多相似的地方的。

#### 文章目录

- 1 创建DefaultMQPushConsumer实例
- 2 subscribe订阅
- 3 start启动消费者
-
    - 3.1 copySubscription拷贝订阅关系
- 4 小结

客户端常用的消费者类是DefaultMQPushConsumer，此类的简单消费者案例如下，在RocketMQ源码的example模块下的找到更多快速案例。

```java
public class Consumer {
   
     

    public static void main(String[] args) throws InterruptedException, MQClientException {
   
     

        /*
         * Instantiate with specified consumer group name.
         */
        DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("ConsumerStart");
        consumer.setNamesrvAddr("127.0.0.1:9876");
        /*
         * Specify where to start in case the specific consumer group is a brand-new one.
         */
        consumer.setConsumeFromWhere(ConsumeFromWhere.CONSUME_FROM_FIRST_OFFSET);

        /*
         * Subscribe one more topic to consume.
         */
        consumer.subscribe("ConsumerStart", "*");

        /*
         *  Register callback to execute on arrival of messages fetched from brokers.
         */
        consumer.registerMessageListener(new MessageListenerConcurrently() {
   
     

            @Override
            public ConsumeConcurrentlyStatus consumeMessage(List<MessageExt> msgs,
                                                            ConsumeConcurrentlyContext context) {
   
     
                System.out.printf("%s Receive New Messages: %s %n", Thread.currentThread().getName(), msgs);
                return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
            }
        });

        /*
         *  Launch the consumer instance.
         */
        consumer.start();

        System.out.printf("Consumer Started.%n");

        //Thread.sleep(5000);
        //consumer.shutdown();
    }
}
```

我们本次分析RocketMQ消费者启动的源码。实际上就是分析DefaultMQPushConsumer的构造器以及start方法的源码。
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162109214.png)

## 1 创建DefaultMQPushConsumer实例

DefaultMQPushConsumer的构造器有很多，但最终都是调用下面四个参数的构造函数：

```java
/**
 * 创建DefaultMQPushConsumer实例
 *
 * @param namespace                    namespace地址
 * @param consumerGroup                消费者组
 * @param rpcHook                      在每个远程处理命令之前执行的RPC钩子
 * @param allocateMessageQueueStrategy 消费者之间消息分配的策略算法
 */
public DefaultMQPushConsumer(final String namespace, final String consumerGroup, RPCHook rpcHook,
                             AllocateMessageQueueStrategy allocateMessageQueueStrategy) {
   
     
    this.consumerGroup = consumerGroup;
    this.namespace = namespace;
    this.allocateMessageQueueStrategy = allocateMessageQueueStrategy;
    //创建DefaultMQPushConsumerImpl实例
    defaultMQPushConsumerImpl = new DefaultMQPushConsumerImpl(this, rpcHook);
}
```

这个构造器是指定了命名空间、生产者组、RPC钩子和消费者之间消息分配的策略算法的构造器，其内部创建了一个DefaultMQPushConsumerImpl实例，DefaultMQPushConsumer可以看作是DefaultMQPushConsumerImpl的包装类，开放给开发人员使用，DefaultMQPushConsumer中的几乎所有的方法内部都是由DefaultMQPushConsumerImpl实现的。
**这是门面模式设计模式。**

下面是DefaultMQPushConsumerImpl的构造器，也很简单。

```java
public DefaultMQPushConsumerImpl(DefaultMQPushConsumer defaultMQPushConsumer, RPCHook
 rpcHook) {
   
     
    this.defaultMQPushConsumer = defaultMQPushConsumer;
    this.rpcHook = rpcHook;
    // consumer 状态错误时采用定时任务定时执行拉取请求的时间间隔
    this.pullTimeDelayMillsWhenException = defaultMQPushConsumer.getPullTimeDelayMillsWhenException();
}
```

创建了DefaultMQPushConsumer实例之后，会设置一些属性，包括namesrvAddr、consumeFromWhere、注册messageListener消息监听器等等，这些都见简单的属性赋值操作，除了subscribe方法。

## 2 subscribe订阅

subscribe方法表示Consumer订阅的自己感兴趣的Topic，并且支持对消息进行过滤，，过滤表达式支持TAG和SQL92两种类型，他们都会被解析成SubscriptionData对象，最终将topic与SubscriptionData的关系维护到RebalanceImpl内部的subscriptionInner这个map集合中。

```java
/**
 * DefaultMQPushConsumer的方法
 * <p>
 * 订阅topic，支持消息过滤表达式
 *
 * @param topic         订阅的topic
 * @param subExpression 订阅表达式。它仅支持或操作，如“tag1 | | tag2 | | tag3”，如果为 null 或 *，则表示订阅全部
 */
@Override
public void subscribe(String topic, String subExpression) throws MQClientException {
   
     
    //调用defaultMQPushConsumerImpl的subscribe方法
    this.defaultMQPushConsumerImpl.subscribe(withNamespace(topic), subExpression);
}
```

下面是DefaultMQPushConsumerImpl的方法实现：

```java
/**
 * DefaultMQPushConsumerImpl的方法
 * <p>
 * 订阅topic
 */
public void subscribe(String topic, String subExpression) throws MQClientException {
   
     
    try {
   
     
        //解析订阅表达式，构建SubscriptionData
        SubscriptionData subscriptionData = FilterAPI.buildSubscriptionData(topic, subExpression);
        //将topic与SubscriptionData的关系维护到RebalanceImpl内部的subscriptionInner这个map集合中
        this.rebalanceImpl.getSubscriptionInner().put(topic, subscriptionData);
        if (this.mQClientFactory != null) {
   
     
            //如果mQClientFactory不为null，则发送心跳信息给所有broker。
            this.mQClientFactory.sendHeartbeatToAllBrokerWithLock();
        }
    } catch (Exception e) {
   
     
        throw new MQClientException("subscription exception", e);
    }
}
```

## 3 start启动消费者

DefaultMQPushConsumer的构造器实际上没做什么太多的操作，主要是start方法内部会执行很多初始化操作，因此使用时，我们需要在消费或者查询消息之前调用该方法。

```java
/**
 * DefaultMQPushConsumer的方法
 * <p>
 * 启动消费者
 */
@Override
public void start() throws MQClientException {
   
     
    //根据namespace和consumerGroup设置消费者组
    setConsumerGroup(NamespaceUtil.wrapNamespace(this.getNamespace(), this.consumerGroup));
    //默认消费者实现启动
    this.defaultMQPushConsumerImpl.start();
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

主要是defaultMQPushConsumerImpl#start方法，该方法实现生产者的启动。主要步骤有如下几步：

**1、**
调用checkConfig方法检查消费者的配置信息，如果consumerGroup为空，或者长度大于255个字符，或者包含非法字符（正常的匹配模式为`^[%|a-zA-Z0-9_-]+$`
），或者消费者组名为默认组名DEFAULT_CONSUMER，或者messageModel为空，或者consumeFromWhere为空，或者consumeTimestamp为空，或者allocateMessageQueueStrategy为空……等等属性的空校验，满足以上任意条件都校验不通过抛出异常；
**2、** 调用**copySubscription**
方法，拷贝拷贝订阅关系，然后为集群消费模式的消费者，配置其对应的重试主题retryTopic=%RETRY%+consumerGroup并且设置当前消费者自动订阅该消费者组对应的重试topic，用于实现消费重试；
**3、**
调用getOrCreateMQClientInstance方法，然后根据clientId获取或者创建CreateMQClientInstance实例，并赋给mQClientFactory变量该方法我们在生产者启动源码部分已经讲过了；
**4、** 设置负载均衡服务**rebalanceImpl**的相关属性；
**5、** 创建消息拉取核心对象**PullAPIWrapper**，封装了消息拉取及结果解析逻辑的API；
**6、** 根据消息模式设置不同的**OffsetStore**
，用于实现消费者的消息消费偏移量offset的管理如果是广播消费模式，则是LocalFileOffsetStore，消息消费进度即offset存储在本地磁盘中如果是集群消费模式，则是RemoteBrokerOffsetStore，消息消费进度即offset存储在远程broker中；
**7、** 调用**offsetStore.load**加载消费偏移量，LocalFileOffsetStore会加载本地磁盘中的数据，RemoteBrokerOffsetStore则是一个空实现；
**8、** 根据消息监听器**MessageListener**
的类型创建不同的消息消费服务ConsumeMessageService如果是MessageListenerOrderly类型，则表示顺序消费，创建ConsumeMessageOrderlyService如果是MessageListenerConcurrently类型，则表示并发消费，创建ConsumeMessageOrderlyService；
**9、** 调用**consumeMessageService.start**
启动消息消费服务消息拉取服务PullMessageService拉取到消息后，会构建ConsumeRequest对象交给consumeMessageService去消费；
**10、** 注册消费者组和消费者到**MQClientInstance**中的**consumerTable**中，如果没注册成功，那么可能是因为同一个程序中存在同名消费者组的不同消费者，抛出异常；

11. 调用**mQClientFactory#start**
    方法启动CreateMQClientInstance客户端通信实例，初始化netty服务、各种定时任务、拉取消息服务、rebalanceService服务等等。CreateMQClientInstance仅会被初始化一次，其源码我们在生产者启动源码部分已经讲过了。

**12、** 进行后续处理：；

**1、** 调用**updateTopicSubscribeInfoWhenSubscriptionChanged**方法，向NameServer拉取并更新当前消费者订阅的topic路由信息；
**2、** 调用**checkClientInBroker**方法，随机选择一个Broker，发送检查客户端tag配置的请求，主要是检测Broker是否支持SQL92类型的tag过滤以及SQL92的tag语法是否正确；
**3、** 调用**sendHeartbeatToAllBrokerWithLock**
方法，主动发送心跳信息给所有brokerBroker接收到心跳后，会发送Code为NOTIFY_CONSUMER_IDS_CHANGED的请求给Group下其它消费者，要求它们重新进行负载均衡；
**4、** 调用**rebalanceImmediately**方法，唤醒负载均衡服务rebalanceService，主动进行一次MessageQueue的重平衡；

```java
/**
 * DefaultMQPushConsumerImpl的方法
 * <p>
 * 启动默认消费者实现
 */
public synchronized void start() throws MQClientException {
   
     
    //根据服务状态选择走不同的代码分支
    switch (this.serviceState) {
   
     
        /*
         * 服务仅仅创建，而不是启动状态，那么启动服务
         */
        case CREATE_JUST:
            log.info("the consumer [{}] start beginning. messageModel={}, isUnitMode={}", this.defaultMQPushConsumer.getConsumerGroup(),
                    this.defaultMQPushConsumer.getMessageModel(), this.defaultMQPushConsumer.isUnitMode());
            //首先修改服务状态为服务启动失败，如果最终启动成功则再修改为RUNNING
            this.serviceState = ServiceState.START_FAILED;
            /*
             * 1 检查消费者的配置信息
             *
             * 如果consumerGroup为空，或者长度大于255个字符，或者包含非法字符（正常的匹配模式为 ^[%|a-zA-Z0-9_-]+$），或者消费者组名为默认组名DEFAULT_CONSUMER
             * 或者messageModel为空，或者consumeFromWhere为空，或者consumeTimestamp为空，或者allocateMessageQueueStrategy为空……等等属性的空校验
             * 满足以上任意条件都校验不通过抛出异常。
             */
            this.checkConfig();
            /*
             * 2 拷贝拷贝订阅关系
             *
             * 为集群消费模式的消费者，配置其对应的重试主题 retryTopic = %RETRY% + consumerGroup
             * 并且设置当前消费者自动订阅该消费者组对应的重试topic，用于实现消费重试。
             */
            this.copySubscription();
            //如果是集群消费模式，如果instanceName为默认值 "DEFAULT"，那么改成 UtilAll.getPid() + "#" + System.nanoTime()
            if (this.defaultMQPushConsumer.getMessageModel() == MessageModel.CLUSTERING) {
   
     
                this.defaultMQPushConsumer.changeInstanceNameToPID();
            }
            /*
             * 3 获取MQClientManager实例，然后根据clientId获取或者创建CreateMQClientInstance实例，并赋给mQClientFactory变量
             *
             * MQClientInstance封装了RocketMQ底层网络处理API，Producer、Consumer都会使用到这个类，是Producer、Consumer与NameServer、Broker 打交道的网络通道。
             * 因此，同一个clientId对应同一个MQClientInstance实例就可以了，即同一个应用中的多个producer和consumer使用同一个MQClientInstance实例即可。
             */
            this.mQClientFactory = MQClientManager.getInstance().getOrCreateMQClientInstance(this.defaultMQPushConsumer, this.rpcHook);
            /*
             * 4 设置负载均衡服务的相关属性
             */
            this.rebalanceImpl.setConsumerGroup(this.defaultMQPushConsumer.getConsumerGroup());
            this.rebalanceImpl.setMessageModel(this.defaultMQPushConsumer.getMessageModel());
            this.rebalanceImpl.setAllocateMessageQueueStrategy(this.defaultMQPushConsumer.getAllocateMessageQueueStrategy());
            this.rebalanceImpl.setmQClientFactory(this.mQClientFactory);

            /*
             * 5 创建消息拉取核心对象PullAPIWrapper，封装了消息拉取及结果解析逻辑的API
             */
            this.pullAPIWrapper = new PullAPIWrapper(
                    mQClientFactory,
                    this.defaultMQPushConsumer.getConsumerGroup(), isUnitMode());
            //为PullAPIWrapper注册过滤消息的钩子函数
            this.pullAPIWrapper.registerFilterMessageHook(filterMessageHookList);

            /*
             * 6 根据消息模式设置不同的OffsetStore，用于实现消费者的消息消费偏移量offset的管理
             */
            if (this.defaultMQPushConsumer.getOffsetStore() != null) {
   
     
                this.offsetStore = this.defaultMQPushConsumer.getOffsetStore();
            } else {
   
     
                //根据不用的消费模式选择不同的OffsetStore实现
                switch (this.defaultMQPushConsumer.getMessageModel()) {
   
     
                    case BROADCASTING:
                        //如果是广播消费模式，则是LocalFileOffsetStore，消息消费进度即offset存储在本地磁盘中。
                        this.offsetStore = new LocalFileOffsetStore(this.mQClientFactory, this.defaultMQPushConsumer.getConsumerGroup());
                        break;
                    case CLUSTERING:
                        //如果是集群消费模式，则是RemoteBrokerOffsetStore，消息消费进度即offset存储在远程broker中。
                        this.offsetStore = new RemoteBrokerOffsetStore(this.mQClientFactory, this.defaultMQPushConsumer.getConsumerGroup());
                        break;
                    default:
                        break;
                }
                this.defaultMQPushConsumer.setOffsetStore(this.offsetStore);
            }
            /*
             * 7 加载消费偏移量，LocalFileOffsetStore会加载本地磁盘中的数据，RemoteBrokerOffsetStore则是一个空实现。
             */
            this.offsetStore.load();
            /*
             * 8 根据消息监听器的类型创建不同的消息消费服务
             */
            if (this.getMessageListenerInner() instanceof MessageListenerOrderly) {
   
     
                //如果是MessageListenerOrderly类型，则表示顺序消费，创建ConsumeMessageOrderlyService
                this.consumeOrderly = true;
                this.consumeMessageService =
                        new ConsumeMessageOrderlyService(this, (MessageListenerOrderly) this.getMessageListenerInner());
            } else if (this.getMessageListenerInner() instanceof MessageListenerConcurrently) {
   
     
                //如果是MessageListenerConcurrently类型，则表示并发消费，创建ConsumeMessageOrderlyService
                this.consumeOrderly = false;
                this.consumeMessageService =
                        new ConsumeMessageConcurrentlyService(this, (MessageListenerConcurrently) this.getMessageListenerInner());
            }
            //启动消息消费服务
            this.consumeMessageService.start();
            /*
             * 9 注册消费者组和消费者到MQClientInstance中的consumerTable中
             */
            boolean registerOK = mQClientFactory.registerConsumer(this.defaultMQPushConsumer.getConsumerGroup(), this);
            if (!registerOK) {
   
     
                //如果没注册成功，那么可能是因为同一个程序中存在同名消费者组的不同消费者
                this.serviceState = ServiceState.CREATE_JUST;
                this.consumeMessageService.shutdown(defaultMQPushConsumer.getAwaitTerminationMillisWhenShutdown());
                throw new MQClientException("The consumer group[" + this.defaultMQPushConsumer.getConsumerGroup()
                        + "] has been created before, specify another name please." + FAQUrl.suggestTodo(FAQUrl.GROUP_NAME_DUPLICATE_URL),
                        null);
            }
            /*
             * 10 启动CreateMQClientInstance客户端通信实例
             * netty服务、各种定时任务、拉取消息服务、rebalanceService服务
             */
            mQClientFactory.start();
            log.info("the consumer [{}] start OK.", this.defaultMQPushConsumer.getConsumerGroup());
            this.serviceState = ServiceState.RUNNING;
            break;
        /**
         * 服务状态是其他的，那么抛出异常，即start方法仅能调用一次
         */
        case RUNNING:
        case START_FAILED:
        case SHUTDOWN_ALREADY:
            throw new MQClientException("The PushConsumer service state not OK, maybe started once, "
                    + this.serviceState
                    + FAQUrl.suggestTodo(FAQUrl.CLIENT_SERVICE_NOT_OK),
                    null);
        default:
            break;
    }
    /*
     * 11 后续处理
     */
    /*
     * 向NameServer拉取并更新当前消费者订阅的topic路由信息
     */
    this.updateTopicSubscribeInfoWhenSubscriptionChanged();
    /*
     * 随机选择一个Broker，发送检查客户端tag配置的请求，主要是检测Broker是否支持SQL92类型的tag过滤以及SQL92的tag语法是否正确
     */
    this.mQClientFactory.checkClientInBroker();
    /*
     * 发送心跳信息给所有broker
     */
    this.mQClientFactory.sendHeartbeatToAllBrokerWithLock();
    /*
     * 唤醒负载均衡服务rebalanceService，进行重平衡
     */
    this.mQClientFactory.rebalanceImmediately();
}
```

### 3.1 copySubscription拷贝订阅关系

该方法将defaultMQPushConsumer中的订阅关系Map集合subscription中的数据拷贝到RebalanceImpl的subscriptionInner中。

**然后还有很重要的一步，就是为集群消费模式的消费者，配置其对应的重试主题 retryTopic = %RETRY% +
consumerGroup，并且设置当前消费者自动订阅该消费者组对应的重试topic，用于实现消费重试。而如果是广播消费模式，那么不订阅重试topic，所以说，从Consumer启动的时候开始，就注定了广播消费模式的消费者，消费失败消息会丢弃，无法重试。
**

```java
/**
 * DefaultMQPushConsumerImpl的方法
 * <p>
 * 拷贝订阅关系
 *
 * @throws MQClientException
 */
private void copySubscription() throws MQClientException {
   
     
    try {
   
     
        //将订阅关系拷贝到RebalanceImpl的subscriptionInner中
        Map<String, String> sub = this.defaultMQPushConsumer.getSubscription();
        if (sub != null) {
   
     
            for (final Map.Entry<String, String> entry : sub.entrySet()) {
   
     
                final String topic = entry.getKey();
                final String subString = entry.getValue();
                SubscriptionData subscriptionData = FilterAPI.buildSubscriptionData(topic, subString);
                this.rebalanceImpl.getSubscriptionInner().put(topic, subscriptionData);
            }
        }
        //如果messageListenerInner为null，那么将defaultMQPushConsumer的messageListener赋给DefaultMQPushConsumerImpl的messageListenerInner
        //在defaultMQPushConsumer的registerMessageListener方法中就已经赋值了
        if (null == this.messageListenerInner) {
   
     
            this.messageListenerInner = this.defaultMQPushConsumer.getMessageListener();
        }
        //消息消费模式
        switch (this.defaultMQPushConsumer.getMessageModel()) {
   
     
            //广播消费模式，消费失败消息会丢弃
            case BROADCASTING:
                break;
            //集群消费模式，支持消费失败重试
            //自动订阅该消费者组对应的重试topic，默认就是这个模式
            case CLUSTERING:
                //获取当前消费者对应的重试主题 retryTopic = %RETRY% + consumerGroup
                final String retryTopic = MixAll.getRetryTopic(this.defaultMQPushConsumer.getConsumerGroup());
                //当前消费者自动订阅该消费者组对应的重试topic，用于实现消费重试
                SubscriptionData subscriptionData = FilterAPI.buildSubscriptionData(retryTopic, SubscriptionData.SUB_ALL);
                this.rebalanceImpl.getSubscriptionInner().put(retryTopic, subscriptionData);
                break;
            default:
                break;
        }
    } catch (Exception e) {
   
     
        throw new MQClientException("subscription exception", e);
    }
}
```

## 4 小结

本次我们仅仅介绍了Consumer消费者启动的主要流程，后面我们单独分析这些服务的工作原理。其中几个关键服务如下：

**1、** **rebalanceService**
：消费者负载均衡服务，用于确定消费者的消息队列以及负载均衡，同时也是触发pullMessageService拉取消息的入口由MQClientInstance启动，同一个服务器的所有Consumer使用同一个实例；
**2、** **pullMessageService**：消息拉取服务，用于拉取消息由MQClientInstance启动，同一个服务器的所有Consumer使用同一个实例；
**3、** **consumeMessageService**：消息消费服务，消息拉取服务拉取到消息后，交给此服务消费消息由DefaultMQPushConsumerImpl启动，每个Consumer持有一个实例；
**4、** **OffsetStore**：用于管理消费点位的上报持久化由DefaultMQPushConsumerImpl启动，每个Consumer持有一个实例；