---

layout: 19、RocketMQ源码分析：Broker处理DefaultMQPushConsumer发起的拉取消息请求源码【一万字】

title:  19、RocketMQ源码分析：Broker处理DefaultMQPushConsumer发起的拉取消息请求源码【一万字】

tags: RocketMq

categories: Web

top: 56

path: /article/1739713344

abbrlink: 1739713344

date: 2025-02-16 21:42:06


--- 

# 19、RocketMQ源码分析：Broker处理DefaultMQPushConsumer发起的拉取消息请求源码【一万字】

**前我们学习了
**[RocketMQ源码(18)—DefaultMQPushConsumer消费者发起拉取消息请求源码](https://blog.csdn.net/weixin_43767015/article/details/128563451)
。我们知道consumer在发送了拉取消息请求的时候，请求的Code为**PULL_MESSAGE**，broker端接收到请求之后，将会更根据不同的Code调用不同的处理器进行处理，而
**PULL_MESSAGE**拉取消息的请求则是通过**PullMessageProcessor**处理的。

下面我们来看看Broker处理DefaultMQPushConsumer发起的拉取消息请求源码。

## 1 PullMessageProcessor处理拉取请求

PullMessageProcessor作为broker的拉取消息处理器，用于处理拉取消息的请求，他在BrokerController实例化的时候跟着实例化。
![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162121090.png)
然后在registerProcessor方法中，将Code为PULL_MESSAGE的请求与其绑定。

![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162121348.png)
随后在processRequestCommand方法中，会根据请求的Code选择不同的netty处理器进行处理，调用方法为asyncProcessRequest：

![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162121583.png)
在asyncProcessRequest方法中，将会调用processRequest方法，该方法由各个处理器实现，这里就是PullMessageProcessor处理器处理器PULL_MESSAGE拉取消息请求的入口方法。

```java
/**
 * PullMessageProcessor的方法
 * <p>
 * 处理PULL_MESSAGE拉取消息请求
 */
@Override
public RemotingCommand processRequest(final ChannelHandlerContext ctx,
                                      RemotingCommand request) throws RemotingCommandException {
   
     
    //调用另一个processRequest方法，第三个参数broker是否支持持挂起请求为true
    return this.processRequest(ctx.channel(), request, true);
}
```

## 2 processRequest处理拉取消息请求

**
该方法处理拉取消息的请求，包括构建过滤信息，拉取消息，拉取结果处理（判断直接返回响应还是挂起请求），上报消费点位等步骤，源码非常多，不易理解。**
大概步骤为（详细步骤请看源码注释）：

**1、** 构建过滤信息基于TAG会获取subscriptionData，基于classFilter还会获取consumerFilterData，最后根据它们构建MessageFilter对象；

**1、** 如果有子订阅标记，即hasSubscriptionFlag=true，那么每次拉取消息都会重新构建subscriptionData和consumerFilterData，而不是使用缓存的数据；
**2、**
一般hasSubscriptionFlag都是false，因为hasSubscriptionFlag为true需要consumer端将postSubscriptionWhenPull=true，并且订阅不是classFilter模式同时满足；

2. 通过DefaultMessageStore#getMessage方法拉取消息，并且进行过滤操作。这是拉取消息的核心方法，涉及到查找ConsumeQueue和CommitLog文件数据。返回拉取结果GetMessageResult。

**3、** 对于拉取结果GetMessageResult进行处理，设置响应数据；

**1、** 判断并设置下次拉取消息的建议broker是MASTER还是SLAVE；

```
1.  如果getMessage方法返回的GetMessageResult的suggestPullingFromSlave属性为true，则设置responseHeader的suggestWhichBrokerId属性值为1，即建议下次从SLAVE拉取，否则设置为0，建议下次从MASTER拉取。
2.  判断broker角色。如果是SLAVE，并且slaveReadEnable = false。那么设置responseHeader的suggestWhichBrokerId属性值为0，即建议下次从MASTER拉取。
3.  如果slaveReadEnable = true，并且如果如果消费太慢了，那么下次重定向到另一台broker，id通过subscriptionGroupConfig的whichBrokerWhenConsumeSlowly指定，默认1，即SLAVE。否则id通过subscriptionGroupConfig的brokerId指定，默认0，即MASTER。如果slaveReadEnable = false，设置建议的brokerId为MASTER。
```

**2、** 判断getMessageResult的状态码，并设置response的对应的响应码；
**3、** 判断如果有消费钩子，那么执行消费钩子的consumeMessageBefore方法；
**4、** 判断响应码，然后直接返回数据或者进行短轮询或者长轮询；

```
1.  如果拉取消息成功，那么更新一些统计信息，然后从buffer中读取出消息转换为字节数组，存入response的body中。
2.  如果没有读取到消息，如果broker允许挂起请求并且客户端支持请求挂起，则broker挂起该请求一段时间，中间如果有消息到达则会唤醒请求拉取消息并返回。
    
    1.  计算最长挂起时间，如果支持长轮询则默认最长挂起15s，否则使用短轮询，挂起最长1s。
        2.  构建一个PullRequest，通过pullRequestHoldService\#suspendPullRequest方法提交PullRequest，该请求将会被挂起并异步处理。  
        iii. 如果读取的offset不正确，太大或者太小，发布offset移除事件。
```

1.
拉取消息完毕之后，无论是否拉取到消息，只要broker支持挂起请求（新的拉取请求为true，但是已被suspend的请求将会是false），并且consumer支持提交消费进度，并且当前broker不是SLAVE角色，那么通过ConsumerOffsetManager#commitOffset方法提交消费进度偏移量。

```java
/**
 * PullMessageProcessor的方法
 * <p>
 * 处理拉取消息请求
 *
 * @param channel            通连接道
 * @param request            请求
 * @param brokerAllowSuspend broker是否支持挂起请求
 * @return
 * @throws RemotingCommandException
 */
private RemotingCommand processRequest(final Channel channel, RemotingCommand request, boolean brokerAllowSuspend) throws RemotingCommandException {
   
     
    //起始时间
    final long beginTimeMills = this.brokerController.getMessageStore().now();
    //创建响应命令对象
    RemotingCommand response = RemotingCommand.createResponseCommand(PullMessageResponseHeader.class);
    //创建响应头
    final PullMessageResponseHeader responseHeader = (PullMessageResponseHeader) response.readCustomHeader();
    //解析请求头
    final PullMessageRequestHeader requestHeader = (PullMessageRequestHeader) request.decodeCommandCustomHeader(PullMessageRequestHeader.class);
    //设置请求id，通过id可以获取请求结果
    response.setOpaque(request.getOpaque());

    log.debug("receive PullMessage request command, {}", request);
    //当前broker是否可读，不可读则直接返回
    if (!PermName.isReadable(this.brokerController.getBrokerConfig().getBrokerPermission())) {
   
     
        response.setCode(ResponseCode.NO_PERMISSION);
        response.setRemark(String.format("the broker[%s] pulling message is forbidden", this.brokerController.getBrokerConfig().getBrokerIP1()));
        return response;
    }
    //获取当前consumerGroup对应的订阅信息
    SubscriptionGroupConfig subscriptionGroupConfig = this.brokerController.getSubscriptionGroupManager().findSubscriptionGroupConfig(requestHeader.getConsumerGroup());
    if (null == subscriptionGroupConfig) {
   
     
        response.setCode(ResponseCode.SUBSCRIPTION_GROUP_NOT_EXIST);
        response.setRemark(String.format("subscription group [%s] does not exist, %s", requestHeader.getConsumerGroup(), FAQUrl.suggestTodo(FAQUrl.SUBSCRIPTION_GROUP_NOT_EXIST)));
        return response;
    }
    //判断是否可消费，不可消费则直接返回
    if (!subscriptionGroupConfig.isConsumeEnable()) {
   
     
        response.setCode(ResponseCode.NO_PERMISSION);
        response.setRemark("subscription group no permission, " + requestHeader.getConsumerGroup());
        return response;
    }
    //是否支持请求挂起
    final boolean hasSuspendFlag = PullSysFlag.hasSuspendFlag(requestHeader.getSysFlag());
    //是否提交消费进度
    final boolean hasCommitOffsetFlag = PullSysFlag.hasCommitOffsetFlag(requestHeader.getSysFlag());
    //是否存在子订阅，即TAG或者SQL92的设置，用于过滤消息
    final boolean hasSubscriptionFlag = PullSysFlag.hasSubscriptionFlag(requestHeader.getSysFlag());
    //计算broker最长的挂起时间，默认15s，该参数是消费者传递的
    final long suspendTimeoutMillisLong = hasSuspendFlag ? requestHeader.getSuspendTimeoutMillis() : 0;
    //获取topic配置
    TopicConfig topicConfig = this.brokerController.getTopicConfigManager().selectTopicConfig(requestHeader.getTopic());
    if (null == topicConfig) {
   
     
        log.error("the topic {} not exist, consumer: {}", requestHeader.getTopic(), RemotingHelper.parseChannelRemoteAddr(channel));
        response.setCode(ResponseCode.TOPIC_NOT_EXIST);
        response.setRemark(String.format("topic[%s] not exist, apply first please! %s", requestHeader.getTopic(), FAQUrl.suggestTodo(FAQUrl.APPLY_TOPIC_URL)));
        return response;
    }
    //topic是否可读，不可读则直接返回
    if (!PermName.isReadable(topicConfig.getPerm())) {
   
     
        response.setCode(ResponseCode.NO_PERMISSION);
        response.setRemark("the topic[" + requestHeader.getTopic() + "] pulling message is forbidden");
        return response;
    }
    //校验请求中的队列id，如果小于0或者大于等于topic配置中的读队列数量，那么直接返回
    if (requestHeader.getQueueId() < 0 || requestHeader.getQueueId() >= topicConfig.getReadQueueNums()) {
   
     
        String errorInfo = String.format("queueId[%d] is illegal, topic:[%s] topicConfig.readQueueNums:[%d] consumer:[%s]", requestHeader.getQueueId(), requestHeader.getTopic(), topicConfig.getReadQueueNums(), channel.remoteAddress());
        log.warn(errorInfo);
        response.setCode(ResponseCode.SYSTEM_ERROR);
        response.setRemark(errorInfo);
        return response;
    }
    /*
     * 1 构建过滤信息
     * 真正的过滤消息操作还在后面，而且broker和consumer都会进行过滤
     */
    SubscriptionData subscriptionData = null;
    ConsumerFilterData consumerFilterData = null;
    //如果有子订阅标记，那么每次拉取消息都会重新构建subscriptionData和consumerFilterData，而不是使用缓存的信息，一般都是false
    //因为hasSubscriptionFlag为true需要consumer端将postSubscriptionWhenPull=true，并且订阅不是classFilter模式同时满足
    if (hasSubscriptionFlag) {
   
     
        try {
   
     
            subscriptionData = FilterAPI.build(requestHeader.getTopic(), requestHeader.getSubscription(), requestHeader.getExpressionType());
            if (!ExpressionType.isTagType(subscriptionData.getExpressionType())) {
   
     
                consumerFilterData = ConsumerFilterManager.build(requestHeader.getTopic(), requestHeader.getConsumerGroup(), requestHeader.getSubscription(), requestHeader.getExpressionType(), requestHeader.getSubVersion());
                assert consumerFilterData != null;
            }
        } catch (Exception e) {
   
     
            log.warn("Parse the consumer's subscription[{}] failed, group: {}", requestHeader.getSubscription(), requestHeader.getConsumerGroup());
            response.setCode(ResponseCode.SUBSCRIPTION_PARSE_FAILED);
            response.setRemark("parse the consumer's subscription failed");
            return response;
        }
    } else {
   
     
        //获取消费者组信息
        ConsumerGroupInfo consumerGroupInfo = this.brokerController.getConsumerManager().getConsumerGroupInfo(requestHeader.getConsumerGroup());
        if (null == consumerGroupInfo) {
   
     
            log.warn("the consumer's group info not exist, group: {}", requestHeader.getConsumerGroup());
            response.setCode(ResponseCode.SUBSCRIPTION_NOT_EXIST);
            response.setRemark("the consumer's group info not exist" + FAQUrl.suggestTodo(FAQUrl.SAME_GROUP_DIFFERENT_TOPIC));
            return response;
        }
        //如果不支持广播消费但是消费者消费模式是广播消费，则直接返回
        if (!subscriptionGroupConfig.isConsumeBroadcastEnable() && consumerGroupInfo.getMessageModel() == MessageModel.BROADCASTING) {
   
     
            response.setCode(ResponseCode.NO_PERMISSION);
            response.setRemark("the consumer group[" + requestHeader.getConsumerGroup() + "] can not consume by broadcast way");
            return response;
        }
        //获取broker缓存的此consumerGroupInfo中关于此topic的订阅关系
        subscriptionData = consumerGroupInfo.findSubscriptionData(requestHeader.getTopic());
        if (null == subscriptionData) {
   
     
            log.warn("the consumer's subscription not exist, group: {}, topic:{}", requestHeader.getConsumerGroup(), requestHeader.getTopic());
            response.setCode(ResponseCode.SUBSCRIPTION_NOT_EXIST);
            response.setRemark("the consumer's subscription not exist" + FAQUrl.suggestTodo(FAQUrl.SAME_GROUP_DIFFERENT_TOPIC));
            return response;
        }
        //比较订阅关系版本
        if (subscriptionData.getSubVersion() < requestHeader.getSubVersion()) {
   
     
            log.warn("The broker's subscription is not latest, group: {} {}", requestHeader.getConsumerGroup(), subscriptionData.getSubString());
            response.setCode(ResponseCode.SUBSCRIPTION_NOT_LATEST);
            response.setRemark("the consumer's subscription not latest");
            return response;
        }
        //如果订阅关系表达式不是TAG类型，那么构建consumerFilterData
        if (!ExpressionType.isTagType(subscriptionData.getExpressionType())) {
   
     
            consumerFilterData = this.brokerController.getConsumerFilterManager().get(requestHeader.getTopic(), requestHeader.getConsumerGroup());
            if (consumerFilterData == null) {
   
     
                response.setCode(ResponseCode.FILTER_DATA_NOT_EXIST);
                response.setRemark("The broker's consumer filter data is not exist!Your expression may be wrong!");
                return response;
            }
            if (consumerFilterData.getClientVersion() < requestHeader.getSubVersion()) {
   
     
                log.warn("The broker's consumer filter data is not latest, group: {}, topic: {}, serverV: {}, clientV: {}", requestHeader.getConsumerGroup(), requestHeader.getTopic(), consumerFilterData.getClientVersion(), requestHeader.getSubVersion());
                response.setCode(ResponseCode.FILTER_DATA_NOT_LATEST);
                response.setRemark("the consumer's consumer filter data not latest");
                return response;
            }
        }
    }
    //如果订阅关系表达式不是TAG类型，并且enablePropertyFilter没有开启支持SQL92，那么抛出异常
    //也就是说，如果消费者使用SQL92模式订阅，那么需要现在broker端设置enablePropertyFilter=true
    if (!ExpressionType.isTagType(subscriptionData.getExpressionType()) && !this.brokerController.getBrokerConfig().isEnablePropertyFilter()) {
   
     
        response.setCode(ResponseCode.SYSTEM_ERROR);
        response.setRemark("The broker does not support consumer to filter message by " + subscriptionData.getExpressionType());
        return response;
    }

    MessageFilter messageFilter;
    //重试topic是否支持filter过滤，默认false，即重试topic是不支持过滤额
    if (this.brokerController.getBrokerConfig().isFilterSupportRetry()) {
   
     
        messageFilter = new ExpressionForRetryMessageFilter(subscriptionData, consumerFilterData, this.brokerController.getConsumerFilterManager());
    } else {
   
     
        //创建普通的ExpressionMessageFilter，内部保存了消费者启动时通过心跳上报的订阅关系
        //一般基于tag订阅的情况下，consumerFilterData是null，通过subscriptionData进行过滤
        messageFilter = new ExpressionMessageFilter(subscriptionData, consumerFilterData, this.brokerController.getConsumerFilterManager());
    }

    /*
     * 2 通过DefaultMessageStore#getMessage方法批量拉取消息，并且进行过滤操作
     */
    final GetMessageResult getMessageResult = this.brokerController.getMessageStore().getMessage(requestHeader.getConsumerGroup(), requestHeader.getTopic(), requestHeader.getQueueId(), requestHeader.getQueueOffset(), requestHeader.getMaxMsgNums(), messageFilter);
    /*
     * 3 对于拉取结果GetMessageResult进行处理
     */
    if (getMessageResult != null) {
   
     
        //设置拉去状态枚举名字
        response.setRemark(getMessageResult.getStatus().name());
        //设置下次拉取的consumeQueue的起始逻辑偏移量
        responseHeader.setNextBeginOffset(getMessageResult.getNextBeginOffset());
        //设置consumeQueue的最小、最大的逻辑偏移量maxOffset和minOffset
        responseHeader.setMinOffset(getMessageResult.getMinOffset());
        responseHeader.setMaxOffset(getMessageResult.getMaxOffset());
        /*
         * 3.1 判断并设置下次拉取消息的建议broker是MATER还是SLAVE
         */
        //是否建议从SLAVE拉取消息
        if (getMessageResult.isSuggestPullingFromSlave()) {
   
     
            //设置建议的brokerId为从服务器的id 1
            responseHeader.setSuggestWhichBrokerId(subscriptionGroupConfig.getWhichBrokerWhenConsumeSlowly());
        } else {
   
     
            //否则，设置建议的brokerId为主服务器的id 0
            responseHeader.setSuggestWhichBrokerId(MixAll.MASTER_ID);
        }
        //判断broker角色
        switch (this.brokerController.getMessageStoreConfig().getBrokerRole()) {
   
     
            case ASYNC_MASTER:
            case SYNC_MASTER:
                break;
            case SLAVE:
                //如果是SLAVE，并且从服务器不可读
                if (!this.brokerController.getBrokerConfig().isSlaveReadEnable()) {
   
     
                    //设置响应码为PULL_RETRY_IMMEDIATELY，consumer收到响应后会立即从MASTER重试拉取
                    response.setCode(ResponseCode.PULL_RETRY_IMMEDIATELY);
                    //设置建议的brokerId为主服务器的id 0
                    responseHeader.setSuggestWhichBrokerId(MixAll.MASTER_ID);
                }
                break;
        }
        //如果从服务器可读
        if (this.brokerController.getBrokerConfig().isSlaveReadEnable()) {
   
     
            // 如果消费太慢了，那么下次重定向到另一台broker，id通过subscriptionGroupConfig的whichBrokerWhenConsumeSlowly指定，默认1，即SLAVE
            if (getMessageResult.isSuggestPullingFromSlave()) {
   
     
                responseHeader.setSuggestWhichBrokerId(subscriptionGroupConfig.getWhichBrokerWhenConsumeSlowly());
            }
            // consume ok
            else {
   
     
                //id通过subscriptionGroupConfig的brokerId指定，默认0，即MASTER
                responseHeader.setSuggestWhichBrokerId(subscriptionGroupConfig.getBrokerId());
            }
        } else {
   
     
            //如果从服务器不可读，设置建议的brokerId为主服务器的id 0
            responseHeader.setSuggestWhichBrokerId(MixAll.MASTER_ID);
        }
        /*
         * 3.2 判断拉取消息状态码，并设置对应的响应码
         */
        switch (getMessageResult.getStatus()) {
   
     
            case FOUND:
                //找到了消息
                response.setCode(ResponseCode.SUCCESS);
                break;
            case MESSAGE_WAS_REMOVING:
                //commitLog中没有找到消息
                response.setCode(ResponseCode.PULL_RETRY_IMMEDIATELY);
                break;
            case NO_MATCHED_LOGIC_QUEUE:
            case NO_MESSAGE_IN_QUEUE:
                //没找到consumeQueue，或者consumeQueue没有消息
                if (0 != requestHeader.getQueueOffset()) {
   
     
                    response.setCode(ResponseCode.PULL_OFFSET_MOVED);

                    // XXX: warn and notify me
                    log.info("the broker store no queue data, fix the request offset {} to {}, Topic: {} QueueId: {} Consumer Group: {}", requestHeader.getQueueOffset(), getMessageResult.getNextBeginOffset(), requestHeader.getTopic(), requestHeader.getQueueId(), requestHeader.getConsumerGroup());
                } else {
   
     
                    response.setCode(ResponseCode.PULL_NOT_FOUND);
                }
                break;
            case NO_MATCHED_MESSAGE:
                //没匹配到消息
                response.setCode(ResponseCode.PULL_RETRY_IMMEDIATELY);
                break;
            case OFFSET_FOUND_NULL:
                response.setCode(ResponseCode.PULL_NOT_FOUND);
                break;
            case OFFSET_OVERFLOW_BADLY:
                response.setCode(ResponseCode.PULL_OFFSET_MOVED);
                // XXX: warn and notify me
                log.info("the request offset: {} over flow badly, broker max offset: {}, consumer: {}", requestHeader.getQueueOffset(), getMessageResult.getMaxOffset(), channel.remoteAddress());
                break;
            case OFFSET_OVERFLOW_ONE:
                response.setCode(ResponseCode.PULL_NOT_FOUND);
                break;
            case OFFSET_TOO_SMALL:
                response.setCode(ResponseCode.PULL_OFFSET_MOVED);
                log.info("the request offset too small. group={}, topic={}, requestOffset={}, brokerMinOffset={}, clientIp={}", requestHeader.getConsumerGroup(), requestHeader.getTopic(), requestHeader.getQueueOffset(), getMessageResult.getMinOffset(), channel.remoteAddress());
                break;
            default:
                assert false;
                break;
        }
        /*
         * 3.3 判断如果有消费钩子，那么执行consumeMessageBefore方法
         */
        if (this.hasConsumeMessageHook()) {
   
     
            //构建上下文
            ConsumeMessageContext context = new ConsumeMessageContext();
            context.setConsumerGroup(requestHeader.getConsumerGroup());
            context.setTopic(requestHeader.getTopic());
            context.setQueueId(requestHeader.getQueueId());

            String owner = request.getExtFields().get(BrokerStatsManager.COMMERCIAL_OWNER);

            switch (response.getCode()) {
   
     
                case ResponseCode.SUCCESS:
                    int commercialBaseCount = brokerController.getBrokerConfig().getCommercialBaseCount();
                    int incValue = getMessageResult.getMsgCount4Commercial() * commercialBaseCount;

                    context.setCommercialRcvStats(BrokerStatsManager.StatsType.RCV_SUCCESS);
                    context.setCommercialRcvTimes(incValue);
                    context.setCommercialRcvSize(getMessageResult.getBufferTotalSize());
                    context.setCommercialOwner(owner);

                    break;
                case ResponseCode.PULL_NOT_FOUND:
                    if (!brokerAllowSuspend) {
   
     

                        context.setCommercialRcvStats(BrokerStatsManager.StatsType.RCV_EPOLLS);
                        context.setCommercialRcvTimes(1);
                        context.setCommercialOwner(owner);

                    }
                    break;
                case ResponseCode.PULL_RETRY_IMMEDIATELY:
                case ResponseCode.PULL_OFFSET_MOVED:
                    context.setCommercialRcvStats(BrokerStatsManager.StatsType.RCV_EPOLLS);
                    context.setCommercialRcvTimes(1);
                    context.setCommercialOwner(owner);
                    break;
                default:
                    assert false;
                    break;
            }
            /*
             * 执行前置钩子方法
             */
            this.executeConsumeMessageHookBefore(context);
        }
        /*
         * 3.4 判断响应码，然后直接返回数据或者进行短轮询或者长轮询
         */
        switch (response.getCode()) {
   
     
            //如果拉取消息成功
            case ResponseCode.SUCCESS:
                //更新一些统计信息
                this.brokerController.getBrokerStatsManager().incGroupGetNums(requestHeader.getConsumerGroup(), requestHeader.getTopic(), getMessageResult.getMessageCount());

                this.brokerController.getBrokerStatsManager().incGroupGetSize(requestHeader.getConsumerGroup(), requestHeader.getTopic(), getMessageResult.getBufferTotalSize());

                this.brokerController.getBrokerStatsManager().incBrokerGetNums(getMessageResult.getMessageCount());
                //是否读取消息到堆内存中，默认true
                if (this.brokerController.getBrokerConfig().isTransferMsgByHeap()) {
   
     
                    //从buffer中读取出消息转换为字节数组
                    final byte[] r = this.readGetMessageResult(getMessageResult, requestHeader.getConsumerGroup(), requestHeader.getTopic(), requestHeader.getQueueId());
                    this.brokerController.getBrokerStatsManager().incGroupGetLatency(requestHeader.getConsumerGroup(), requestHeader.getTopic(), requestHeader.getQueueId(), (int) (this.brokerController.getMessageStore().now() - beginTimeMills));
                    //设置到body中
                    response.setBody(r);
                } else {
   
     
                    try {
   
     
                        //基于netty直接读取buffer传输
                        FileRegion fileRegion = new ManyMessageTransfer(response.encodeHeader(getMessageResult.getBufferTotalSize()), getMessageResult);
                        channel.writeAndFlush(fileRegion).addListener(new ChannelFutureListener() {
   
     
                            @Override
                            public void operationComplete(ChannelFuture future) throws Exception {
   
     
                                getMessageResult.release();
                                if (!future.isSuccess()) {
   
     
                                    log.error("transfer many message by pagecache failed, {}", channel.remoteAddress(), future.cause());
                                }
                            }
                        });
                    } catch (Throwable e) {
   
     
                        log.error("transfer many message by pagecache exception", e);
                        getMessageResult.release();
                    }

                    response = null;
                }
                break;
            //没有读取到消息
            case ResponseCode.PULL_NOT_FOUND:
                //如果broker允许挂起请求并且客户端支持请求挂起，则broker挂起该请求一段时间，中间如果有消息到达则会唤醒请求拉取消息并返回
                if (brokerAllowSuspend && hasSuspendFlag) {
   
     
                    //broker最长的挂起时间，默认15s，该参数是消费者传递的
                    long pollingTimeMills = suspendTimeoutMillisLong;
                    //如果broker不支持长轮询，默认都是支持的
                    if (!this.brokerController.getBrokerConfig().isLongPollingEnable()) {
   
     
                        //那么使用短轮询，即最长的挂起时间设置为1s
                        pollingTimeMills = this.brokerController.getBrokerConfig().getShortPollingTimeMills();
                    }

                    String topic = requestHeader.getTopic();
                    long offset = requestHeader.getQueueOffset();
                    int queueId = requestHeader.getQueueId();
                    //创建新的拉取请求
                    PullRequest pullRequest = new PullRequest(request, channel, pollingTimeMills, this.brokerController.getMessageStore().now(), offset, subscriptionData, messageFilter);
                    //通过pullRequestHoldService#suspendPullRequest方法提交PullRequest，该请求将会被挂起并异步处理
                    this.brokerController.getPullRequestHoldService().suspendPullRequest(topic, queueId, pullRequest);
                    response = null;
                    break;
                }

            case ResponseCode.PULL_RETRY_IMMEDIATELY:
                break;
            //读取的offset不正确，太大或者太小
            case ResponseCode.PULL_OFFSET_MOVED:
                //如果broker不是SLAVE，或者是SLAVE，但是允许offset校验
                if (this.brokerController.getMessageStoreConfig().getBrokerRole() != BrokerRole.SLAVE || this.brokerController.getMessageStoreConfig().isOffsetCheckInSlave()) {
   
     
                    //发布offset移除事件
                    MessageQueue mq = new MessageQueue();
                    mq.setTopic(requestHeader.getTopic());
                    mq.setQueueId(requestHeader.getQueueId());
                    mq.setBrokerName(this.brokerController.getBrokerConfig().getBrokerName());

                    OffsetMovedEvent event = new OffsetMovedEvent();
                    event.setConsumerGroup(requestHeader.getConsumerGroup());
                    event.setMessageQueue(mq);
                    event.setOffsetRequest(requestHeader.getQueueOffset());
                    event.setOffsetNew(getMessageResult.getNextBeginOffset());
                    this.generateOffsetMovedEvent(event);
                    log.warn("PULL_OFFSET_MOVED:correction offset. topic={}, groupId={}, requestOffset={}, newOffset={}, suggestBrokerId={}", requestHeader.getTopic(), requestHeader.getConsumerGroup(), event.getOffsetRequest(), event.getOffsetNew(), responseHeader.getSuggestWhichBrokerId());
                } else {
   
     
                    responseHeader.setSuggestWhichBrokerId(subscriptionGroupConfig.getBrokerId());
                    response.setCode(ResponseCode.PULL_RETRY_IMMEDIATELY);
                    log.warn("PULL_OFFSET_MOVED:none correction. topic={}, groupId={}, requestOffset={}, suggestBrokerId={}", requestHeader.getTopic(), requestHeader.getConsumerGroup(), requestHeader.getQueueOffset(), responseHeader.getSuggestWhichBrokerId());
                }

                break;
            default:
                assert false;
        }
    } else {
   
     
        response.setCode(ResponseCode.SYSTEM_ERROR);
        response.setRemark("store getMessage return null");
    }
    /*
     * 4 拉取消息完毕之后，无论是否拉取到消息，只要broker支持挂起请求，并且consumer支持提交消费进度，并且当前broker不是SLAVE角色，都会上报该消费者上一次的消费点位
     * 另外消费者客户端也会定时没5s上报一次消费点
     */
    //要求brokerAllowSuspend为true，新的拉取请求为true，但是已被suspend的请求将会是false
    boolean storeOffsetEnable = brokerAllowSuspend;
    storeOffsetEnable = storeOffsetEnable && hasCommitOffsetFlag;
    storeOffsetEnable = storeOffsetEnable && this.brokerController.getMessageStoreConfig().getBrokerRole() != BrokerRole.SLAVE;
    //如果支持持久化偏移量
    if (storeOffsetEnable) {
   
     
        //上报偏移量
        this.brokerController.getConsumerOffsetManager().commitOffset(RemotingHelper.parseChannelRemoteAddr(channel), requestHeader.getConsumerGroup(), requestHeader.getTopic(), requestHeader.getQueueId(), requestHeader.getCommitOffset());
    }
    return response;
}
```

### 2.1 getMessage批量获取消息

**该方法从给定偏移量开始，在queueId中最多查询属于topic的最多maxMsgNums条消息，默认32条。获取的消息将使用提供的消息过滤器messageFilter进行进一步筛选。
**

*
*最终返回GetMessageResult对象，内部包含着拉取到的消息的序列化之后的原始字节buffer数组，而不是反序列化后的Message对象。Consumer收到响应消息之后，会按照CommitLog消息序列化格式自行反序列化为Message对象。这里在broker端没有进行反序列化是因为没有必要，因为在返回响应的数据的时候，还是需要进行序列化传输，这样提升了效率。
**

**这个方法是broker处理拉取消息的核心方法，真正的拉取消息。大概步骤如下，该方法流程很长，详细的步骤建议看看下面的源码中的注释：
**

**1、** 初始化拉取时间beginTime，拉取状态status，下次拉取的consumeQueue的起始逻辑偏移量nextBeginOffset，当前commitLog的最大物理偏移量maxOffsetPy等变量，后面会用到；
**2、** 调用findConsumeQueue方法，根据topic和队列id确定需要写入的ConsumeQueue这个方法的源码我们在构建ConsumeQueue和IndexFIle部分已经讲过了；
**3、** 偏移量校验首先获取consumeQueue的最小和最大的逻辑偏移量minOffset和maxOffset对于偏移量异常的情况，需要矫正下一次拉取的开始偏移量：；

**1、** 如果最大的逻辑偏移量offset为0，表示消息队列无消息，设置NO_MESSAGE_IN_QUEUE矫正下一次拉取的开始偏移量，如果broker不是SLAVE节点，或者是SLAVE节点但是从服务器支持offset检查，则为0；
**2、**
如果consumer传递的offset小于最小偏移量，表示拉取的位置太小，设置OFFSET_TOO_SMALL矫正下一次拉取的开始偏移量，如果broker不是SLAVE节点，或者是SLAVE节点但是从服务器支持offset检查，则为minOffset；
**3、** 如果consumer传递的offset等于最大偏移量，表示拉取的位置溢出，设置OFFSET_OVERFLOW_ONE矫正下一次拉取的开始偏移量，还是offset；
**4、**
如果consumer传递的offset大于最大偏移量，表示拉取的位置严重溢出，设置OFFSET_OVERFLOW_BADLY如果最小偏移量为0，矫正下一次拉取的开始偏移量，如果broker不是SLAVE节点，或者是SLAVE节点但是从服务器支持offset检查，则为minOffset如果最小偏移量不为0，则为maxOffset；
**5、** **以上情况均导致不会进行消息拉取**；
**4、** 如果consumer传递的offset大于等于minOffset，且小于maxOffset，表示偏移量在正常范围内则进行下一步消息拉取操作；

5.
调用consumeQueue#getIndexBuffer方法。根据逻辑offset定位到物理偏移量，然后截取该偏移量之后的一段Buffer，其包含要拉取的消息的索引数据及对应consumeQueue文件之后的全部索引数据。这里截取的Buffer可能包含多条索引数据，因为需要批量拉取多条消息，以及进行消息过滤。

**6、**
如果截取到了Buffer数据，那么从Buffer中检查索引数据以及查找commitLog中的消息数据否则，表示可能是到达了当前consumeQueue文件的尾部，nextBeginOffset设置为consumeQueue的下一个文件的起始偏移量，本次不进行拉取；

**1、**
正式拉取消息前，同样先初始化一些变量，例如下一个commitLog文件的起始物理偏移量nextPhyFileStartOffset，默认从Long.MIN_VALUE开始，以及本次消息拉取的最大物理偏移量maxPhyOffsetPulling；
**2、** 计算每次拉取的最大的过滤消息索引字节数，一般为16000/20=800条即一次拉取请求，最多查找800条消息索引；
**3、** 循环遍历截取的buffer，处理每一条ConsumeQueue索引，拉取消息ConsumeQueue消息固定长度20字节，因此每次循环移动20B的长度；

```
1.  获取ConsumeQueue索引条目中的数据，包括消息在CommitLog中的物理偏移量offsetPy，消息大小sizePy，生产者发送消息时设置的tags的hashCode值tagsCode。
2.  更新maxPhyOffsetPulling为当前消息在CommitLog中的物理偏移量。
3.  如果nextPhyFileStartOffset不为Long.MIN\_VALUE，并且offsetPy 小于 nextPhyFileStartOffset那表示切换到了下一个commitLog文件，并且当前偏移量下一该文件最小偏量，那么跳过该消息的处理。
4.  调用checkInDiskByCommitOffset方法。检查要拉取的消息是否在磁盘上。
5.  调用isTheBatchFull方法，判断本次请求的消息拉取是否达到上限，如果达到上限，则跳出循环，结束消息的拉取。
    6.  **调用messageFilter\#isMatchedByConsumeQueue方法，执行消息tagsCode过滤**。tagsCode在ConsumeQueue中保存着，因此基于ConsumeQueue条目就能执行broker端的TAG过滤。如果没有过滤通过，则跳过该索引条目，拉取下一个索引条目。
    7.  TAG校验通过，**调用commitLog\#getMessage方法根据消息的物理偏移量和消息大小获取该索引对应的真正的消息内存selectResult**。如果没有找到消息，表示该偏移量可能到达了文件末尾，消息存放在下一个commitLog文件中。nextPhyFileStartOffset设置为下一个commitLog文件的起始物理偏移量，并跳过本次拉取。
    8.  找到了消息，继续**通过messageFilter\#isMatchedByCommitLog方法执行消息SQL92 过滤**。SQL92 过滤依赖于消息中的属性，而消息体的内容存放在commitLog中的，因此需要先拉取到消息，在进行SQL92过滤。过滤不通过，释放这一段内存，并跳过本次拉取。
    9.  **TAG和SQL92校验通过，那么将消息通过getResult\#addMessage存入getResult，注意存入的是一段buffer内存，即字节数组**。
10. 更改status 为GetMessageStatus.FOUND，表示找到了消息。nextPhyFileStartOffset重新置为Long.MIN\_VALUE，继续下一次循环。
```

**4、** 循环拉取消息结束计算下一次读取数据的ConsumeQueue的开始偏移量nextBeginOffset=当前开始拉取消息时的偏移量+本次拉取移动的偏移量；
**5、** *
*判断是否建议下一次从SLAVEbroker中拉取消息如果剩余的commitLog磁盘可拉取的消息字节数大于broker服务最大可使用物理内存，那么设置suggestPullingFromSlave=true，建议下一次从SLAVEbroker中拉取消息，因为此时发现消息堆积太多，默认超过物理内存的40%
**；
**7、** 进行一些storeStatsService中的状态字段的统计，用于控制台展示；
**8、**
设置getResult的属性并返回包括设置拉取状态status、设置下次拉取的consumeQueue的起始逻辑偏移量nextBeginOffset，设置consumeQueue的最小、最大的逻辑偏移量maxOffset和minOffset；

```java
/**
 * DefaultMessageStore的方法
 * <p>
 * 从给定偏移量开始，在queueId中最多查询属于topic的最多maxMsgNums条消息。
 * 获取的消息将使用提供的消息过滤器messageFilter进行进一步筛选。
 *
 * @param group         所属消费者组
 * @param topic         查询的topic
 * @param queueId       查询的queueId
 * @param offset        起始逻辑偏移量
 * @param maxMsgNums    要查询的最大消息数，默认32
 * @param messageFilter 用于筛选所需消息的消息过滤器
 * @return 匹配的消息
 */
public GetMessageResult getMessage(final String group, final String topic, final int queueId, final long offset,
                                   final int maxMsgNums,
                                   final MessageFilter messageFilter) {
   
     
    /*
     * 1 前置校验
     */
    if (this.shutdown) {
   
     
        log.warn("message store has shutdown, so getMessage is forbidden");
        return null;
    }

    if (!this.runningFlags.isReadable()) {
   
     
        log.warn("message store is not readable, so getMessage is forbidden " + this.runningFlags.getFlagBits());
        return null;
    }

    if (MixAll.isLmq(topic) && this.isLmqConsumeQueueNumExceeded()) {
   
     
        log.warn("message store is not available, broker config enableLmq and enableMultiDispatch, lmq consumeQueue num exceed maxLmqConsumeQueueNum config num");
        return null;
    }
    //起始时间
    long beginTime = this.getSystemClock().now();
    //拉取消息的状态，默认为 队列里没有消息
    GetMessageStatus status = GetMessageStatus.NO_MESSAGE_IN_QUEUE;
    //下次拉取的consumeQueue的起始逻辑偏移量
    long nextBeginOffset = offset;
    long minOffset = 0;
    long maxOffset = 0;

    // lazy init when find msg.
    GetMessageResult getResult = null;
    //获取commitLog的最大物理偏移量
    final long maxOffsetPy = this.commitLog.getMaxOffset();
    /*
     * 根据topic和队列id确定需要写入的ConsumeQueue
     */
    ConsumeQueue consumeQueue = findConsumeQueue(topic, queueId);
    if (consumeQueue != null) {
   
     
        /*
         * 2 偏移量校验
         */
        //获取consumeQueue的最小和最大的逻辑偏移量offset
        minOffset = consumeQueue.getMinOffsetInQueue();
        maxOffset = consumeQueue.getMaxOffsetInQueue();
        if (maxOffset == 0) {
   
     
            //最大的逻辑偏移量offset为0，表示消息队列无消息，设置NO_MESSAGE_IN_QUEUE
            status = GetMessageStatus.NO_MESSAGE_IN_QUEUE;
            //矫正下一次拉取的开始偏移量，如果broker不是SLAVE节点，或者是SLAVE节点但是从服务器支持offset检查，则为0
            nextBeginOffset = nextOffsetCorrection(offset, 0);
        } else if (offset < minOffset) {
   
     
            //consumer传递的offset小于最小偏移量，表示拉取的位置太小，设置OFFSET_TOO_SMALL
            status = GetMessageStatus.OFFSET_TOO_SMALL;
            //矫正下一次拉取的开始偏移量，如果broker不是SLAVE节点，或者是SLAVE节点但是从服务器支持offset检查，则为minOffset
            nextBeginOffset = nextOffsetCorrection(offset, minOffset);
        } else if (offset == maxOffset) {
   
     
            //consumer传递的offset等于最大偏移量，表示拉取的位置溢出，设置OFFSET_OVERFLOW_ONE
            status = GetMessageStatus.OFFSET_OVERFLOW_ONE;
            //矫正下一次拉取的开始偏移量，还是offset
            nextBeginOffset = nextOffsetCorrection(offset, offset);
        } else if (offset > maxOffset) {
   
     
            //consumer传递的offset大于最大偏移量，表示拉取的位置严重溢出，设置OFFSET_OVERFLOW_BADLY
            status = GetMessageStatus.OFFSET_OVERFLOW_BADLY;
            //如果最小偏移量为0
            if (0 == minOffset) {
   
     
                //矫正下一次拉取的开始偏移量，如果broker不是SLAVE节点，或者是SLAVE节点但是从服务器支持offset检查，则为minOffset
                nextBeginOffset = nextOffsetCorrection(offset, minOffset);
            } else {
   
     
                //矫正下一次拉取的开始偏移量，如果broker不是SLAVE节点，或者是SLAVE节点但是从服务器支持offset检查，则为maxOffset
                nextBeginOffset = nextOffsetCorrection(offset, maxOffset);
            }
        }
        //consumer传递的offset大于等于minOffset，且小于maxOffset，表示偏移量在正常范围内
        else {
   
     
            /*
             * 3 根据逻辑offset定位到物理偏移量，然后截取该偏移量之后的一段Buffer，其包含要拉取的消息的索引数据及对应consumeQueue文件之后的全部索引数据。
             * 一条consumeQueue索引默认固定长度20B，这里截取的Buffer可能包含多条索引数据，但是一定包含将要拉取的下一条数据。
             */
            SelectMappedBufferResult bufferConsumeQueue = consumeQueue.getIndexBuffer(offset);
            //如果截取到了缓存区数据，那么从Buffer中检查索引数据以及查找commitLog中的消息数据
            if (bufferConsumeQueue != null) {
   
     
                try {
   
     
                    //先设置为NO_MATCHED_MESSAGE
                    status = GetMessageStatus.NO_MATCHED_MESSAGE;
                    //下一个commitLog文件的起始物理偏移量，默认从Long.MIN_VALUE开始
                    //用来记录上一次循环的时候时候是否换到了下一个commitLog文件
                    long nextPhyFileStartOffset = Long.MIN_VALUE;
                    //本次消息拉取的最大物理偏移量
                    long maxPhyOffsetPulling = 0;

                    int i = 0;
                    //每次最大的过滤消息字节数，一般为16000/20 = 800 条
                    final int maxFilterMessageCount = Math.max(16000, maxMsgNums * ConsumeQueue.CQ_STORE_UNIT_SIZE);
                    //是否需要记录commitLog磁盘的剩余可拉取的消息字节数，默认true
                    final boolean diskFallRecorded = this.messageStoreConfig.isDiskFallRecorded();
                    //创建拉取结果对象
                    getResult = new GetMessageResult(maxMsgNums);
                    //存储单元
                    ConsumeQueueExt.CqExtUnit cqExtUnit = new ConsumeQueueExt.CqExtUnit();
                    /*
                     * 4 循环遍历截取的buffer，处理每一条ConsumeQueue索引，拉取消息，ConsumeQueue消息固定长度20字节，因此每次移动20B的长度
                     */
                    for (; i < bufferConsumeQueue.getSize() && i < maxFilterMessageCount; i += ConsumeQueue.CQ_STORE_UNIT_SIZE) {
   
     
                        //消息在CommitLog中的物理偏移量
                        long offsetPy = bufferConsumeQueue.getByteBuffer().getLong();
                        //消息大小
                        int sizePy = bufferConsumeQueue.getByteBuffer().getInt();
                        //延迟消息就是消息投递时间，其他消息就是消息的tags的hashCode，即生产者发送消息时设置的tags
                        //消费数据时，可以通过对比消费者设置的过滤信息来匹配消息
                        long tagsCode = bufferConsumeQueue.getByteBuffer().getLong();
                        //更新maxPhyOffsetPulling为当前消息在CommitLog中的物理偏移量
                        maxPhyOffsetPulling = offsetPy;
                        //如果nextPhyFileStartOffset不为Long.MIN_VALUE，并且offsetPy 小于 nextPhyFileStartOffset那
                        //表示切换到了下一个commitLog文件，并且当前偏移量下一该文件最小偏移量，那么跳过该消息的处理
                        if (nextPhyFileStartOffset != Long.MIN_VALUE) {
   
     
                            if (offsetPy < nextPhyFileStartOffset)
                                continue;
                        }
                        /*
                         * 4.1 检查要拉取的消息是否在磁盘上
                         */
                        boolean isInDisk = checkInDiskByCommitOffset(offsetPy, maxOffsetPy);

                        /*
                         * 4.2 判断消息拉取是否达到上限，如果达到上限，则跳出循环，结束消息的拉取
                         */
                        if (this.isTheBatchFull(sizePy, maxMsgNums, getResult.getBufferTotalSize(), getResult.getMessageCount(),
                                isInDisk)) {
   
     
                            break;
                        }

                        //额外信息判断，一般没有
                        boolean extRet = false, isTagsCodeLegal = true;
                        if (consumeQueue.isExtAddr(tagsCode)) {
   
     
                            extRet = consumeQueue.getExt(tagsCode, cqExtUnit);
                            if (extRet) {
   
     
                                tagsCode = cqExtUnit.getTagsCode();
                            } else {
   
     
                                // can't find ext content.Client will filter messages by tag also.
                                log.error("[BUG] can't find consume queue extend file content!addr={}, offsetPy={}, sizePy={}, topic={}, group={}",
                                        tagsCode, offsetPy, sizePy, topic, group);
                                isTagsCodeLegal = false;
                            }
                        }
                        /*
                         * 4.3 通过messageFilter#isMatchedByConsumeQueue方法执行消息tagsCode过滤
                         * tagsCode在ConsumeQueue中保存着，因此基于ConsumeQueue条目就能执行broker端的TAG过滤
                         */
                        if (messageFilter != null
                                && !messageFilter.isMatchedByConsumeQueue(isTagsCodeLegal ? tagsCode : null, extRet ? cqExtUnit : null)) {
   
     
                            //如果过滤没通过，并且已拉取的消息总大小为0，则设置为NO_MATCHED_MESSAGE状态
                            if (getResult.getBufferTotalSize() == 0) {
   
     
                                status = GetMessageStatus.NO_MATCHED_MESSAGE;
                            }
                            //跳过该索引条目，拉取下一个索引条目
                            continue;
                        }
                        /*
                         * 4.4 TAG校验通过，调用commitLog#getMessage方法根据消息的物理偏移量和消息大小获取该索引对应的真正的消息
                         * 索引里面包含了消息的物理偏移量和消息大小，因此能够从commitLog中获取真正的消息所在的内存，而消息的格式是固定的，因此能够解析出里面的数据
                         */
                        SelectMappedBufferResult selectResult = this.commitLog.getMessage(offsetPy, sizePy);
                        //没有找到消息，表示该偏移量可能到达了文件末尾，消息存放在下一个commitLog文件中
                        if (null == selectResult) {
   
     
                            if (getResult.getBufferTotalSize() == 0) {
   
     
                                status = GetMessageStatus.MESSAGE_WAS_REMOVING;
                            }
                            //nextPhyFileStartOffset设置为下一个commitLog文件的起始物理偏移量，并跳过本次拉取
                            nextPhyFileStartOffset = this.commitLog.rollNextFile(offsetPy);
                            continue;
                        }
                        /*
                         * 4.5 找到了消息，继续通过messageFilter#isMatchedByCommitLog方法执行消息SQL92 过滤
                         * SQL92 过滤依赖于消息中的属性，而消息体的内容存放在commitLog中的，因此需要先拉取到消息，在进行SQL92过滤
                         */
                        if (messageFilter != null
                                && !messageFilter.isMatchedByCommitLog(selectResult.getByteBuffer().slice(), null)) {
   
     
                            if (getResult.getBufferTotalSize() == 0) {
   
     
                                status = GetMessageStatus.NO_MATCHED_MESSAGE;
                            }
                            // release...
                            //过滤不通过，释放这一段内存，并跳过本次拉取
                            selectResult.release();
                            continue;
                        }
                        //传输的单条消息数量自增1，用于控制台展示
                        this.storeStatsService.getGetMessageTransferedMsgCount().add(1);
                        /*
                         * 4.6 TAG和SQL92校验通过，那么将消息存入getResult，注意存入的是一段
                         */
                        getResult.addMessage(selectResult);
                        //更改status
                        status = GetMessageStatus.FOUND;
                        //nextPhyFileStartOffset重新置为Long.MIN_VALUE，继续下一次循环
                        nextPhyFileStartOffset = Long.MIN_VALUE;
                    }
                    //如果需要记录commitLog磁盘的剩余可拉取的消息字节数，默认true
                    if (diskFallRecorded) {
   
     
                        //磁盘最大物理偏移量 - 本次消息拉取的最大物理偏移量 = 剩余的commitLog磁盘可拉取的消息字节数
                        long fallBehind = maxOffsetPy - maxPhyOffsetPulling;
                        //记录剩余的commitLog磁盘可拉取的消息字节数
                        brokerStatsManager.recordDiskFallBehindSize(group, topic, queueId, fallBehind);
                    }
                    /*
                     * 5 计算下一次读取数据的ConsumeQueue的开始偏移量，判断是否建议下一次从SLAVE broker中拉取消息
                     */
                    //计算下一次读取数据的ConsumeQueue的开始偏移量
                    nextBeginOffset = offset + (i / ConsumeQueue.CQ_STORE_UNIT_SIZE);
                    //磁盘最大物理偏移量 - 本次消息拉取的最大物理偏移量  = 剩余的commitLog磁盘可拉取的消息字节数
                    long diff = maxOffsetPy - maxPhyOffsetPulling;
                    //broker服务最大可使用物理内存
                    long memory = (long) (StoreUtil.TOTAL_PHYSICAL_MEMORY_SIZE
                            * (this.messageStoreConfig.getAccessMessageInMemoryMaxRatio() / 100.0));
                    //如果剩余的commitLog磁盘可拉取的消息字节数 大于 broker服务最大可使用物理内存，那么设置建议下一次从SLAVE broker中拉取消息
                    getResult.setSuggestPullingFromSlave(diff > memory);
                } finally {
   
     
                    //截取的buffer内存释放
                    bufferConsumeQueue.release();
                }
            } else {
   
     
                //没获取到缓存buffer，可能是到达了当前consumeQueue文件的尾部
                status = GetMessageStatus.OFFSET_FOUND_NULL;
                //nextBeginOffset设置为consumeQueue的下一个文件的起始偏移量
                nextBeginOffset = nextOffsetCorrection(offset, consumeQueue.rollNextFile(offset));
                log.warn("consumer request topic: " + topic + "offset: " + offset + " minOffset: " + minOffset + " maxOffset: "
                        + maxOffset + ", but access logic queue failed.");
            }
        }
    } else {
   
     
        //没找到consumeQueue
        status = GetMessageStatus.NO_MATCHED_LOGIC_QUEUE;
        //nextBeginOffset设置为0
        nextBeginOffset = nextOffsetCorrection(offset, 0);
    }

    if (GetMessageStatus.FOUND == status) {
   
     
        //找到了消息，那么拉取到的次数统计字段getMessageTimesTotalFound+1，用于控制台展示
        //broker中的tps只计算拉取次数，而非拉取的消息条数，默认情况下pushConsumer一次拉取32条
        this.storeStatsService.getGetMessageTimesTotalFound().add(1);
    } else {
   
     
        //未找到消息，那么未拉取到的次数统计字段getMessageTimesTotalMiss+1，用于控制台展示
        this.storeStatsService.getGetMessageTimesTotalMiss().add(1);
    }
    //计算本次拉取消耗的时间
    long elapsedTime = this.getSystemClock().now() - beginTime;
    //尝试比较并更新最长的拉取消息的时间字段getMessageEntireTimeMax
    this.storeStatsService.setGetMessageEntireTimeMax(elapsedTime);

    // lazy init no data found.
    if (getResult == null) {
   
     
        //没找到消息的情况，延迟初始化GetMessageResult，设置拉去结果为0
        getResult = new GetMessageResult(0);
    }
    /*
     * 6 设置getResult的属性并返回
     */
    //设置拉取状态
    getResult.setStatus(status);
    //设置下次拉取的consumeQueue的起始逻辑偏移量
    getResult.setNextBeginOffset(nextBeginOffset);
    //设置consumeQueue的最小、最大的逻辑偏移量offset
    getResult.setMaxOffset(maxOffset);
    getResult.setMinOffset(minOffset);
    return getResult;
}
```

#### 2.1.1 nextOffsetCorrection矫正下一次拉取偏移量

如果broker不是SLAVE节点，或者是SLAVE节点但是从服务器支持offset检查，那没返回broker设置的offset，否则还是返回consumer传递的offset。

```java
/**
 * DefaultMessageStore的方法
 * 校正下一个偏移量
 *
 * @param oldOffset consumer传递的offset
 * @param newOffset broker设置的offset
 * @return
 */
private long nextOffsetCorrection(long oldOffset, long newOffset) {
   
     
    //首先设置为consumer传递的offset
    long nextOffset = oldOffset;
    //如果broker不是SLAVE节点，或者是SLAVE节点但是从服务器支持offset检查
    if (this.getMessageStoreConfig().getBrokerRole() != BrokerRole.SLAVE || this.getMessageStoreConfig().isOffsetCheckInSlave()) {
   
     
        //设置为新的offset
        nextOffset = newOffset;
    }
    return nextOffset;
}
```

#### 2.1.2 getIndexBuffer获取索引数据buffer

consumer传递的offset大于等于minOffset，且小于maxOffset，表示偏移量在正常范围内。

那么根据逻辑offset定位到物理偏移量，然后定位到所属的consumeQueue文件对应的MappedFile，然后从该MappedFile截取一段Buffer，其包含从要拉取的消息的索引数据开始其后的全部索引数据。

一条consumeQueue索引默认固定长度20B，这里截取的Buffer可能包含多条索引数据，但是一定包含将要拉取的下一条数据。

```java
/**
 * ConsumeQueue的方法
 *
 * 根据逻辑offset定位到物理偏移量，然后截取缓冲区，包含要拉取的消息的索引数据及其MappedFile之后的全部数据
 * @param startIndex 起始逻辑偏移量
 * @return 截取的索引缓存区
 */
public SelectMappedBufferResult getIndexBuffer(final long startIndex) {
   
     
    int mappedFileSize = this.mappedFileSize;
    //物理偏移量
    long offset = startIndex * CQ_STORE_UNIT_SIZE;
    //如果大于ConsumeQueue的最小物理偏移量
    if (offset >= this.getMinLogicOffset()) {
   
     
        //根据物理偏移量查找ConsumeQueue文件对应的MappedFile
        MappedFile mappedFile = this.mappedFileQueue.findMappedFileByOffset(offset);
        if (mappedFile != null) {
   
     
            //从该MappedFile中截取一段ByteBuffer，这段内存存储着将要拉取的消息的索引数据及其之后的全部数据
            SelectMappedBufferResult result = mappedFile.selectMappedBuffer((int) (offset % mappedFileSize));
            return result;
        }
    }
    return null;
}
```

#### 2.1.3 checkInDiskByCommitOffset检查消息是否在磁盘上

获取broker最大可用内存，默认为机器物理最大可用内存 * 40/100 ，即broker最大可用内存为最大物理内存的百分之40。

如果commitLog中的最大物理偏移量 - 拉取的消息在commitLog中的物理偏移量的差值大于获取broker最大可用内存，那么任务数据已经在磁盘上了，否则认为还在内存中。

```java
/**
 * DefaultMessageStore的方法
 * <p>
 * 检查消息是否在磁盘上
 *
 * @param offsetPy    拉取的消息在commitLog中的物理偏移量
 * @param maxOffsetPy commitLog中的最大物理偏移量
 * @return 是否在磁盘中
 */
private boolean checkInDiskByCommitOffset(long offsetPy, long maxOffsetPy) {
   
     
    //获取broker最大可用内存，默认为 机器物理最大可用内存 * 40/100 ， 即broker最大可用内存为最大物理内存的百分之40
    long memory = (long) (StoreUtil.TOTAL_PHYSICAL_MEMORY_SIZE * (this.messageStoreConfig.getAccessMessageInMemoryMaxRatio() / 100.0));
    //如果commitLog中的最大物理偏移量 - 拉取的消息在commitLog中的物理偏移量 的差值大于获取broker最大可用内存，那么任务数据已经在磁盘上了，否则认为还在内存中
    return (maxOffsetPy - offsetPy) > memory;
}
```

**注意到这里有个StoreUtil.TOTAL_PHYSICAL_MEMORY_SIZE常量，它实际上是保存着当前服务器上以字节为单位的物理内存总量。**

**内部的ManagementFactory以及getTotalPhysicalMemorySize方法都是JDK提供的，可以了解下，算是涨涨见识，Java中是可以直接获取到服务器的物理内存总量的。
**

```java
public class StoreUtil {
   
     
    public static final long TOTAL_PHYSICAL_MEMORY_SIZE = getTotalPhysicalMemorySize();

    /**
     * 固定的方法
     *
     * @return 获取当前服务器上以字节为单位的物理内存总量
     */
    @SuppressWarnings("restriction")
    public static long getTotalPhysicalMemorySize() {
   
     
        long physicalTotal = 1024 * 1024 * 1024 * 24L;
        OperatingSystemMXBean osmxb = ManagementFactory.getOperatingSystemMXBean();
        if (osmxb instanceof com.sun.management.OperatingSystemMXBean) {
   
     
            physicalTotal = ((com.sun.management.OperatingSystemMXBean) osmxb).getTotalPhysicalMemorySize();
        }

        return physicalTotal;
    }
}
```

#### 2.1.4 isTheBatchFull判断消息拉取上限

该方法判断消息拉取是否达到上限，如果达到上限，则跳出循环，结束消息的拉取。

**1、** 如果已拉取的消息总大小或者已拉取的消息总数量还是0，则返回false表示还没有拉取到消息；
**2、** 如果要查询的最大消息数（默认32）小于等于已拉取的消息总数量，则返回true表示拉取数量达到了阈值；
**3、** 如果当前消息在磁盘中:；

**1、** 如果已拉取消息字节数+待拉取的当前消息的字节大小大于maxTransferBytesOnMessageInDisk=64KB，则返回true表示从磁盘上拉取消息的大小超过了阈值64KB；
**2、** 如果已拉取的消息总数量>maxTransferCountOnMessageInDisk-1=8-1，则返回true表示从磁盘上拉取消息的数量超过了阈值8条；
**4、** 如果当前消息在内存中:；

**1、** 如果已拉取消息字节数+待拉取的当前消息的字节大小大于maxTransferBytesOnMessageInMemory=256KB，则返回true表示从内存中拉取消息的大小超过了阈值256KB；
**2、** 如果已拉取的消息总数量>maxTransferCountOnMessageInMemory-1=32-1，则返回true表示从磁盘上拉取消息的数量超过了阈值32条；

```java
/**
 * DefaultMessageStore的方法
 * <p>
 * 判断是否达到了消息拉取的上限
 *
 * @param sizePy       本次消息字节大小，
 * @param maxMsgNums   要查询的最大消息数，默认32
 * @param bufferTotal  已拉取的消息总大小
 * @param messageTotal 已拉取的消息总数量
 * @param isInDisk     本次消息是否在磁盘上
 * @return 是否达到了消息拉取的上限
 */
private boolean isTheBatchFull(int sizePy, int maxMsgNums, int bufferTotal, int messageTotal, boolean isInDisk) {
   
     

    //如果已拉取的消息总大小或者已拉取的消息总数量还是0，则返回false
    //表示还没有拉取到消息
    if (0 == bufferTotal || 0 == messageTotal) {
   
     
        return false;
    }
    //如果要查询的最大消息数（默认32） 小于等于 已拉取的消息总数量，则返回true
    //表示拉取数量达到了阈值
    if (maxMsgNums <= messageTotal) {
   
     
        return true;
    }
    //如果当前消息在磁盘中
    if (isInDisk) {
   
     
        //如果已拉取消息字节数 + 待拉取的当前消息的字节大小 大于 maxTransferBytesOnMessageInDisk = 64KB ，则返回true
        //表示从磁盘上拉取消息的大小超过了阈值64KB
        if ((bufferTotal + sizePy) > this.messageStoreConfig.getMaxTransferBytesOnMessageInDisk()) {
   
     
            return true;
        }
        //如果已拉取的消息总数量 > maxTransferCountOnMessageInDisk - 1= 8 - 1，则返回true
        //表示从磁盘上拉取消息的数量超过了阈值8条
        if (messageTotal > this.messageStoreConfig.getMaxTransferCountOnMessageInDisk() - 1) {
   
     
            return true;
        }
    }
    //如果当前消息在内存中
    else {
   
     
        //如果已拉取消息字节数 + 待拉取的当前消息的字节大小 大于 maxTransferBytesOnMessageInMemory = 256KB ，则返回true
        //表示从内存中拉取消息的大小超过了阈值256KB
        if ((bufferTotal + sizePy) > this.messageStoreConfig.getMaxTransferBytesOnMessageInMemory()) {
   
     
            return true;
        }
        //如果已拉取的消息总数量 > maxTransferCountOnMessageInMemory - 1= 32 - 1，则返回true
        //表示从磁盘上拉取消息的数量超过了阈值32条
        if (messageTotal > this.messageStoreConfig.getMaxTransferCountOnMessageInMemory() - 1) {
   
     
            return true;
        }
    }

    return false;
}
```

#### 2.1.5 isMatchedByConsumeQueue执行broker消息过滤

**对于ConsumeQueue的条目，通过tagsCode或bitmap filter进行tagsCode匹配。**

**对于普通消息来说，tagsCode就是的tags的hashCode，这里的tags是生产者发送消息时设置的（对于延迟消息就是消息投递时间，后面会讲到）。
**

**而在消费者启动的时候，订阅topic的时候需要传递subExpression参数，它仅支持或操作，如“tag1 | | tag2 | | tag3”表示多个tag，如果为
null 或
\*，则表示订阅全部。subExpression在客户端会被解析，然后对于每一个tag，会计算他们的tagsCode，并存入subscriptionData的codeSet集合中。而subscriptionData会随着心跳信息上报给broker缓存起来。
**

**在消费者拉取消息的时候，就会判断该消息的tagsCode是否存在于subscriptionData的codeSet集合中，如果存在，则表示消费者订阅的tag和生产者生产该消息时设置的tag匹配，那么表示该消费者可以消费这个消息。
**

**以上就是broker端的消息过滤，他们比较的是tagsCode的值，即hashcode值。**

```java
/**
 * ExpressionMessageFilter的方法
 * <p>
 * 对于ConsumeQueue条目，通过tagsCode或bitmap filter进行tagsCode匹配
 *
 * @param tagsCode  tagsCode，延迟消息就是消息投递时间，普通消息的tags的hashCode，即生产者发送消息时设置的tags
 * @param cqExtUnit 扩展消费队列单元，一般为null
 * @return
 */
@Override
public boolean isMatchedByConsumeQueue(Long tagsCode, ConsumeQueueExt.CqExtUnit cqExtUnit) {
   
     
    //如果订阅信息对象为null，则返回true
    if (null == subscriptionData) {
   
     
        return true;
    }
    //如果是classFilter模式的过滤，则返回true
    if (subscriptionData.isClassFilterMode()) {
   
     
        return true;
    }

    //如果是TAG类型的过滤子表达式
    if (ExpressionType.isTagType(subscriptionData.getExpressionType())) {
   
     
        //如果tagsCode为null，则返回true
        if (tagsCode == null) {
   
     
            return true;
        }
        //如果订阅表达式为"*"，即表示订阅所有消息，那么返回true
        if (subscriptionData.getSubString().equals(SubscriptionData.SUB_ALL)) {
   
     
            return true;
        }
        //如果订阅关系对象的codeSet集合包含tagsCode值，表示子表达式订阅了该tag的消息，返回true，否则返回false
        return subscriptionData.getCodeSet().contains(tagsCode.intValue());
    } else {
   
     
        //如果不是TAG类型，需要依靠BloomFilter，布隆过滤器来实现过滤
// 省略
    }

    return true;
}
```

#### 2.1.6 getMessage获取消息buffer

调用commitLog#getMessage方法根据消息的物理偏移量和消息大小获取该索引对应的真正的消息所属的一段内存。

首先调用findMapedFileByOffset根据offset找到其所属的CommitLog文件对应的MappedFile，该方法在broker消息刷盘的源码部分已经讲过了。然后该mappedFile的起始偏移量pos，从pos开始截取size大小的一段buffer内存返回。

```java
/**
 * CommitLog的方法
 * <p>
 * 根据消息的物理偏移量和消息大小截取消息所属的一段内存
 *
 * @param offset 消息的物理偏移量
 * @param size 消息大小
 * @return 截取消息所属的一段内存
 */
public SelectMappedBufferResult getMessage(final long offset, final int size) {
   
     
    //获取CommitLog文件大小，默认1G
    int mappedFileSize = this.defaultMessageStore.getMessageStoreConfig().getMappedFileSizeCommitLog();
    //根据offset找到其所属的CommitLog文件对应的MappedFile
    MappedFile mappedFile = this.mappedFileQueue.findMappedFileByOffset(offset, offset == 0);
    if (mappedFile != null) {
   
     
        //该mappedFile的起始偏移量
        int pos = (int) (offset % mappedFileSize);
        //从pos开始截取size大小的一段buffer内存
        return mappedFile.selectMappedBuffer(pos, size);
    }
    return null;
}
```

#### 2.1.7 addMessage添加消息

添加消息buffer到GetMessageResult中。

注意这里仅仅是添加字节buffer序列，并且直接返回给Consumer，没有反序列化为Message对象，Consumer收到消息之后，会按照CommitLog消息序列化格式自行反序列化为Message对象。

```java
/**
 * GetMessageResult的方法
 * <p>
 * 添加消息
 *
 * @param mapedBuffer 消息buffer
 */
public void addMessage(final SelectMappedBufferResult mapedBuffer) {
   
     
    //mapedBuffer加入到集合中
    this.messageMapedList.add(mapedBuffer);
    //byteBuffer加入到集合中
    this.messageBufferList.add(mapedBuffer.getByteBuffer());
    //已拉取的消息总大小加上当前消息的大小
    this.bufferTotalSize += mapedBuffer.getSize();
    this.msgCount4Commercial += (int) Math.ceil(
            mapedBuffer.getSize() / BrokerStatsManager.SIZE_PER_COUNT);
}
```

### 2.2 suspendPullRequest挂起PullRequest

**当没有读取到消息，如果broker允许挂起请求并且客户端支持请求挂起，则broker挂起该请求一段时间，中间如果有消息到达或者延迟间隔时间到了，则会再次尝试拉取消息。
**

**这里要求brokerAllowSuspend为true，新的拉取请求为true，但是已被suspend的请求将会是false，即尝试重试拉取的请求如果再拉取不到消息则不会再被挂起。
**

**broker最长的挂起时间，默认15s，该参数是消费者传递的，但是如果broker不支持长轮询（默认都是支持的），那么使用短轮询，即最长的挂起时间设置为1s。
**

*
*该方法suspendPullRequest，仅仅是将pullRequest及其对应关系存入到PullRequestHoldService的内部pullRequestTable集合中，并没有执行后续逻辑，但是并没有其他逻辑，那么这里的挂起以及后续操作如何实现的呢？实际上PullRequestHoldService是一个ServiceThread的子类，那么很明显它是一个单线程任务，而后续的延迟处理操作都是在该线程任务中实现。
**

```java
/**
 * PullRequestHoldService的方法
 * <p>
 * 挂起请求，将请求存入pullRequestTable
 *
 * @param topic       请求的topic
 * @param queueId     请求的队列id
 * @param pullRequest 拉取请求
 */
public void suspendPullRequest(final String topic, final int queueId, final PullRequest pullRequest) {
   
     
    //构建key： topic@queueId
    String key = this.buildKey(topic, queueId);
    //从缓存里面尝试获取该key的值ManyPullRequest
    //ManyPullRequest是包含多个pullRequest的对象，内部有一个集合
    ManyPullRequest mpr = this.pullRequestTable.get(key);
    if (null == mpr) {
   
     
        mpr = new ManyPullRequest();
        ManyPullRequest prev = this.pullRequestTable.putIfAbsent(key, mpr);
        if (prev != null) {
   
     
            mpr = prev;
        }
    }
    //存入ManyPullRequest内部的pullRequestList集合中
    mpr.addPullRequest(pullRequest);
}
```

#### 2.2.1 run处理挂起请求

在一个循环中执行阻塞以及检测操作。

在循环中首先阻塞线程，将会定时唤醒，或者broker有新消息到达唤醒，如果支持长轮询，那么最长等待5s，否则等待shortPollingTimeMills，默认1s。

线程醒来之后，继续执行checkHoldRequest方法，该方法就是核心方法，将检测pullRequestTable中的挂起的请求，如果有新消息到达则执行拉取操作。

```java
/**
 * PullRequestHoldService的方法
 * 处理挂起请求
 */
@Override
public void run() {
   
     
    log.info("{} service started", this.getServiceName());
    /*
     * 运行时逻辑
     * 如果服务没有停止，则正常执行操作
     */
    while (!this.isStopped()) {
   
     
        try {
   
     
            /*
             * 1 阻塞线程
             * 定时唤醒，或者broker有新消息到达唤醒
             */
            //如果支持长轮询
            if (this.brokerController.getBrokerConfig().isLongPollingEnable()) {
   
     
                //那么最长等待5s
                this.waitForRunning(5 * 1000);
            } else {
   
     
                //否则等待shortPollingTimeMills，默认1s
                this.waitForRunning(this.brokerController.getBrokerConfig().getShortPollingTimeMills());
            }
            //醒了之后继续后面的逻辑
            long beginLockTimestamp = this.systemClock.now();
            /*
             * 2 检测pullRequestTable中的挂起的请求，如果有新消息到达则执行拉取操作
             */
            this.checkHoldRequest();
            long costTime = this.systemClock.now() - beginLockTimestamp;
            if (costTime > 5 * 1000) {
   
     
                log.info("[NOTIFYME] check hold request cost {} ms.", costTime);
            }
        } catch (Throwable e) {
   
     
            log.warn(this.getServiceName() + " service has exception. ", e);
        }
    }

    log.info("{} service end", this.getServiceName());
}
```

#### 2.2.2 checkHoldRequest检测挂起请求

该方法将会遍历pullRequestTable中所有的挂起的请求，然后对所有的请求执行notifyMessageArriving尝试拉取消息的操作。

```java
/**
 * PullRequestHoldService的方法
 * <p>
 * 检测pullRequestTable中的挂起的请求，如果有新消息到达则执行拉取操作
 */
protected void checkHoldRequest() {
   
     
    //遍历pullRequestTable
    for (String key : this.pullRequestTable.keySet()) {
   
     
        String[] kArray = key.split(TOPIC_QUEUEID_SEPARATOR);
        if (2 == kArray.length) {
   
     
            String topic = kArray[0];
            int queueId = Integer.parseInt(kArray[1]);
            //获取指定consumeQueue的最大的逻辑偏移量offset
            final long offset = this.brokerController.getMessageStore().getMaxOffsetInQueue(topic, queueId);
            try {
   
     
                //调用notifyMessageArriving方法，尝试通知消息到达
                this.notifyMessageArriving(topic, queueId, offset);
            } catch (Throwable e) {
   
     
                log.error("check hold request failed. topic={}, queueId={}", topic, queueId, e);
            }
        }
    }
}
```

#### 2.2.3 notifyMessageArriving通知消息到达

该方法用于尝试通知消息到达，但是不一定真的到达了，可能是因为阻塞到期被唤醒而调用。

**1、** 构建key：topic@queueId从缓存里面尝试获取该key的值ManyPullRequest，ManyPullRequest是包含多个pullRequest的对象，内部有一个相同请求的集合；
**2、** 遍历集合中所有挂起的请求；

**1、** 如果最大偏移量小于等于需要拉取的offset，那么再次获取consumeQueue的最大的逻辑偏移量offset；
**2、** 如果最大偏移量大于需要拉取的offset，那么可以尝试拉取；

```
    1.  通过MessageFilter\#isMatchedByConsumeQueue方法，执行消息tagsCode过滤，如果是定时唤醒，由于tagsCode参数为null，那么一定返回true。
    2.  如果消息匹配过滤条件。通过PullMessageProcessor\#executeRequestWhenWakeup重新执行拉取操作。随后结束本次循环。
3.  如果request等待超时，那么还是会通过PullMessageProcessor\#executeRequestWhenWakeup重新执行一次拉取操作。随后结束本次循环。
```

**4、** 不符合条件并且没有超时的request，重新放回replayList集合中，继续挂起；
**3、** 将replayList集合中，继续挂起的request重新放入pullRequestTable；

```java
/**
 * PullRequestHoldService的方法
 * 通知消息到达
 *
 * @param topic     请求的topic
 * @param queueId   请求的队列id
 * @param maxOffset consumeQueue的最大的逻辑偏移量offset
 */
public void notifyMessageArriving(final String topic, final int queueId, final long maxOffset) {
   
     
    notifyMessageArriving(topic, queueId, maxOffset, null, 0, null, null);
}

/**
 * PullRequestHoldService的方法
 * 通知消息到达，除了PullRequestHoldService服务定时调用之外，reputMessageService服务发现新消息时可能也会调用该方法
 *
 * @param topic        请求的topic
 * @param queueId      请求的队列id
 * @param maxOffset    consumeQueue的最大的逻辑偏移量offset
 * @param tagsCode     消息的tag的hashCode，注意，如果是定时唤醒，该参数为null
 * @param msgStoreTime 消息存储时间，注意，如果是定时唤醒，该参数为0
 * @param filterBitMap 过滤bitMap，注意，如果是定时唤醒，该参数为null
 * @param properties   参数，注意，如果是定时唤醒，该参数为null
 */
public void notifyMessageArriving(final String topic, final int queueId, final long maxOffset, final Long tagsCode,
                                  long msgStoreTime, byte[] filterBitMap, Map<String, String> properties) {
   
     
    //构建key： topic@queueId
    String key = this.buildKey(topic, queueId);
    //从缓存里面尝试获取该key的值ManyPullRequest
    //ManyPullRequest是包含多个pullRequest的对象，内部有一个集合
    ManyPullRequest mpr = this.pullRequestTable.get(key);
    //如果有对应的拉取请求被阻塞，即指定topic以及指定queueId
    if (mpr != null) {
   
     
        //获取所有的挂起请求集合
        List<PullRequest> requestList = mpr.cloneListAndClear();
        if (requestList != null) {
   
     
            List<PullRequest> replayList = new ArrayList<PullRequest>();
            //遍历挂起的请求
            for (PullRequest request : requestList) {
   
     
                long newestOffset = maxOffset;
                //如果最大偏移量小于等于需要拉取的offset，那么再次获取consumeQueue的最大的逻辑偏移量offset
                if (newestOffset <= request.getPullFromThisOffset()) {
   
     
                    newestOffset = this.brokerController.getMessageStore().getMaxOffsetInQueue(topic, queueId);
                }
                //如果最大偏移量大于需要拉取的offset，那么可以尝试拉取
                if (newestOffset > request.getPullFromThisOffset()) {
   
     
                    /*
                     * 执行消息tagsCode过滤，如果是定时唤醒，由于tagsCode参数为null，那么一定返回true
                     */
                    boolean match = request.getMessageFilter().isMatchedByConsumeQueue(tagsCode,
                            new ConsumeQueueExt.CqExtUnit(tagsCode, msgStoreTime, filterBitMap));
                    // match by bit map, need eval again when properties is not null.
                    if (match && properties != null) {
   
     
                        match = request.getMessageFilter().isMatchedByCommitLog(null, properties);
                    }
                    //如果消息匹配过滤条件
                    if (match) {
   
     
                        try {
   
     
                            /*
                             * 通过PullMessageProcessor#executeRequestWhenWakeup重新执行拉取操作
                             */
                            this.brokerController.getPullMessageProcessor().executeRequestWhenWakeup(request.getClientChannel(),
                                    request.getRequestCommand());
                        } catch (Throwable e) {
   
     
                            log.error("execute request when wakeup failed.", e);
                        }
                        continue;
                    }
                }
                //如果request等待超时，那么还是会通过PullMessageProcessor#executeRequestWhenWakeup重新执行一次拉取操作
                if (System.currentTimeMillis() >= (request.getSuspendTimestamp() + request.getTimeoutMillis())) {
   
     
                    try {
   
     
                        this.brokerController.getPullMessageProcessor().executeRequestWhenWakeup(request.getClientChannel(),
                                request.getRequestCommand());
                    } catch (Throwable e) {
   
     
                        log.error("execute request when wakeup failed.", e);
                    }
                    continue;
                }
                /*
                 * 不符合条件并且没有超时的request，重新放回replayList集合中，继续挂起
                 */
                replayList.add(request);
            }
            //将还需要继续挂起request返回去
            if (!replayList.isEmpty()) {
   
     
                mpr.addPullRequest(replayList);
            }
        }
    }
}
```

#### 2.2.4 executeRequestWhenWakeup唤醒后执行拉取操作

*
*该方法创建于给线程任务，任务内容就是调用调用processRequest方法拉取消息，注意这里的brokerAllowSuspend参数为false，也就是说，本次请求如果没有拉取到消息，那么不会再挂起，随后将会直接将response写回给客户端。
**

这个线程任务将会被提交到pullMessageExecutor线程池异步的处理的执行。

```java
/**
 * PullMessageProcessor的方法
 * <p>
 * 唤醒后之后拉取操作
 *
 * @param channel
 * @param request
 * @throws RemotingCommandException
 */
public void executeRequestWhenWakeup(final Channel channel, final RemotingCommand request) throws RemotingCommandException {
   
     
    //构建线程任务
    Runnable run = new Runnable() {
   
     
        @Override
        public void run() {
   
     
            try {
   
     
                /*
                 * 再一次调用processRequest方法
                 * 这里的brokerAllowSuspend参数为false，也就是说，本次请求如果没有拉取到消息，那么不会再挂起
                 */
                final RemotingCommand response = PullMessageProcessor.this.processRequest(channel, request, false);

                if (response != null) {
   
     
                    //获取请求id，通过id可以获取请求结果，标记响应状态
                    response.setOpaque(request.getOpaque());
                    response.markResponseType();
                    try {
   
     
                        //将响应写回给客户端
                        channel.writeAndFlush(response).addListener(new ChannelFutureListener() {
   
     
                            @Override
                            public void operationComplete(ChannelFuture future) throws Exception {
   
     
                                if (!future.isSuccess()) {
   
     
                                    log.error("processRequestWrapper response to {} failed", future.channel().remoteAddress(), future.cause());
                                    log.error(request.toString());
                                    log.error(response.toString());
                                }
                            }
                        });
                    } catch (Throwable e) {
   
     
                        log.error("processRequestWrapper process request over, but response failed", e);
                        log.error(request.toString());
                        log.error(response.toString());
                    }
                }
            } catch (RemotingCommandException e1) {
   
     
                log.error("excuteRequestWhenWakeup run", e1);
            }
        }
    };
    //通过pullMessageExecutor线程池异步的处理拉取消息的请求
    this.brokerController.getPullMessageExecutor().submit(new RequestTask(run, channel, request));
}
```

#### 12.2.5 ReputMessageService消息到达通知

**上面的notifyMessageArriving方法，除了因为PullRequestHoldService服务线程定时唤醒而被调用之外，reputMessageService服务发现新消息时可能也会调用该方法。
**

我们此前学习的ReputMessageService异步构建ConsumeQueue和IndexFile的部分，在DefaultMessageStore#doReput对于新的消息执行重放的方法中，有这样一段代码：

```java
//如果broker角色不是SLAVE，并且支持长轮询，并且消息送达的监听器不为null
if (BrokerRole.SLAVE != DefaultMessageStore.this.getMessageStoreConfig().getBrokerRole()
        && DefaultMessageStore.this.brokerConfig.isLongPollingEnable()
        && DefaultMessageStore.this.messageArrivingListener != null) {
   
     
    //通过该监听器的arriving方法触发调用pullRequestHoldService的pullRequestHoldService方法
    //即唤醒挂起的拉取消息请求，表示有新的消息落盘，可以进行拉取了
    //这里涉及到RocketMQ的consumer消费push模式的实现，后面会专门讲解consumer消费
    DefaultMessageStore.this.messageArrivingListener.arriving(dispatchRequest.getTopic(),
            dispatchRequest.getQueueId(), dispatchRequest.getConsumeQueueOffset() + 1,
            dispatchRequest.getTagsCode(), dispatchRequest.getStoreTimestamp(),
            dispatchRequest.getBitMap(), dispatchRequest.getPropertiesMap());
    notifyMessageArrive4MultiQueue(dispatchRequest);
}
```

**在构建ConsumeQueue和IndexFile之前执行这一段代码，如果broker角色不是SLAVE，并且支持长轮询，并且消息送达的监听器不为null，那么调用messageArrivingListener#arriving方法：
**

```java
public class NotifyMessageArrivingListener implements MessageArrivingListener {
   
     
    private final PullRequestHoldService pullRequestHoldService;

    public NotifyMessageArrivingListener(final PullRequestHoldService pullRequestHoldService) {
   
     
        this.pullRequestHoldService = pullRequestHoldService;
    }

    /**
     * 通知有新消息到达消费队列
     *
     * @param topic        topic name
     * @param queueId      consume queue id
     * @param logicOffset  consume queue offset
     * @param tagsCode     message tags hash code
     * @param msgStoreTime message store time
     * @param filterBitMap message bloom filter
     * @param properties   message properties
     */
    @Override
    public void arriving(String topic, int queueId, long logicOffset, long tagsCode,
                         long msgStoreTime, byte[] filterBitMap, Map<String, String> properties) {
   
     
        //调用notifyMessageArriving通知消息到达
        this.pullRequestHoldService.notifyMessageArriving(topic, queueId, logicOffset, tagsCode,
                msgStoreTime, filterBitMap, properties);
    }
}
```

**arriving方法内部调用pullRequestHoldService的notifyMessageArriving方法，表示有新的消息到到达了该消息队列，其对应的PullRequest可以进行消息拉取了。
**

**所以说notifyMessageArriving方法有这几种调用情况：**

**1、** PullRequestHoldService线程定时调用：；

**1、** 长轮询：最多挂起15s，每隔5s对所有PullRequest执行notifyMessageArriving方法；
**2、** 短轮询：最多挂起1s，每隔1s对所有PullRequest执行notifyMessageArriving方法；
**2、** ReputMessageService线程调用：；

```
1.  **当有新的消息到达时，在DefaultMessageStore\#doReput方法对于新的消息执行重放的过程中，会对等待对应topic@queueId的所有PullRequest执行notifyMessageArriving方法。doReput方法每1ms执行一次。**
```

### 2.3 commitOffset上报消费offset

*
*在执行processRequest方法的最后，只要broker支持挂起请求（新的拉取请求为true，但是已被suspend的请求将会是false，即要求是首次拉取），并且consumer支持提交消费进度（consumer如果是集群消费模式，那么就会支持提交消费进度），并且当前broker不是SLAVE角色，那么通过ConsumerOffsetManager#commitOffset方法提交消费进度偏移量。
**

*
*这里提交偏移量实际上就是将新的偏移量存入ConsumerOffsetManager的offsetTable中。该缓存对应着磁盘上的{user.home}/store/config/consumerOffset.json文件。这里实际上是存入到内存中的，并没有持久化。
**

```java
/**
 * ConsumerOffsetManager的方法
 * 提交偏移量
 *
 * @param clientHost 客户端地址
 * @param group      消费者组
 * @param topic      消费topic
 * @param queueId    队列id
 * @param offset     提交的偏移量
 */
public void commitOffset(final String clientHost, final String group, final String topic, final int queueId,
                         final long offset) {
   
     
    // topic@group
    String key = topic + TOPIC_GROUP_SEPARATOR + group;
    this.commitOffset(clientHost, key, queueId, offset);
}

/**
 * ConsumerOffsetManager的方法
 * 提交偏移量
 *
 * @param clientHost 客户端地址
 * @param key        缓存key
 * @param queueId    队列id
 * @param offset     提交的偏移量
 */
private void commitOffset(final String clientHost, final String key, final int queueId, final long offset) {
   
     
    //获取topic@group对应的所有queue的消费偏移量map
    ConcurrentMap<Integer, Long> map = this.offsetTable.get(key);
    if (null == map) {
   
     
        map = new ConcurrentHashMap<Integer, Long>(32);
        //存入map，key为queueId value为offSet
        map.put(queueId, offset);
        this.offsetTable.put(key, map);
    } else {
   
     
        //存入map，key为queueId value为offSet
        Long storeOffset = map.put(queueId, offset);
        if (storeOffset != null && offset < storeOffset) {
   
     
            log.warn("[NOTIFYME]update consumer offset less than store. clientHost={}, key={}, queueId={}, requestOffset={}, storeOffset={}", clientHost, key, queueId, offset, storeOffset);
        }
    }
}
```

broker启动过程中，在BrokerController#initialize方法中会启动一些定时调度任务，其中有一个任务每隔5s将消费者offset进行持久化（offsetTable中的数据），存入consumerOffset.json文件中。

![*](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162121726.png)

## 3 总结

本次我们讲解了Broker处理拉取消息请求的源码，总体包括构建过滤信息，拉取消息，拉取结果处理（判断直接返回响应还是挂起请求），上报消费点位等步骤。

1.
通过DefaultMessageStore#getMessage方法拉取消息，并且进行过滤操作。返回拉取结果GetMessageResult。这是拉取消息的核心方法，涉及到查找ConsumeQueue和CommitLog文件数据，默认最多拉取32条消息。

**1、**
对于拉取到的消息，将会进行broker端的消息过滤，通过tagsCode进行匹配对于普通消息来说，tagsCode就是的tags的hashCode而在消费者启动的时候，订阅topic的时候需要传递subExpression参数，这里的匹配就是subExpression的hashCode与tags的hashCode值进行比较，如果一致，则算作Broker端匹配（后续在Consumer端还会再进行比较一次）；
**2、** 获取到的消息实际上时一段字节buffer序列，并且直接返回给Consumer，Consumer收到消息之后，会按照CommitLog消息序列化格式自行反序列化为Message对象；

2.
没有拉取到消息，并且如果broker允许挂起请求并且客户端支持请求挂起，则通过pullRequestHoldService#suspendPullRequest方法提交PullRequest，broker挂起该请求一段时间，中间如果有消息到达或者延迟间隔时间到了，则会再次尝试调用notifyMessageArriving方法拉取消息。所notifyMessageArriving方法有这几种调用情况。

**1、** PullRequestHoldService线程定时调用：；

```
1.  长轮询：最多挂起15s，每隔5s对所有PullRequest执行notifyMessageArriving方法。
2.  短轮询：最多挂起1s，每隔1s对所有PullRequest执行notifyMessageArriving方法。
```

**2、** ReputMessageService线程调用：；

```
    1.  当有新的消息到达时，在DefaultMessageStore\#doReput方法对于新的消息执行重放，构建C
```