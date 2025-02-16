---

layout: 17、RocketMQ源码分析：RebalanceService消费者负载均衡过程源码

title:  17、RocketMQ源码分析：RebalanceService消费者负载均衡过程源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713342

abbrlink: 1739713342

date: 2025-02-16 21:42:06


--- 

# 17、RocketMQ源码分析：RebalanceService消费者负载均衡过程源码

#### 文章目录

- 1 doRebalance执行重平衡
- 2 RebalanceImpl#doRebalance执行重平衡
- 3 rebalanceByTopic根据topic执行重平衡
- 4 findConsumerIdList查找客户端id集合
-
    - 4.1 findBrokerAddrByTopic随机查找broker
- 4.2 getConsumerIdListByGroup获取Group所有ConsumerId集合
-
    - 4.2.1 broker处理getConsumerListByGroup请求
        - 4.2.2 ConsumerManageProcessor#getConsumerListByGroup
- 5 allocate分配消息队列
-
    - 5.1 AllocateMessageQueueAveragely平均分配
- 5.2 AllocateMessageQueueAveragelyByCircle环形平均分配
- 5.3AllocateMessageQueueByConfig根据配置分配
- 5.4 AllocateMessageQueueByMachineRoom机房平均分配
-
- 5.5 AllocateMachineRoomNearby机房就近分配
- 5.6 AllocateMessageQueueConsistentHash一致性哈希分配
- 6 updateProcessQueueTableInRebalance更新处理队列
-
    - 6.1 removeUnnecessaryMessageQueue移除非必要的消息队列
-
    - 6.1.1 unlockDelay延迟解锁
- 6.2 lock获取分布式锁
- 6.3 computePullFromWhereWithException计算offset
-
    - 6.3.1 readOffset获取offset
    -
        - 6.3.1.1 fetchConsumeOffsetFromBroker从broker获取offset
        - 6.3.1.2 queryConsumerOffset查询消费偏移量
- 6.4 dispatchPullRequest分发拉取消息请求PullRequest
- 7 messageQueueChanged更新消息队列
- 8 总结

## 1 doRebalance执行重平衡

*
*负载均衡or重平衡的触发操作，最终都会执行MQClientInstance的doRebalance方法。该方法将会遍历consumerTable，获取每一个消费者MQConsumerInner，即DefaultMQPushConsumerImpl或者其他实例，然后通过消费者本身来执行重平衡操作。
**

```java
/**
* MQClientInstance的方法
* <p>
* 执行重平衡
*/
public void doRebalance() {
   
     
    //遍历consumerTable
    for (Map.Entry<String, MQConsumerInner> entry : this.consumerTable.entrySet()) {
   
     
        //获取一个消费者，即DefaultMQPushConsumerImpl或者其他实例
        MQConsumerInner impl = entry.getValue();

        if (impl != null) {
   
     
            try {
   
     
                //通过消费者本身来执行重平衡操作
                impl.doRebalance();
            } catch (Throwable e) {
   
     
                log.error("doRebalance exception", e);
            }
        }
    }
}
```

*
*MQConsumerInner有三种实现，分别是DefaultLitePullConsumerImpl、DefaultMQPullConsumerImpl、DefaultMQPushConsumerImpl，前两个都用的很少，他们的doRebalance源码也都很简单，即调用各自内部的rebalanceImpl#doRebalance(
false)方法即可。**

```java
@Override
public void doRebalance() {
   
     
    if (this.rebalanceImpl != null) {
   
     
        this.rebalanceImpl.doRebalance(false);
    }
}
```

**我们最常使用的是DefaultMQPushConsumerImpl，它的doRebalance方法也很简单，如果该消费者没有暂停，那么同样调用rebalanceImpl#doRebalance方法即可。
**

```java
/**
 * DefaultMQPushConsumerImpl的方法
 * <p>
 * 执行重平衡
 */
@Override
public void doRebalance() {
   
     
    //如果服务没有暂停，那么调用rebalanceImpl执行重平衡
    if (!this.pause) {
   
     
        //isConsumeOrderly表示是否是顺序消费
        this.rebalanceImpl.doRebalance(this.isConsumeOrderly());
    }
}
```

## 2 RebalanceImpl#doRebalance执行重平衡

该方法将会获取当前消费者的订阅信息集合，然后遍历订阅信息集合，获取订阅的topic，调用rebalanceByTopic方法对该topic进行重平衡。

```java
/**
 * RebalanceImpl的方法
 * <p>
 * 执行重平衡
 *
 * @param isOrder 是否顺序消费
 */
public void doRebalance(final boolean isOrder) {
   
     
    //获取当前消费者的订阅信息集合
    Map<String, SubscriptionData> subTable = this.getSubscriptionInner();
    if (subTable != null) {
   
     
        //遍历订阅信息集合
        for (final Map.Entry<String, SubscriptionData> entry : subTable.entrySet()) {
   
     
            //获取topic
            final String topic = entry.getKey();
            try {
   
     
                /*
                 * 对该topic进行重平衡
                 */
                this.rebalanceByTopic(topic, isOrder);
            } catch (Throwable e) {
   
     
                if (!topic.startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX)) {
   
     
                    log.warn("rebalanceByTopic Exception", e);
                }
            }
        }
    }
    /*
     * 丢弃不属于当前消费者订阅的topic的队列快照ProcessQueue
     */
    this.truncateMessageQueueNotMyTopic();
}
```

## 3 rebalanceByTopic根据topic执行重平衡

**该方法根据topic进行重平衡，将会根据不同的消息模式执行不同的处理策略。**

**1、** **如果是广播模式，广播模式下并没有负载均衡可言，每个consumer都会消费所有队列中的全部消息，仅仅是更新当前consumer的处理队列processQueueTable的信息
**；
**2、** **如果是集群模式，首先基于负载均衡策略确定分配给当前消费者的MessageQueue，然后更新当前consumer的处理队列processQueueTable的信息
**；

**集群模式的大概步骤为：**

**1、** 首先获取该topic的所有消息队列集合mqSet，随后从topic所在的broker中获取当前consumerGroup的clientId集合，即消费者客户端id集合cidAll一个clientId代表一个消费者；
**2、** 对topic的消息队列和clientId集合分别进行排序排序能够保证，不同的客户端消费者在进行负载均衡时，其mqAll和cidAll中的元素顺序是一致的；
**3、** 获取分配消息队列的策略实现AllocateMessageQueueStrategy，即负载均衡的策略类，执行allocate方法，为当前clientId也就是当前消费者，分配消息队列，这一步就是执行负载均衡或者说重平衡的算法；
**4、**
调用updateProcessQueueTableInRebalance方法，更新新分配的消息队列的处理队列processQueueTable的信息，为新分配的消息队列创建最初的pullRequest并分发给PullMessageService；
**5、** 如果processQueueTable发生了改变，那么调用messageQueueChanged方法设置新的本地订阅关系版本，重设流控参数，立即给所有broker发送心跳，让Broker更新当前订阅关系；

```java
/**
 * RebalanceImpl的方法
 * <p>
 * 根据topic进行重平衡
 */
private void rebalanceByTopic(final String topic, final boolean isOrder) {
   
     
    //根据不同的消息模式执行不同的处理策略
    switch (messageModel) {
   
     
        /*
         * 广播模式的处理
         * 广播模式下并没有负载均衡可言，每个consumer都会消费所有队列中的全部消息，仅仅是更新当前consumer的处理队列processQueueTable的信息
         */
        case BROADCASTING: {
   
     
            //获取topic的消息队列
            Set<MessageQueue> mqSet = this.topicSubscribeInfoTable.get(topic);
            if (mqSet != null) {
   
     
                /*
                 * 直接更新全部消息队列的处理队列processQueueTable的信息，创建最初的pullRequest并分发给PullMessageService
                 */
                boolean changed = this.updateProcessQueueTableInRebalance(topic, mqSet, isOrder);
                //如果processQueueTable发生了改变
                if (changed) {
   
     
                    /*
                     * 设置新的本地订阅关系版本，重设流控参数，立即给所有broker发送心跳，让Broker更新当前订阅关系
                     */
                    this.messageQueueChanged(topic, mqSet, mqSet);
                    log.info("messageQueueChanged {} {} {} {}",
                            consumerGroup,
                            topic,
                            mqSet,
                            mqSet);
                }
            } else {
   
     
                log.warn("doRebalance, {}, but the topic[{}] not exist.", consumerGroup, topic);
            }
            break;
        }
        /*
         * 集群模式的处理
         * 基于负载均衡策略确定跟配给当前消费者的MessageQueue，然后更新当前consumer的处理队列processQueueTable的信息
         */
        case CLUSTERING: {
   
     
            //获取topic的消息队列
            Set<MessageQueue> mqSet = this.topicSubscribeInfoTable.get(topic);
            /*
             * 从topic所在的broker中获取当前consumerGroup的clientId集合，即消费者客户端id集合
             * 一个clientId代表一个消费者
             */
            List<String> cidAll = this.mQClientFactory.findConsumerIdList(topic, consumerGroup);
            if (null == mqSet) {
   
     
                if (!topic.startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX)) {
   
     
                    log.warn("doRebalance, {}, but the topic[{}] not exist.", consumerGroup, topic);
                }
            }

            if (null == cidAll) {
   
     
                log.warn("doRebalance, {} {}, get consumer id list failed", consumerGroup, topic);
            }

            if (mqSet != null && cidAll != null) {
   
     
                //将topic的消息队列存入list集合中
                List<MessageQueue> mqAll = new ArrayList<MessageQueue>();
                mqAll.addAll(mqSet);
                /*
                 * 对topic的消息队列和clientId集合分别进行排序
                 * 排序能够保证，不同的客户端消费者在进行负载均衡时，其mqAll和cidAll中的元素顺序是一致的
                 */
                Collections.sort(mqAll);
                Collections.sort(cidAll);
                //获取分配消息队列的策略实现，即负载均衡的策略类
                AllocateMessageQueueStrategy strategy = this.allocateMessageQueueStrategy;

                List<MessageQueue> allocateResult = null;
                try {
   
     
                    /*
                     * 为当前clientId也就是当前消费者，分配消息队列
                     * 这一步就是执行负载均衡或者说重平衡的算法
                     */
                    allocateResult = strategy.allocate(
                            this.consumerGroup,
                            this.mQClientFactory.getClientId(),
                            mqAll,
                            cidAll);
                } catch (Throwable e) {
   
     
                    log.error("AllocateMessageQueueStrategy.allocate Exception. allocateMessageQueueStrategyName={}", strategy.getName(),
                            e);
                    return;
                }
                //对消息队列去重
                Set<MessageQueue> allocateResultSet = new HashSet<MessageQueue>();
                if (allocateResult != null) {
   
     
                    allocateResultSet.addAll(allocateResult);
                }
                /*
                 * 更新新分配的消息队列的处理队列processQueueTable的信息，创建最初的pullRequest并分发给PullMessageService
                 */
                boolean changed = this.updateProcessQueueTableInRebalance(topic, allocateResultSet, isOrder);
                //如果processQueueTable发生了改变
                if (changed) {
   
     
                    log.info(
                            "rebalanced result changed. allocateMessageQueueStrategyName={}, group={}, topic={}, clientId={}, mqAllSize={}, cidAllSize={}, rebalanceResultSize={}, rebalanceResultSet={}",
                            strategy.getName(), consumerGroup, topic, this.mQClientFactory.getClientId(), mqSet.size(), cidAll.size(),
                            allocateResultSet.size(), allocateResultSet);
                    /*
                     * 设置新的本地订阅关系版本，重设流控参数，立即给所有broker发送心跳，让Broker更新当前订阅关系
                     */
                    this.messageQueueChanged(topic, mqSet, allocateResultSet);
                }
            }
            break;
        }
        default:
            break;
    }
}
```

## 4 findConsumerIdList查找客户端id集合

**该方法从topic所在的broker中获取当前consumerGroup的clientId集合，即消费者客户端id集合，用于后续负载均衡策略。一个cliendId代表着一个消费者。
**

*
*首先通过findBrokerAddrByTopic方法随机选择一个当前topic所属的broker，如果broker地址为null则请求nameserver更新topic路由信息。然后调用getConsumerIdListByGroup方法根据brokerAddr和group
发起请求到broekr，得到消费者客户端id列表。**

**从这里的源码能够看出来，RocketMQ一个消费者组内的消费者订阅的topic都必须一致，否则就会出现订阅的topic被覆盖的情况。**

```java
/**
 * MQClientInstance的方法
 * <p>
 * 从topic所在的broker中获取当前consumerGroup的clientId集合，即消费者客户端id集合
 */
public List<String> findConsumerIdList(final String topic, final String group) {
   
     
    //随机选择一个当前topic所属的broker
    String brokerAddr = this.findBrokerAddrByTopic(topic);
    if (null == brokerAddr) {
   
     
        //如果broker地址为null则请求nameserver更新topic路由信息
        this.updateTopicRouteInfoFromNameServer(topic);
        brokerAddr = this.findBrokerAddrByTopic(topic);
    }

    if (null != brokerAddr) {
   
     
        try {
   
     
            //根据brokerAddr和group 得到消费者客户端id列表
            return this.mQClientAPIImpl.getConsumerIdListByGroup(brokerAddr, group, clientConfig.getMqClientApiTimeout());
        } catch (Exception e) {
   
     
            log.warn("getConsumerIdListByGroup exception, " + brokerAddr + " " + group, e);
        }
    }

    return null;
}
```

### 4.1 findBrokerAddrByTopic随机查找broker

*
*从topicRouteTable中获取topic路由信息，然后随机选择一个broker返回。为社么随机返回就可以呢？因为consumer会向所有broker上报心跳信息，因此这些broker中的客户端id是一致的。并且，RocketMQ默认一个消费者组的所有消费的订阅信息都是一致的，因此随便哪个broker上关于此Group所有ConsumerId集合都是一样的。
**

```java
/**
 * MQClientInstance的方法
 * <p>
 * 随机选取指定topic的一个broker
 */
public String findBrokerAddrByTopic(final String topic) {
   
     
    //获取topic路由信息
    TopicRouteData topicRouteData = this.topicRouteTable.get(topic);
    if (topicRouteData != null) {
   
     
        //获取全部broker地址数据
        List<BrokerData> brokers = topicRouteData.getBrokerDatas();
        if (!brokers.isEmpty()) {
   
     
            //随机选择一个broker返回
            int index = random.nextInt(brokers.size());
            BrokerData bd = brokers.get(index % brokers.size());
            return bd.selectBrokerAddr();
        }
    }

    return null;
}
```

### 4.2 getConsumerIdListByGroup获取Group所有ConsumerId集合

该方法向指定地址的broker发起网络请求，查找指定group的全部消费者客户端id列表并返回。请求Code为**GET_CONSUMER_LIST_BY_GROUP
**。

```java
/**
 * MQClientAPIImpl的方法
 * 根据brokerAddr和group 得到消费者客户端id列表
 */
public List<String> getConsumerIdListByGroup(
        final String addr,
        final String consumerGroup,
        final long timeoutMillis) throws RemotingConnectException, RemotingSendRequestException, RemotingTimeoutException,
        MQBrokerException, InterruptedException {
   
     
    //构建请求头
    GetConsumerListByGroupRequestHeader requestHeader = new GetConsumerListByGroupRequestHeader();
    requestHeader.setConsumerGroup(consumerGroup);
    //构建请求命令对象，Code为GET_CONSUMER_LIST_BY_GROUP
    RemotingCommand request = RemotingCommand.createRequestCommand(RequestCode.GET_CONSUMER_LIST_BY_GROUP, requestHeader);
    //发起同步调用
    RemotingCommand response = this.remotingClient.invokeSync(MixAll.brokerVIPChannel(this.clientConfig.isVipChannelEnabled(), addr),
            request, timeoutMillis);
    assert response != null;
    switch (response.getCode()) {
   
     
        case ResponseCode.SUCCESS: {
   
     
            if (response.getBody() != null) {
   
     
                //响应解码
                GetConsumerListByGroupResponseBody body =
                        GetConsumerListByGroupResponseBody.decode(response.getBody(), GetConsumerListByGroupResponseBody.class);
                //返回客户端id集合
                return body.getConsumerIdList();
            }
        }
        default:
            break;
    }

    throw new MQBrokerException(response.getCode(), response.getRemark(), addr);
}
```

#### 4.2.1 broker处理getConsumerListByGroup请求

**broker通过ConsumerManageProcessor对于处理GET_CONSUMER_LIST_BY_GROUP的请求。**

```java
/**
 * ConsumerManageProcessor的方法
 */
@Override
public RemotingCommand processRequest(ChannelHandlerContext ctx, RemotingCommand request)
    throws RemotingCommandException {
   
     
    switch (request.getCode()) {
   
     
        case RequestCode.GET_CONSUMER_LIST_BY_GROUP:
            //返回指定group的所有客户端id集合
            return this.getConsumerListByGroup(ctx, request);
        case RequestCode.UPDATE_CONSUMER_OFFSET:
            return this.updateConsumerOffset(ctx, request);
        case RequestCode.QUERY_CONSUMER_OFFSET:
            return this.queryConsumerOffset(ctx, request);
        default:
            break;
    }
    return null;
}
```

#### 4.2.2 ConsumerManageProcessor#getConsumerListByGroup

返回指定group的所有客户端id集合。

```java
/**
 * ConsumerManageProcessor的方法
 * <p>
 * 返回指定group的所有客户端id集合
 */
public RemotingCommand getConsumerListByGroup(ChannelHandlerContext ctx, RemotingCommand request)
        throws RemotingCommandException {
   
     
    //创建响应命令对象
    final RemotingCommand response =
            RemotingCommand.createResponseCommand(GetConsumerListByGroupResponseHeader.class);
    //解析请求头
    final GetConsumerListByGroupRequestHeader requestHeader =
            (GetConsumerListByGroupRequestHeader) request
                    .decodeCommandCustomHeader(GetConsumerListByGroupRequestHeader.class);
    //从broker的consumerTable中获取指定group的消费者组信息
    ConsumerGroupInfo consumerGroupInfo =
            this.brokerController.getConsumerManager().getConsumerGroupInfo(
                    requestHeader.getConsumerGroup());

    if (consumerGroupInfo != null) {
   
     
        //获取所有客户端id集合
        List<String> clientIds = consumerGroupInfo.getAllClientId();
        if (!clientIds.isEmpty()) {
   
     
            GetConsumerListByGroupResponseBody body = new GetConsumerListByGroupResponseBody();
            body.setConsumerIdList(clientIds);
            response.setBody(body.encode());
            response.setCode(ResponseCode.SUCCESS);
            response.setRemark(null);
            return response;
        } else {
   
     
            log.warn("getAllClientId failed, {} {}", requestHeader.getConsumerGroup(),
                    RemotingHelper.parseChannelRemoteAddr(ctx.channel()));
        }
    } else {
   
     
        log.warn("getConsumerGroupInfo failed, {} {}", requestHeader.getConsumerGroup(),
                RemotingHelper.parseChannelRemoteAddr(ctx.channel()));
    }

    response.setCode(ResponseCode.SYSTEM_ERROR);
    response.setRemark("no consumer for this group, " + requestHeader.getConsumerGroup());
    return response;
}
```

## 5 allocate分配消息队列

**AllocateMessageQueueStrategy#allocate方法为当前clientId也就是当前消费者，分配消息队列，这一步实际上就是执行负载均衡或者说重平衡的算法。
**

*
*AllocateMessageQueueStrategy是RocketMQ消费者之间消息分配的策略算法接口，RocketMQ已经提供了非常多的算法策略实现类，同时我们自己也可以通过实现AllocateMessageQueueStrategy接口定义自己的负载均衡策略。
**

**注意，在执行负载均衡策略之前，已经对消息队列和消费者进行了排序，因此不同的消费者客户端得到的顺序应该是一致的。**

RocketMQ内置了六个负载均衡策略的实现类，我们来看看这些实现类的原理。

**1、** **AllocateMessageQueueAveragely**：平均分配策略，这是默认策略尽量将消息队列平均分配给所有消费者，多余的队列分配至排在前面的消费者分配的时候，前一个消费者分配完了，才会给下一个消费者分配；
**2、** **AllocateMessageQueueAveragelyByCircle**
：环形平均分配策略尽量将消息队列平均分配给所有消费者，多余的队列分配至排在前面的消费者与平均分配策略差不多，区别就是分配的时候，按照消费者的顺序进行一轮一轮的分配，直到分配完所有消息队列；
**3、** **AllocateMessageQueueByConfig**：根据用户配置的消息队列分配将会直接返回用户配置的消息队列集合；
**4、** **AllocateMessageQueueByMachineRoom**：机房平均分配策略消费者只消费绑定的机房中的broker，并对绑定机房中的MessageQueue进行负载均衡；
**5、** **AllocateMachineRoomNearby**
：机房就近分配策略消费者对绑定机房中的MessageQueue进行负载均衡除此之外，对于某些拥有消息队列但却没有消费者的机房，其消息队列会被所欲消费者分配，具体的分配策略是，另外传入的一个AllocateMessageQueueStrategy的实现；
**6、** **AllocateMessageQueueConsistentHash**：一致性哈希分配策略基于一致性哈希算法分配；

### 5.1 AllocateMessageQueueAveragely平均分配

**计算消息队列数量与消费者数量的商，这个商就是每个消费者都会分到的队列数，然后对于余数，则只有排在前面的消费者能够分配到。**

**在进行分配的时候，只有当前一个消费者分配完了，才会分配下一个消费者。例如有消费者A、B，有5个消息队列1、2、3、4、5，计算得到A会分配3分队列，B会分配2个队列，那么将会先给消费者A分配1、2、3，再给消费者B分配到4、5。
**

```java
/**
 * Average Hashing queue algorithm
 */
public class AllocateMessageQueueAveragely implements AllocateMessageQueueStrategy {
   
     
    private final InternalLogger log = ClientLogger.getLog();

    /**
     * @param consumerGroup 当前consumerGroup
     * @param currentCID    当前currentCID
     * @param mqAll         当前topic的mq，已排序
     * @param cidAll        当前consumerGroup的clientId集合，已排序
     * @return
     */
    @Override
    public List<MessageQueue> allocate(String consumerGroup, String currentCID, List<MessageQueue> mqAll,
                                       List<String> cidAll) {
   
     
        //参数校验
        if (currentCID == null || currentCID.length() < 1) {
   
     
            throw new IllegalArgumentException("currentCID is empty");
        }
        if (mqAll == null || mqAll.isEmpty()) {
   
     
            throw new IllegalArgumentException("mqAll is null or mqAll empty");
        }
        if (cidAll == null || cidAll.isEmpty()) {
   
     
            throw new IllegalArgumentException("cidAll is null or cidAll empty");
        }

        List<MessageQueue> result = new ArrayList<MessageQueue>();
        if (!cidAll.contains(currentCID)) {
   
     
            log.info("[BUG] ConsumerGroup: {} The consumerId: {} not in cidAll: {}",
                    consumerGroup,
                    currentCID,
                    cidAll);
            return result;
        }
        //当前currentCID在集合中的索引位置
        int index = cidAll.indexOf(currentCID);
        //计算平均分配后的余数，大于0表示不能被整除，必然有些消费者会多分配一个队列，有些消费者少分配一个队列
        int mod = mqAll.size() % cidAll.size();
        //计算当前消费者分配的队列数量
        //1、如果队列数量小于等于消费者数量，那么每个消费者最多只能分到一个队列，则算作1（后续还会计算），否则，表示每个消费者至少分配一个队列，需要继续计算
        //2、如果mod大于0并且当前消费者索引小于mod，那么当前消费者分到的队列数为平均分配的队列数+1，否则，分到的队列数为平均分配的队列数，即索引在余数范围内的，多分配一个队列
        int averageSize =
                mqAll.size() <= cidAll.size() ? 1 : (mod > 0 && index < mod ? mqAll.size() / cidAll.size()
                        + 1 : mqAll.size() / cidAll.size());
        //如果mod大于0并且当前消费者索引小于mod，那么起始索引为index * averageSize，否则起始索引为index * averageSize + mod
        int startIndex = (mod > 0 && index < mod) ? index * averageSize : index * averageSize + mod;
        //最终分配的消息队列数量。取最小值是因为有些队列将会分配至较少的队列甚至无法分配到队列
        int range = Math.min(averageSize, mqAll.size() - startIndex);
        //分配队列，按照顺序分配
        for (int i = 0; i < range; i++) {
   
     
            result.add(mqAll.get((startIndex + i) % mqAll.size()));
        }
        return result;
    }

    @Override
    public String getName() {
   
     
        return "AVG";
    }
}
```

### 5.2 AllocateMessageQueueAveragelyByCircle环形平均分配

**按照消费者的顺序进行一轮一轮的分配，直到分配完所有消息队列。例如有消费者A、B，有5个消息队列1、2、3、4、5。第一轮A分配1，B分配2；第二轮A分配3，B分配4；第二轮A分配5。因此A分配到1、3、5，B分配到2、4。
**

```java
/**
 * Cycle average Hashing queue algorithm
 */
public class AllocateMessageQueueAveragelyByCircle implements AllocateMessageQueueStrategy {
   
     
    private final InternalLogger log = ClientLogger.getLog();

    @Override
    public List<MessageQueue> allocate(String consumerGroup, String currentCID, List<MessageQueue> mqAll,
        List<String> cidAll) {
   
     
        //参数校验
        if (currentCID == null || currentCID.length() < 1) {
   
     
            throw new IllegalArgumentException("currentCID is empty");
        }
        if (mqAll == null || mqAll.isEmpty()) {
   
     
            throw new IllegalArgumentException("mqAll is null or mqAll empty");
        }
        if (cidAll == null || cidAll.isEmpty()) {
   
     
            throw new IllegalArgumentException("cidAll is null or cidAll empty");
        }

        List<MessageQueue> result = new ArrayList<MessageQueue>();
        if (!cidAll.contains(currentCID)) {
   
     
            log.info("[BUG] ConsumerGroup: {} The consumerId: {} not in cidAll: {}",
                consumerGroup,
                currentCID,
                cidAll);
            return result;
        }
        //索引
        int index = cidAll.indexOf(currentCID);
        //获取每个分配轮次轮次中属于该消费者的对应的消息队列
        for (int i = index; i < mqAll.size(); i++) {
   
     
            if (i % cidAll.size() == index) {
   
     
                result.add(mqAll.get(i));
            }
        }
        return result;
    }

    @Override
    public String getName() {
   
     
        return "AVG_BY_CIRCLE";
    }
}
```

### 5.3AllocateMessageQueueByConfig根据配置分配

**很简单，如果要想使用该策略，那么应该调用setMessageQueueList方法传入自定义的需要消费的消息队列集合，而allocate方法将直接返回该集合。
**

```java
public class AllocateMessageQueueByConfig implements AllocateMessageQueueStrategy {
   
     
    private List<MessageQueue> messageQueueList;

    @Override
    public List<MessageQueue> allocate(String consumerGroup, String currentCID, List<MessageQueue> mqAll,
                                       List<String> cidAll) {
   
     
        //直接返回该集合
        return this.messageQueueList;
    }

    @Override
    public String getName() {
   
     
        return "CONFIG";
    }

    public List<MessageQueue> getMessageQueueList() {
   
     
        return messageQueueList;
    }

    /**
     * 设置自定义的消息队列集合
     */
    public void setMessageQueueList(List<MessageQueue> messageQueueList) {
   
     
        this.messageQueueList = messageQueueList;
    }
}
```

### 5.4 AllocateMessageQueueByMachineRoom机房平均分配

**消费者只消费绑定的机房中的broker，并对绑定机房中的MessageQueue进行负载均衡。这种策略要求brokerName的命名必须要按“机房名@brokerName”的格式来设置。
**

**消费者在分配队列的时候，首先会按照机房名称过滤出所有的 MessageQueue，然后再按照平均分配策略进行分配。**

```java
/**
 * Computer room Hashing queue algorithm, such as Alipay logic room
 */
public class AllocateMessageQueueByMachineRoom implements AllocateMessageQueueStrategy {
   
     
    //指定消费的机房名集合
    private Set<String> consumeridcs;

    @Override
    public List<MessageQueue> allocate(String consumerGroup, String currentCID, List<MessageQueue> mqAll,
        List<String> cidAll) {
   
     
        //参数校验
        if (StringUtils.isBlank(currentCID)) {
   
     
            throw new IllegalArgumentException("currentCID is empty");
        }
        if (CollectionUtils.isEmpty(mqAll)) {
   
     
            throw new IllegalArgumentException("mqAll is null or mqAll empty");
        }
        if (CollectionUtils.isEmpty(cidAll)) {
   
     
            throw new IllegalArgumentException("cidAll is null or cidAll empty");
        }
        //索引
        List<MessageQueue> result = new ArrayList<MessageQueue>();
        int currentIndex = cidAll.indexOf(currentCID);
        if (currentIndex < 0) {
   
     
            return result;
        }
        List<MessageQueue> premqAll = new ArrayList<MessageQueue>();
        for (MessageQueue mq : mqAll) {
   
     
            String[] temp = mq.getBrokerName().split("@");
            //如果brokerName符合“机房名@brokerName”的格式要求，并且当前消费者的consumeridcs包含该机房，则加入集合
            if (temp.length == 2 && consumeridcs.contains(temp[0])) {
   
     
                premqAll.add(mq);
            }
        }
        //平均分配的队列
        int mod = premqAll.size() / cidAll.size();
        //取模剩余的队列
        int rem = premqAll.size() % cidAll.size();
        //分配队列
        int startIndex = mod * currentIndex;
        int endIndex = startIndex + mod;
        for (int i = startIndex; i < endIndex; i++) {
   
     
            result.add(premqAll.get(i));
        }
        //多加一个队列
        if (rem > currentIndex) {
   
     
            result.add(premqAll.get(currentIndex + mod * cidAll.size()));
        }
        return result;
    }

    @Override
    public String getName() {
   
     
        return "MACHINE_ROOM";
    }

    public Set<String> getConsumeridcs() {
   
     
        return consumeridcs;
    }

    public void setConsumeridcs(Set<String> consumeridcs) {
   
     
        this.consumeridcs = consumeridcs;
    }
}
```

###  

### 5.5 AllocateMachineRoomNearby机房就近分配

使用该策略需要传递两个参数：

**1、** allocateMessageQueueStrategy：用于真正分配消息队列的策略对象；
**2、** machineRoomResolver：机房解析器，从clientID和brokerName中解析出机房名称；

该策略的大概逻辑为：

**1、** 将消息队列根据机房分组，将消费者根据机房分组；
**2、** 分配部署在与当前消费者相同的机房中的mq，即如果消息队列与消费者属于同一机房，则对他们进行分配具体的分配策略通过传入的allocateMessageQueueStrategy实现；
**3、** 如果某个拥有消息队列的机房没有对应的消费者，那么它的消息队列由当前所有的消费者分配具体的分配策略通过传入的allocateMessageQueueStrategy实现；

```java
/**
 * * 基于机房近端优先级的代理分配策略。可以指定实际的分配策略。
 * * 如果任何消费者在机房中活动，则部署在同一台机器中的代理的消息队列应仅分配给这些消费者。
 * * 否则，这些消息队列可以与所有消费者共享，因为没有活跃的消费者来消费它们。
 */
public class AllocateMachineRoomNearby implements AllocateMessageQueueStrategy {
   
     
    private final InternalLogger log = ClientLogger.getLog();
    /**
     * 用于真正分配消息队列的策略对象
     */
    private final AllocateMessageQueueStrategy allocateMessageQueueStrategy;//actual allocate strategy
    /**
     * 机房解析器，从clientID和brokerName中解析出机房名称
     */
    private final MachineRoomResolver machineRoomResolver;

    public AllocateMachineRoomNearby(AllocateMessageQueueStrategy allocateMessageQueueStrategy,
                                     MachineRoomResolver machineRoomResolver) throws NullPointerException {
   
     
        if (allocateMessageQueueStrategy == null) {
   
     
            throw new NullPointerException("allocateMessageQueueStrategy is null");
        }

        if (machineRoomResolver == null) {
   
     
            throw new NullPointerException("machineRoomResolver is null");
        }

        this.allocateMessageQueueStrategy = allocateMessageQueueStrategy;
        this.machineRoomResolver = machineRoomResolver;
    }

    @Override
    public List<MessageQueue> allocate(String consumerGroup, String currentCID, List<MessageQueue> mqAll,
                                       List<String> cidAll) {
   
     
        //参数校验
        if (currentCID == null || currentCID.length() < 1) {
   
     
            throw new IllegalArgumentException("currentCID is empty");
        }
        if (mqAll == null || mqAll.isEmpty()) {
   
     
            throw new IllegalArgumentException("mqAll is null or mqAll empty");
        }
        if (cidAll == null || cidAll.isEmpty()) {
   
     
            throw new IllegalArgumentException("cidAll is null or cidAll empty");
        }

        List<MessageQueue> result = new ArrayList<MessageQueue>();
        if (!cidAll.contains(currentCID)) {
   
     
            log.info("[BUG] ConsumerGroup: {} The consumerId: {} not in cidAll: {}",
                    consumerGroup,
                    currentCID,
                    cidAll);
            return result;
        }

        //group mq by machine room
        //将消息队列根据机房分组
        Map<String/*machine room */, List<MessageQueue>> mr2Mq = new TreeMap<String, List<MessageQueue>>();
        for (MessageQueue mq : mqAll) {
   
     
            //获取broker所属机房
            String brokerMachineRoom = machineRoomResolver.brokerDeployIn(mq);
            if (StringUtils.isNoneEmpty(brokerMachineRoom)) {
   
     
                if (mr2Mq.get(brokerMachineRoom) == null) {
   
     
                    //存入map
                    mr2Mq.put(brokerMachineRoom, new ArrayList<MessageQueue>());
                }
                //添加消息队列
                mr2Mq.get(brokerMachineRoom).add(mq);
            } else {
   
     
                throw new IllegalArgumentException("Machine room is null for mq " + mq);
            }
        }

        //group consumer by machine room
        //将消费者根据机房分组
        Map<String/*machine room */, List<String/*clientId*/>> mr2c = new TreeMap<String, List<String>>();
        for (String cid : cidAll) {
   
     
            //获取消费者所属的机房
            String consumerMachineRoom = machineRoomResolver.consumerDeployIn(cid);
            if (StringUtils.isNoneEmpty(consumerMachineRoom)) {
   
     
                if (mr2c.get(consumerMachineRoom) == null) {
   
     
                    //存入map
                    mr2c.put(consumerMachineRoom, new ArrayList<String>());
                }
                //添加消费者
                mr2c.get(consumerMachineRoom).add(cid);
            } else {
   
     
                throw new IllegalArgumentException("Machine room is null for consumer id " + cid);
            }
        }

        List<MessageQueue> allocateResults = new ArrayList<MessageQueue>();

        //1.allocate the mq that deploy in the same machine room with the current consumer
        /*
         * 分配部署在与当前消费者相同的机房中的mq
         */
        //获取当前消费者的机房
        String currentMachineRoom = machineRoomResolver.consumerDeployIn(currentCID);
        //移除并获取当前消费者的机房的队列集合
        List<MessageQueue> mqInThisMachineRoom = mr2Mq.remove(currentMachineRoom);
        //获取当前消费者的机房的消费者集合
        List<String> consumerInThisMachineRoom = mr2c.get(currentMachineRoom);
        if (mqInThisMachineRoom != null && !mqInThisMachineRoom.isEmpty()) {
   
     
            /*
             * 调用传入的分配策略，对mqInThisMachineRoom和consumerInThisMachineRoom进行分配
             */
            allocateResults.addAll(allocateMessageQueueStrategy.allocate(consumerGroup, currentCID, mqInThisMachineRoom, consumerInThisMachineRoom));
        }

        //2.allocate the rest mq to each machine room if there are no consumer alive in that machine room
        /*
         * 如果机房中没有的消费者，则将剩余的mq分配给每个机房
         */
        for (Entry<String, List<MessageQueue>> machineRoomEntry : mr2Mq.entrySet()) {
   
     
            //如果某个拥有消息队列的机房没有对应的消费者，那么它的消息队列由当前所有的消费者分配
            if (!mr2c.containsKey(machineRoomEntry.getKey())) {
   
      // no alive consumer in the corresponding machine room, so all consumers share these queues
                allocateResults.addAll(allocateMessageQueueStrategy.allocate(consumerGroup, currentCID, machineRoomEntry.getValue(), cidAll));
            }
        }

        return allocateResults;
    }

    @Override
    public String getName() {
   
     
        return "MACHINE_ROOM_NEARBY" + "-" + allocateMessageQueueStrategy.getName();
    }

    /**
     * A resolver object to determine which machine room do the message queues or clients are deployed in.
     * <p>
     * AllocateMachineRoomNearby will use the results to group the message queues and clients by machine room.
     * <p>
     * The result returned from the implemented method CANNOT be null.
     */
    public interface MachineRoomResolver {
   
     
        String brokerDeployIn(MessageQueue messageQueue);

        String consumerDeployIn(String clientID);
    }
}
```

### 5.6 AllocateMessageQueueConsistentHash一致性哈希分配

**使用该策略可以传递两个参数：**

**1、** **virtualNodeCnt**：物理节点的虚拟节点的数量，不可小于0，默认10；
**2、** **customHashFunction**：自定义的哈希函数，默认为MD5Hash；

**大概步骤为：**

**1、** **实例化ConsistentHashRouter对象，用于产生虚拟节点以及构建哈希环，如果没有指定哈希函数，则采用MD5Hash作为哈希函数**；
**2、** **遍历消息队列集合，对messageQueue进行hash计算，按顺时针找到最近的consumer节点如果是当前consumer，则加入结果集**；

**总体上还是比较简单的，但是ConsistentHashRouter的源码还是值得一看的，因为其基于Java实现了一个一致性哈希算法。例如，这里的“哈西环”，实际上是采用TreeMap来实现的。
**

```java
/**
 * Consistent Hashing queue algorithm
 */
public class AllocateMessageQueueConsistentHash implements AllocateMessageQueueStrategy {
   
     
    private final InternalLogger log = ClientLogger.getLog();
    /**
     * 物理节点的虚拟节点的数量，不可小于0
     */
    private final int virtualNodeCnt;
    /**
     * 哈希函数，默认可以为null
     */
    private final HashFunction customHashFunction;

    public AllocateMessageQueueConsistentHash() {
   
     
        this(10);
    }

    public AllocateMessageQueueConsistentHash(int virtualNodeCnt) {
   
     
        this(virtualNodeCnt, null);
    }

    public AllocateMessageQueueConsistentHash(int virtualNodeCnt, HashFunction customHashFunction) {
   
     
        if (virtualNodeCnt < 0) {
   
     
            throw new IllegalArgumentException("illegal virtualNodeCnt :" + virtualNodeCnt);
        }
        this.virtualNodeCnt = virtualNodeCnt;
        this.customHashFunction = customHashFunction;
    }

    @Override
    public List<MessageQueue> allocate(String consumerGroup, String currentCID, List<MessageQueue> mqAll,
                                       List<String> cidAll) {
   
     
        //参数校验
        if (currentCID == null || currentCID.length() < 1) {
   
     
            throw new IllegalArgumentException("currentCID is empty");
        }
        if (mqAll == null || mqAll.isEmpty()) {
   
     
            throw new IllegalArgumentException("mqAll is null or mqAll empty");
        }
        if (cidAll == null || cidAll.isEmpty()) {
   
     
            throw new IllegalArgumentException("cidAll is null or cidAll empty");
        }

        List<MessageQueue> result = new ArrayList<MessageQueue>();
        if (!cidAll.contains(currentCID)) {
   
     
            log.info("[BUG] ConsumerGroup: {} The consumerId: {} not in cidAll: {}",
                    consumerGroup,
                    currentCID,
                    cidAll);
            return result;
        }
        //包装为ClientNode对象
        Collection<ClientNode> cidNodes = new ArrayList<ClientNode>();
        for (String cid : cidAll) {
   
     
            cidNodes.add(new ClientNode(cid));
        }
        //实例化ConsistentHashRouter对象，用于产生虚拟节点以及构建哈希环
        //如果没有指定哈希函数，则采用MD5Hash作为哈希函数
        //
        final ConsistentHashRouter<ClientNode> router; //for building hash ring
        if (customHashFunction != null) {
   
     
            router = new ConsistentHashRouter<ClientNode>(cidNodes, virtualNodeCnt, customHashFunction);
        } else {
   
     
            router = new ConsistentHashRouter<ClientNode>(cidNodes, virtualNodeCnt);
        }

        List<MessageQueue> results = new ArrayList<MessageQueue>();
        /*
         * 遍历消息队列集合
         */
        for (MessageQueue mq : mqAll) {
   
     
            //对messageQueue进行hash计算，按顺时针找到最近的consumer节点
            ClientNode clientNode = router.routeNode(mq.toString());
            //如果是当前consumer，则加入结果集
            if (clientNode != null && currentCID.equals(clientNode.getKey())) {
   
     
                results.add(mq);
            }
        }

        return results;

    }

    @Override
    public String getName() {
   
     
        return "CONSISTENT_HASH";
    }

    private static class ClientNode implements Node {
   
     
        private final String clientID;

        public ClientNode(String clientID) {
   
     
            this.clientID = clientID;
        }

        @Override
        public String getKey() {
   
     
            return clientID;
        }
    }

}
```

## 6 updateProcessQueueTableInRebalance更新处理队列

*
*在通过AllocateMessageQueueStrategy#allocate的负载均衡算法为当前消费者分配了新的消息队列之后，需要调用updateProcessQueueTableInRebalance方法，更新新分配的消息队列的处理队列processQueueTable的信息，创建最初的pullRequest并分发给PullMessageService。
**

**该方法非常的重要，大概步骤为：**

**1、** 遍历当前消费者已分配的所有处理队列processQueueTable，当消费者启动并且第一次执行该方法时，processQueueTable是一个空集合如果当前遍历到的消息队列和当前topic相等：；

**1、** **如果新分配的消息队列集合不包含当前遍历到的消息队列，说明这个队列被移除了**；

```
1.  设置对应的处理队列dropped = true，该队列中的消息将不会被消费。
2.  调用removeUnnecessaryMessageQueue删除不必要的消息队列。删除成功后，processQueueTable移除该条目，changed置为true。
```

**2、** **如果当前遍历到的处理队列最后一次拉取消息的时间距离现在超过120s，那么算作消费超时，可能是没有新消息或者网络通信失败
**；

```
1.  如果是push消费模式，设置对应的处理队列dropped = true，该队列中的消息将不会被消费。调用**removeUnnecessaryMessageQueue**删除不必要的消息队列。删除成功后，processQueueTable移除该条目，changed置为true。
```

**2、** 创建一个pullRequestList集合，用于存放新增的PullRequest*
*遍历新分配的消息队列集合，如果当前消费者的处理队列集合processQueueTable中不包含该消息队列，那么表示这个消息队列是新分配的，需要进行一系列处理：
**；

**1、** 如果是顺序消费，并且调用lock方法请求broker锁定该队列失败，即获取该队列的分布式锁失败表示新增消息队列失败，这个队列可能还再被其他消费者消费，那么本次重平衡就不再消费该队列，进入下次循环；
**2、** 如果不是顺序消费或者顺序消费加锁成功，调用removeDirtyOffset方法从offsetTable中移除该消息队列的消费点位offset记录信息；
**3、** 为该消息队列创建一个处理队列**ProcessQueue**；
**4、** 调用**computePullFromWhereWithException**
方法，获取该MessageQueue的下一个消息的消费偏移量nextOffset，pull模式返回0，push模式则根据consumeFromWhere计算得到；
**5、** 如果nextOffset大于0，表示获取消费位点成功保存当前消息队列MessageQueue和处理队列ProcessQueue关系到processQueueTable；
**6、** 新建一个**PullRequest**，设置对应的offset、consumerGroup、mq、pq的信息，并且存入pullRequestList集合中*
*这里就是最初产生拉取消息请求的地方**changed置为true；
**3、** 调用dispatchPullRequest方法，分发本次创建的PullRequest请求；

**1、** **pull模式需要手动拉取消息，这些请求会作废，因此该方法是一个空实现**；
**2、** *
*push模式下自动拉取消息，而这里的PullRequest就是对应的消息队列的第一个拉取请求，因此这些请求会被PullMessageService依次处理，后续实现自动拉取消息这里就是push模式下最初的产生拉取消息请求的地方
**；

```java
/**
 * RebalanceImpl的方法
 * <p>
 * 更新新分配的消息队列的处理队列processQueueTable的信息
 *
 * @param topic   订阅的主题
 * @param mqSet   新分配的消息队列集合
 * @param isOrder 是否顺序消费
 * @return 是否有变更
 */
private boolean updateProcessQueueTableInRebalance(final String topic, final Set<MessageQueue> mqSet,
                                                   final boolean isOrder) {
   
     
    boolean changed = false;
    /*
     * 遍历当前消费者的所有处理队列，当消费者启动并且第一次执行该方法时，processQueueTable是一个空集合
     */
    Iterator<Entry<MessageQueue, ProcessQueue>> it = this.processQueueTable.entrySet().iterator();
    while (it.hasNext()) {
   
     
        Entry<MessageQueue, ProcessQueue> next = it.next();
        //key为消息队列
        MessageQueue mq = next.getKey();
        //value为对应的处理队列
        ProcessQueue pq = next.getValue();
        //如果topic相等
        if (mq.getTopic().equals(topic)) {
   
     
            //如果新分配的消息队列集合不包含当前遍历到的消息队列，说明这个队列被移除了
            if (!mqSet.contains(mq)) {
   
     
                //设置对应的处理队列dropped = true，该队列中的消息将不会被消费
                pq.setDropped(true);
                /*
                 * 删除不必要的消息队列
                 */
                if (this.removeUnnecessaryMessageQueue(mq, pq)) {
   
     
                    //删除成功后，移除该条目，changed置为true
                    it.remove();
                    changed = true;
                    log.info("doRebalance, {}, remove unnecessary mq, {}", consumerGroup, mq);
                }
                //如果处理队列最后一次拉取消息的时间距离现在超过120s，那么算作消费超时，可能是没有新消息或者网络通信失败
            } else if (pq.isPullExpired()) {
   
     
                switch (this.consumeType()) {
   
     
                    case CONSUME_ACTIVELY:
                        break;
                    //如果是push消费模式
                    case CONSUME_PASSIVELY:
                        //设置对应的处理队列dropped = true，该队列中的消息将不会被消费
                        pq.setDropped(true);
                        /*
                         * 删除不必要的消息队列
                         */
                        if (this.removeUnnecessaryMessageQueue(mq, pq)) {
   
     
                            //删除成功后，移除该条目，changed置为true
                            it.remove();
                            changed = true;
                            log.error("[BUG]doRebalance, {}, remove unnecessary mq, {}, because pull is pause, so try to fixed it",
                                    consumerGroup, mq);
                        }
                        break;
                    default:
                        break;
                }
            }
        }
    }

    List<PullRequest> pullRequestList = new ArrayList<PullRequest>();
    /*
     * 遍历新分配的消息队列集合
     */
    for (MessageQueue mq : mqSet) {
   
     
        //如果当前消费者的处理队列集合中不包含该消息队列，那么表示这个消息队列是新分配的
        if (!this.processQueueTable.containsKey(mq)) {
   
     
            //如果是顺序消费，并且请求broker锁定该队列失败，即获取该队列的分布式锁失败
            //表示新增消息队列失败，这个队列可能还再被其他消费者消费，那么本次重平衡就不再消费该队列
            if (isOrder && !this.lock(mq)) {
   
     
                log.warn("doRebalance, {}, add a new mq failed, {}, because lock failed", consumerGroup, mq);
                continue;
            }
            //从offsetTable中移除该消息队列的消费点位offset记录信息
            this.removeDirtyOffset(mq);
            /*
             * 为该消息队列创建一个处理队列
             */
            ProcessQueue pq = new ProcessQueue();

            long nextOffset = -1L;
            try {
   
     
                /*
                 * 获取该MessageQueue的下一个消息的消费偏移量offset
                 * pull模式返回0，push模式则根据consumeFromWhere计算得到
                 */
                nextOffset = this.computePullFromWhereWithException(mq);
            } catch (Exception e) {
   
     
                log.info("doRebalance, {}, compute offset failed, {}", consumerGroup, mq);
                continue;
            }
            // 如果nextOffset大于0，表示获取消费位点成功
            if (nextOffset >= 0) {
   
     
                //保存当前消息队列MessageQueue和处理队列ProcessQueue关系
                ProcessQueue pre = this.processQueueTable.putIfAbsent(mq, pq);
                if (pre != null) {
   
     
                    log.info("doRebalance, {}, mq already exists, {}", consumerGroup, mq);
                } else {
   
     
                    log.info("doRebalance, {}, add a new mq, {}", consumerGroup, mq);
                    /*
                     * 新建一个PullRequest，设置对应的offset、consumerGroup、mq、pq的信息，并且存入pullRequestList集合中
                     * 这里就是最初产生拉取消息请求的地方
                     */
                    PullRequest pullRequest = new PullRequest();
                    pullRequest.setConsumerGroup(consumerGroup);
                    pullRequest.setNextOffset(nextOffset);
                    pullRequest.setMessageQueue(mq);
                    pullRequest.setProcessQueue(pq);
                    pullRequestList.add(pullRequest);
                    //changed置为true
                    changed = true;
                }
            } else {
   
     
                log.warn("doRebalance, {}, add new mq failed, {}", consumerGroup, mq);
            }
        }
    }
    /*
     * 分发本次创建的PullRequest请求。
     * pull模式需要手动拉取消息，这些请求会作废，因此该方法是一个空实现
     * push模式下自动拉取消息，而这里的PullRequest就是对应的消息队列的第一个拉取请求，因此这些请求会被PullMessageService依次处理，后续实现自动拉取消息
     */
    this.dispatchPullRequest(pullRequestList);

    return changed;
}
```

### 6.1 removeUnnecessaryMessageQueue移除非必要的消息队列

**该方法用于尝试移除不必要的消息队列，可能会移除失败。大概步骤为：**

1. 调用OffsetStore#persist方法，保存指定消息队列的偏移量，可能在本地存储或远程服务器，集群模式保存在远程broker服务器上。
2. 调用OffsetStore#removeOffset方法，移除OffsetStore内部的offsetTable中的对应消息队列的k-v数据。
   **3、** Push模式下，如果当前消费者是有序消费，且是集群消费，那么尝试从Broker端将该消息队列的分布式锁解锁如果是并发消费或者是广播消费，则不进入试解锁的逻辑：；
    1.
    通过consumeLock#tryLock方法尝试获取处理队列的消费锁，最多等待1s。这是一个本地互斥锁，保证在获取到锁以及发起解锁的过程中，没有线程能消费该队列的消息，因为MessageListenerOrderly在消费消息时也需要获取该锁。
    **2、** 获得锁之后，调用unlockDelay方法延迟的向Broker发送单向请求，Code为UNLOCK_BATCH_MQ，请求Broker释放当前消息队列的分布式锁，
    **最多延迟20s**该方法一定会返回true；
    **3、** 在finally中，处理队列的本地消费锁解锁；
    **4、** **如果没有获得本地锁，那么表示当前消息队列正在消息，不能解锁，那么本次就放弃解锁了，移除消息队列失败，等待下次重新分配消费队列时，再进行移除返回false
    **；

```java
/**
 * RebalancePushImpl的方法
 * <p>
 * 删除不必要的消息队列
 *
 * @param mq 需要删除的消息队列
 * @param pq 需要删除的消息队列的处理队列
 * @return 是否移除成功
 */
@Override
public boolean removeUnnecessaryMessageQueue(MessageQueue mq, ProcessQueue pq) {
   
     
    /*
     * 保存指定消息队列的偏移量，可能在本地存储或远程服务器
     */
    this.defaultMQPushConsumerImpl.getOffsetStore().persist(mq);
    /*
     * 移除OffsetStore内部的offsetTable中的对应消息队列的k-v数据
     */
    this.defaultMQPushConsumerImpl.getOffsetStore().removeOffset(mq);
    /*
     * Push模式下，如果当前消费者是有序消费，且是集群消费，那么尝试从Broker端将该消息队列解锁，如果是并发消费，则不会解锁
     */
    if (this.defaultMQPushConsumerImpl.isConsumeOrderly()
            && MessageModel.CLUSTERING.equals(this.defaultMQPushConsumerImpl.messageModel())) {
   
     
        try {
   
     
            //尝试获取处理队列的消费锁，最多等待1s
            //这是一个本地互斥锁，保证在获取到锁以及发起解锁的过程中，没有线程能消费该队列的消息
            //因为MessageListenerOrderly在消费消息时也需要获取该锁。
            if (pq.getConsumeLock().tryLock(1000, TimeUnit.MILLISECONDS)) {
   
     
                try {
   
     
                    /*
                     * 延迟的向Broker发送单向请求，Code为UNLOCK_BATCH_MQ，表示请求Broker释放当前消息队列的分布式锁
                     */
                    return this.unlockDelay(mq, pq);
                } finally {
   
     
                    //本地解锁
                    pq.getConsumeLock().unlock();
                }
            } else {
   
     
                //加锁失败，表示当前消息队列正在消息，不能解锁
                //那么本次就放弃解锁了，移除消息队列失败，等待下次重新分配消费队列时，再进行移除。
                log.warn("[WRONG]mq is consuming, so can not unlock it, {}. maybe hanged for a while, {}",
                        mq,
                        pq.getTryUnlockTimes());
                //尝试解锁次数+1
                pq.incTryUnlockTimes();
            }
        } catch (Exception e) {
   
     
            log.error("removeUnnecessaryMessageQueue Exception", e);
        }

        return false;
    }
    return true;
}
```

#### 6.1.1 unlockDelay延迟解锁

**向Broker发送单向请求，Code为UNLOCK_BATCH_MQ，表示请求Broker释放当前消息队列的分布式锁。如果消费队列中还有剩余消息，则延迟20s发送解锁请求。
**

**该方法似乎只会返回true，即只管发送不管结果。**

```java
/**
 * RebalancePushImpl的方法
 *
 * 延迟的向Broker发送单向请求，Code为UNLOCK_BATCH_MQ，表示请求Broker释放当前消息队列的分布式锁
 * @param mq 要解锁的消息队列
 * @param pq 要解锁的消息队列的处理队列
 * @return 解锁是否成功
 */
private boolean unlockDelay(final MessageQueue mq, final ProcessQueue pq) {
   
     
    //如果消费队列中还有剩余消息，则延迟20s解锁
    if (pq.hasTempMessage()) {
   
     
        log.info("[{}]unlockDelay, begin {} ", mq.hashCode(), mq);
        //延迟20s发送解锁请求
        this.defaultMQPushConsumerImpl.getmQClientFactory().getScheduledExecutorService().schedule(new Runnable() {
   
     
            @Override
            public void run() {
   
     
                log.info("[{}]unlockDelay, execute at once {}", mq.hashCode(), mq);
                RebalancePushImpl.this.unlock(mq, true);
            }
        }, UNLOCK_DELAY_TIME_MILLS, TimeUnit.MILLISECONDS);
    } else {
   
     
        //立即发送解锁请求
        this.unlock(mq, true);
    }
    return true;
}
```

### 6.2 lock获取分布式锁

**如果判断到某个消息队列是新分配给当前消费者的，并且如果是顺序消费，那么在当前消费者消费该消息队列之前，需要通过lock方法请求broker获取该队列的分布式锁。如果不是顺序消费，则此时不需要获取分布式锁。
**

**如果获取分布式锁失败，那么不会为当前消息队列创建ProcessQueue和PullRequest，因为此时表示该消息队列还不属于当前消费者，不能进行消费，这是RocketMQ保证顺序消费防止重复消费的一个措施。
**

**1、** 该方法首先调用findBrokerAddressInSubscribe获取指定brokerName的master地址；
**2、** 然后将当前消费者组、当前客户端id、当前需要被锁定的消息队列等信息封装为一个LockBatchRequestBody，最后向broker发送同步请求，Code为LOCK_BATCH_MQ；
**3、** Broker返回一个set的MessageQueue集合，表示已经锁住的mq集合，然后编辑集合设置mq对应的processQueue属性，设置locked属性为true，设置加锁的时间属性为当前时间戳；
**4、** 最后判断如果当前mq在集合中，那么返回true，表示当前mq锁定成功，否则返回false，表示锁定失败；

```java
/**
 * RebalanceImpl的方法
 * <p>
 * 请求Broker获得指定消息队列的分布式锁
 *
 * @param mq 需要获取分布式锁的消息队列
 * @return 是否获取成功
 */
public boolean lock(final MessageQueue mq) {
   
     
    //获取指定brokerName的master地址
    FindBrokerResult findBrokerResult = this.mQClientFactory.findBrokerAddressInSubscribe(mq.getBrokerName(), MixAll.MASTER_ID, true);
    if (findBrokerResult != null) {
   
     
        //构建获取分布式锁的请求体
        LockBatchRequestBody requestBody = new LockBatchRequestBody();
        //当前消费者组
        requestBody.setConsumerGroup(this.consumerGroup);
        //当前客户端id
        requestBody.setClientId(this.mQClientFactory.getClientId());
        //当前消息队列
        requestBody.getMqSet().add(mq);

        try {
   
     
            //向broker发送同步请求，Code为LOCK_BATCH_MQ，返回锁住的mq集合
            Set<MessageQueue> lockedMq =
                    this.mQClientFactory.getMQClientAPIImpl().lockBatchMQ(findBrokerResult.getBrokerAddr(), requestBody, 1000);
            //遍历锁住的mq集合
            for (MessageQueue mmqq : lockedMq) {
   
     
                //获取对应的processQueue，设置processQueue的状态
                ProcessQueue processQueue = this.processQueueTable.get(mmqq);
                if (processQueue != null) {
   
     
                    //设置locked为true
                    processQueue.setLocked(true);
                    //设置加锁的时间
                    processQueue.setLastLockTimestamp(System.currentTimeMillis());
                }
            }
            //是否加锁成功
            boolean lockOK = lockedMq.contains(mq);
            log.info("the message queue lock {}, {} {}",
                    lockOK ? "OK" : "Failed",
                    this.consumerGroup,
                    mq);
            return lockOK;
        } catch (Exception e) {
   
     
            log.error("lockBatchMQ exception, " + mq, e);
        }
    }

    return false;
}
```

### 6.3 computePullFromWhereWithException计算offset

**对于新分配的mq，需要知道从哪个点位开始消费，computePullFromWhereWithException方法就是用来获取该MessageQueue的下一个消息的消费偏移量offset的。
**

**对于该方法，pull模式固定返回0，因为消费点位需要自己管理，而push模式则根据配置的consumeFromWhere计算得到：**

**1、**
CONSUME_FROM_LAST_OFFSET_AND_FROM_MIN_WHEN_BOOT_FIRST、CONSUME_FROM_MIN_OFFSET、CONSUME_FROM_MAX_OFFSET这三种模式已经废弃，默认使用CONSUME_FROM_LAST_OFFSET的逻辑；
**2、** CONSUME_FROM_LAST_OFFSET：消费者组第一次启动时从最后的位置消费，后续再启动接着上次消费的进度开始消费；
**3、** CONSUME_FROM_FIRST_OFFSET：消费者组第一次启动时从最开始的位置消费，后续再启动接着上次消费的进度开始消费；
**4、** CONSUME_FROM_TIMESTAMP：消费者组第一次启动时消费在指定时间戳后产生的消息，后续再启动接着上次消费的进度开始消费；

```java
/**
 * RebalancePushImpl的方法
 * <p>
 * 计算该MessageQueue的下一个消息的消费偏移量offset
 * pull模式返回0，push模式则根据consumeFromWhere计算得到
 *
 * @param mq 需要获取offset的消息队列
 * @return offset
 */
@Override
public long computePullFromWhereWithException(MessageQueue mq) throws MQClientException {
   
     
    long result = -1;
    //获取消费者的ConsumeFromWhere配置，可以通过调用DefaultMQPushConsumer#setConsumeFromWhere方法设置
    final ConsumeFromWhere consumeFromWhere = this.defaultMQPushConsumerImpl.getDefaultMQPushConsumer().getConsumeFromWhere();
    //获取offset管理服务
    final OffsetStore offsetStore = this.defaultMQPushConsumerImpl.getOffsetStore();
    switch (consumeFromWhere) {
   
     
        //废弃的配置，默认使用CONSUME_FROM_LAST_OFFSET的逻辑
        case CONSUME_FROM_LAST_OFFSET_AND_FROM_MIN_WHEN_BOOT_FIRST:
        case CONSUME_FROM_MIN_OFFSET:
        case CONSUME_FROM_MAX_OFFSET:
            /*
             * 消费者组第一次启动时从最后的位置消费，后续再启动接着上次消费的进度开始消费
             */
        case CONSUME_FROM_LAST_OFFSET: {
   
     
            /*
             * 首先读取上次消费进度，pull模式从本地文件读取，push模式从broker读取
             */
            long lastOffset = offsetStore.readOffset(mq, ReadOffsetType.READ_FROM_STORE);
            if (lastOffset >= 0) {
   
     
                result = lastOffset;
            }
            //看作是第一次启动，从最后的位置开始消费
            else if (-1 == lastOffset) {
   
     
                //如果是重试topic，则返回0
                if (mq.getTopic().startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX)) {
   
     
                    result = 0L;
                } else {
   
     
                    try {
   
     
                        //请求broker，获取mq对应ConsumeQueue的最大偏移量，即最新消息索引点位
                        result = this.mQClientFactory.getMQAdminImpl().maxOffset(mq);
                    } catch (MQClientException e) {
   
     
                        log.warn("Compute consume offset from last offset exception, mq={}, exception={}", mq, e);
                        throw e;
                    }
                }
            } else {
   
     
                result = -1;
            }
            break;
        }
        /*
         * 消费者组第一次启动时从最开始的位置消费，后续再启动接着上次消费的进度开始消费
         */
        case CONSUME_FROM_FIRST_OFFSET: {
   
     
            /*
             * 首先读取上次消费进度，pull模式从本地文件读取，push模式从broker读取
             */
            long lastOffset = offsetStore.readOffset(mq, ReadOffsetType.READ_FROM_STORE);
            if (lastOffset >= 0) {
   
     
                result = lastOffset;
            }
            //看作是第一次启动，从最开始的位置开始消费
            else if (-1 == lastOffset) {
   
     
                result = 0L;
            } else {
   
     
                result = -1;
            }
            break;
        }
        /*
         * 消费者组第一次启动时消费在指定时间戳后产生的消息，后续再启动接着上次消费的进度开始消费
         */
        case CONSUME_FROM_TIMESTAMP: {
   
     
            /*
             * 首先读取上次消费进度，pull模式从本地文件读取，push模式从broker读取
             */
            long lastOffset = offsetStore.readOffset(mq, ReadOffsetType.READ_FROM_STORE);
            if (lastOffset >= 0) {
   
     
                result = lastOffset;
            }
            //看作是第一次启动，从指定时间戳后产生的消息的位置开始消费
            else if (-1 == lastOffset) {
   
     
                //对于重试消息，那么获取mq对应ConsumeQueue的最大偏移量，即最新消息索引点位
                if (mq.getTopic().startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX)) {
   
     
                    try {
   
     
                        result = this.mQClientFactory.getMQAdminImpl().maxOffset(mq);
                    } catch (MQClientException e) {
   
     
                        log.warn("Compute consume offset from last offset exception, mq={}, exception={}", mq, e);
                        throw e;
                    }
                } else {
   
     
                    try {
   
     
                        //解析时间
                        long timestamp = UtilAll.parseDate(this.defaultMQPushConsumerImpl.getDefaultMQPushConsumer().getConsumeTimestamp(),
                                UtilAll.YYYYMMDDHHMMSS).getTime();
                        //查询指定时间戳之后的消息点位
                        result = this.mQClientFactory.getMQAdminImpl().searchOffset(mq, timestamp);
                    } catch (MQClientException e) {
   
     
                        log.warn("Compute consume offset from last offset exception, mq={}, exception={}", mq, e);
                        throw e;
                    }
                }
            } else {
   
     
                result = -1;
            }
            break;
        }

        default:
            break;
    }

    return result;
}
```

#### 6.3.1 readOffset获取offset

**该方法获取当前消费者组的offset，有三种读取类型：**

**1、** **READ_FROM_MEMORY**：仅从本地内存offsetTable读取；
**2、** **READ_FROM_STORE**：仅从broker中读取；
**3、** **MEMORY_FIRST_THEN_STORE**：先从本地内存offsetTable读取，读不到再从远程broker中读取；
当出现异常或者是在本地或者broker没有找到对于消费者组的offset记录，则算作第一次启动该消费者组，那么返回-1。

```java
/**
 * RemoteBrokerOffsetStore的方法
 * <p>
 * 获取offset
 *
 * @param mq   需要获取offset的mq
 * @param type 读取类型
 */
@Override
public long readOffset(final MessageQueue mq, final ReadOffsetType type) {
   
     
    if (mq != null) {
   
     
        switch (type) {
   
     
            /*
             * 先从本地内存offsetTable读取，读不到再从broker中读取
             */
            case MEMORY_FIRST_THEN_STORE:
                /*
                 * 仅从本地内存offsetTable读取
                 */
            case READ_FROM_MEMORY: {
   
     
                AtomicLong offset = this.offsetTable.get(mq);
                if (offset != null) {
   
     
                    //如果本地内存有关于此mq的offset，那么直接返回
                    return offset.get();
                } else if (ReadOffsetType.READ_FROM_MEMORY == type) {
   
     
                    //如果本地内存没有关于此mq的offset，但那读取类型为READ_FROM_MEMORY，那么直接返回-1
                    return -1;
                }
            }
            /*
             * 仅从broker中读取
             */
            case READ_FROM_STORE: {
   
     
                try {
   
     
                    /*
                     * 从broker中获取此消费者组的offset
                     */
                    long brokerOffset = this.fetchConsumeOffsetFromBroker(mq);
                    //更新此mq的offset，并且存入本地offsetTable缓存
                    AtomicLong offset = new AtomicLong(brokerOffset);
                    this.updateOffset(mq, offset.get(), false);
                    return brokerOffset;
                }
                // No offset in broker
                catch (MQBrokerException e) {
   
     
                    //broker中没有关于此消费者组的offset，返回-1
                    return -1;
                }
                //Other exceptions
                catch (Exception e) {
   
     
                    log.warn("fetchConsumeOffsetFromBroker exception, " + mq, e);
                    return -2;
                }
            }
            default:
                break;
        }
    }

    return -1;
}
```

##### 6.3.1.1 fetchConsumeOffsetFromBroker从broker获取offset

**该方法发起远程请求从broekr中获取只当topic的指定队列的指定消费者组的最新offset。请求Code为QUERY_CONSUMER_OFFSET。**

```java
/**
 * RemoteBrokerOffsetStore
 * <p>
 * 从broker中获取此消费者组的offset
 *
 * @param mq 需要获取offset的mq
 */
private long fetchConsumeOffsetFromBroker(MessageQueue mq) throws RemotingException, MQBrokerException,
        InterruptedException, MQClientException {
   
     
    //获取指定brokerName的master地址
    FindBrokerResult findBrokerResult = this.mQClientFactory.findBrokerAddressInSubscribe(mq.getBrokerName(), MixAll.MASTER_ID, true);
    if (null == findBrokerResult) {
   
     
        //从nameServer拉取并更新topic的路由信息
        this.mQClientFactory.updateTopicRouteInfoFromNameServer(mq.getTopic());
        //获取指定brokerName的master地址
        findBrokerResult = this.mQClientFactory.findBrokerAddressInSubscribe(mq.getBrokerName(), MixAll.MASTER_ID, false);
    }

    if (findBrokerResult != null) {
   
     
        //构建请求头，包括topic、groupName、queueId
        QueryConsumerOffsetRequestHeader requestHeader = new QueryConsumerOffsetRequestHeader();
        requestHeader.setTopic(mq.getTopic());
        requestHeader.setConsumerGroup(this.groupName);
        requestHeader.setQueueId(mq.getQueueId());
        //向broker发起同步请求获取指定topic的groupName的指定队列的最新偏移量，Code为QUERY_CONSUMER_OFFSET
        return this.mQClientFactory.getMQClientAPIImpl().queryConsumerOffset(
                findBrokerResult.getBrokerAddr(), requestHeader, 1000 * 5);
    } else {
   
     
        throw new MQClientException("The broker[" + mq.getBrokerName() + "] not exist", null);
    }
}
```

**在broker端处理请求Code为QUERY_CONSUMER_OFFSET的方法如下：**

```java
/**
 * ConsumerManageProcessor的方法
 */
@Override
public RemotingCommand processRequest(ChannelHandlerContext ctx, RemotingCommand request)
        throws RemotingCommandException {
   
     
    switch (request.getCode()) {
   
     
        case RequestCode.GET_CONSUMER_LIST_BY_GROUP:
            //返回指定group的所有客户端id集合
            return this.getConsumerListByGroup(ctx, request);
        case RequestCode.UPDATE_CONSUMER_OFFSET:
            return this.updateConsumerOffset(ctx, request);
        case RequestCode.QUERY_CONSUMER_OFFSET:
            //查询消费偏移量
            return this.queryConsumerOffset(ctx, request);
        default:
            break;
    }
    return null;
}
```

##### 6.3.1.2 queryConsumerOffset查询消费偏移量

**queryConsumerOffset方法用于broker查询消费者偏移量。**

**1、** 首先根据ConsumerGroup、Topic、QueueId是从broker端的offsetTable这个map集合缓存属性中获取缓存的消费偏移offset；
**2、**
如果offset大于等于0，则直接返回，否则表示缓存中没有对应的消费记录，那么集训判断如果消费队列最新偏移量小于等于0，并且该消费队列的0偏移量数据还在内存中，表示为新消息队列并且消息未清理过，并且数据量不是很大此时，将offset设置为0并返回否则，将会设置QUERY_NOT_FOUND，最后被解析为-1；

*
*从该方法源码可以看出来，消费的consumeFromWhere设置可能不准确，例如一个新的topic里面有少量消息，此时新启动一个consumerGroup去消费，即使consumeFromWhere设置为CONSUME_FROM_LAST_OFFSET，仍然会从0（从头）开始消费。
**

```java
/**
 * ConsumerManageProcessor的方法
 * <p>
 * 查询消费偏移量
 */
private RemotingCommand queryConsumerOffset(ChannelHandlerContext ctx, RemotingCommand request)
        throws RemotingCommandException {
   
     
    //响应对象
    final RemotingCommand response =
            RemotingCommand.createResponseCommand(QueryConsumerOffsetResponseHeader.class);
    final QueryConsumerOffsetResponseHeader responseHeader =
            (QueryConsumerOffsetResponseHeader) response.readCustomHeader();
    final QueryConsumerOffsetRequestHeader requestHeader =
            (QueryConsumerOffsetRequestHeader) request
                    .decodeCommandCustomHeader(QueryConsumerOffsetRequestHeader.class);
    //根据 ConsumerGroup、Topic、QueueId 查询offset，实际上是从broker端的offsetTable这个map集合缓存属性中获取
    //在broker启动时就从broker的{user.home}/store/config/consumerOffset.json中加载
    long offset =
            this.brokerController.getConsumerOffsetManager().queryOffset(
                    requestHeader.getConsumerGroup(), requestHeader.getTopic(), requestHeader.getQueueId());

    if (offset >= 0) {
   
     
        //大于等于0，则存入响应结果返回
        responseHeader.setOffset(offset);
        response.setCode(ResponseCode.SUCCESS);
        response.setRemark(null);
    }
    //小于0表示在offsetTable缓存中没找到
    else {
   
     
        //根据topic和queueId获取消费队列ConsumeQueue的最小的逻辑偏移量offset
        long minOffset =
                this.brokerController.getMessageStore().getMinOffsetInQueue(requestHeader.getTopic(),
                        requestHeader.getQueueId());
        //如果消费队列最新偏移量小于等于0，并且该消费队列的0偏移量数据还在内存中，表示为新消息队列并且消息未清理过，并且数据量不是很大
        if (minOffset <= 0
                && !this.brokerController.getMessageStore().checkInDiskByConsumeOffset(
                requestHeader.getTopic(), requestHeader.getQueueId(), 0)) {
   
     
            //返回0，从0开始读取消费
            responseHeader.setOffset(0L);
            response.setCode(ResponseCode.SUCCESS);
            response.setRemark(null);
        } else {
   
     
            //-1
            response.setCode(ResponseCode.QUERY_NOT_FOUND);
            response.setRemark("Not found, V3_0_6_SNAPSHOT maybe this group consumer boot first");
        }
    }

    return response;
}
```

### 6.4 dispatchPullRequest分发拉取消息请求PullRequest

**该方法将因为本次新增的消息队列而创建的PullRequest请求进行分发处理。**

**1、** **pull模式需要手动拉取消息，这些请求会作废，因此该方法是一个空实现**；
**2、** **push模式下自动拉取消息，而这里的PullRequest就是对应的消息队列的第一个拉取请求，因此这些请求会被PullMessageService依次处理，后续实现自动拉取消息
**；

*
*这些PullRequest将会被存入PullMessageService服务内部的pullRequestQueue集合中，后续异步的消费，自动执行拉取消息的请求，这就是Push模式下最初的拉消息请求的来源。关于如何拉去消息以及如何消费，将是我们下一部分的内容。
**

```java
/**
 * 分发处理消息
 * @param pullRequestList
 */
@Override
public void dispatchPullRequest(List<PullRequest> pullRequestList) {
   
     
    //遍历拉去请求
    for (PullRequest pullRequest : pullRequestList) {
   
     
        //将请求存入PullMessageService服务的pullRequestQueue集合中，后续异步的消费，执行拉取消息的请求
        this.defaultMQPushConsumerImpl.executePullRequestImmediately(pullRequest);
        log.info("doRebalance, {}, add a new pull request {}", consumerGroup, pullRequest);
    }
}
```

## 7 messageQueueChanged更新消息队列

**如果processQueueTable发生了改变，那么调用messageQueueChanged方法。设置新的本地订阅关系版本，重设流控参数，立即给所有broker发送心跳，让Broker更新当前订阅关系。
**

```java
/**
 * RebalancePushImpl的方法
 * <p>
 * 设置新的本地订阅关系版本，重设流控参数，立即给所有broker发送心跳，让Broker更新当前订阅关系
 *
 * @param topic     topic
 * @param mqAll     所有的消息队列
 * @param mqDivided 分配的消息队列
 */
@Override
public void messageQueueChanged(String topic, Set<MessageQueue> mqAll, Set<MessageQueue> mqDivided) {
   
     
    /**
     * When rebalance result changed, should update subscription's version to notify broker.
     * Fix: inconsistency subscription may lead to consumer miss messages.
     */
    //获取订阅关系
    SubscriptionData subscriptionData = this.subscriptionInner.get(topic);
    //设置新的版本
    long newVersion = System.currentTimeMillis();
    log.info("{} Rebalance changed, also update version: {}, {}", topic, subscriptionData.getSubVersion(), newVersion);
    subscriptionData.setSubVersion(newVersion);
    //获取处理队列数量
    int currentQueueCount = this.processQueueTable.size();
    if (currentQueueCount != 0) {
   
     
        //topic级别的流量控制阈值，即当前consumer对于Topic在本地最大能缓存的消息数，默认-1，无限制。如果不等于-1，则该值将会被重新计算
        //例如，如果pullThresholdForTopic的值是1000，并且为该消费者分配了10个消息队列，那么pullThresholdForQueue将被设置为100
        int pullThresholdForTopic = this.defaultMQPushConsumerImpl.getDefaultMQPushConsumer().getPullThresholdForTopic();
        //如果不等于-1
        if (pullThresholdForTopic != -1) {
   
     
            //取值为 pullThresholdForTopic / currentQueueCount
            int newVal = Math.max(1, pullThresholdForTopic / currentQueueCount);
            log.info("The pullThresholdForQueue is changed from {} to {}",
                    this.defaultMQPushConsumerImpl.getDefaultMQPushConsumer().getPullThresholdForQueue(), newVal);
            //重设pullThresholdForTopic
            this.defaultMQPushConsumerImpl.getDefaultMQPushConsumer().setPullThresholdForQueue(newVal);
        }
        //topic级别的消息缓存大小阈值，即当前consumer对于Topic在本地最大能缓存的消息大小，默认-1，无限制
        int pullThresholdSizeForTopic = this.defaultMQPushConsumerImpl.getDefaultMQPushConsumer().getPullThresholdSizeForTopic();
        //如果不等于-1
        if (pullThresholdSizeForTopic != -1) {
   
     
            //取值为 pullThresholdSizeForTopic / currentQueueCount
            int newVal = Math.max(1, pullThresholdSizeForTopic / currentQueueCount);
            log.info("The pullThresholdSizeForQueue is changed from {} to {}",
                    this.defaultMQPushConsumerImpl.getDefaultMQPushConsumer().getPullThresholdSizeForQueue(), newVal);
            //重设pullThresholdSizeForTopic
            this.defaultMQPushConsumerImpl.getDefaultMQPushConsumer().setPullThresholdSizeForQueue(newVal);
        }
    }

    // notify broker
    //主动发送心跳信息给所有broker。
    this.getmQClientFactory().sendHeartbeatToAllBrokerWithLock();
}
```

## 8 总结

**本次我们学习了DefaultMQPushConsumer负载均衡的具体步骤的源码。集群模式负载均衡的大概步骤为：**

**1、** 首先获取该topic的所有消息队列集合mqSet，随后从topic所在的broker中获取当前consumerGroup的clientId集合，即消费者客户端id集合cidAll一个clientId代表一个消费者；
**2、** 对topic的消息队列和clientId集合分别进行排序排序能够保证，不同的客户端消费者在进行负载均衡时，其mqAll和cidAll中的元素顺序是一致的；
**3、** 获取分配消息队列的策略实现AllocateMessageQueueStrategy，即负载均衡的策略类，执行allocate方法，为当前clientId也就是当前消费者，分配消息队列，这一步就是执行负载均衡或者说重平衡的算法；
**4、**
调用updateProcessQueueTableInRebalance方法，更新新分配的消息队列的处理队列processQueueTable的信息，为新分配的消息队列创建最初的pullRequest并分发给PullMessageService
**这就是Push模式下最初的拉消息请求的来源**；
**5、** 如果processQueueTable发生了改变，那么调用messageQueueChanged方法设置新的本地订阅关系版本，重设流控参数，立即给所有broker发送心跳，让Broker更新当前订阅关系；

*
*同时我们也知道了，最初始的PullRequest，就是在负载均衡之时对于新分配到的消费队列创建的。然后通过dispatchPullRequest方法对这些PullRequest进行分发，Push模式下这些请求会被PullMessageService依次处理，后续实现自动拉取消息，以及消费。
**

*
*这些PullRequest将会被存入PullMessageService服务内部的pullRequestQueue集合中，后续异步的消费，自动执行拉取消息的请求，这就是Push模式下最初的拉消息请求的来源。关于如何拉去消息以及如何消费，将是我们下一部分的内容。
**