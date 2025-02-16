---

layout: 18、RocketMQ源码分析：DefaultMQPushConsumer消费者发起拉取消息请求源码

title:  18、RocketMQ源码分析：DefaultMQPushConsumer消费者发起拉取消息请求源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713343

abbrlink: 1739713343

date: 2025-02-16 21:42:06


--- 

# 18、RocketMQ源码分析：DefaultMQPushConsumer消费者发起拉取消息请求源码

**此前我们学习了**[**DefaultMQPushConsumer负载均衡的源码
**](https://blog.csdn.net/weixin_43767015/article/details/128370735)*
*，同时我们也知道了，最初始的PullRequest，就是在负载均衡之时对于新分配到的消费队列创建的。然后通过dispatchPullRequest方法对这些PullRequest进行分发，Push模式下这些请求会被PullMessageService依次处理，后续实现自动拉取消息，以及消费。
**

这些PullRequest将会被存入PullMessageService服务内部的pullRequestQueue集合中，后续异步的消费，自动执行拉取消息的请求，这就是Push模式下最初的拉消息请求的来源。关于如何拉去消息以及如何消费，将是我们下一部分的内容。

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

下面我们来介绍DefaultMQPushConsumer消费者如何拉取消息的源码，主要步骤可以分为三部分：

**1、** consumer发送拉取消息请求；
**2、** broker处理拉取消息请求；
**3、** consumer接收请求响应；

**本次我们学习consumer如何发送拉取消息请求。**

#### 文章目录

- 1 PullMessageService拉取消息
- 2 PullMessageService#pullMessage拉取消息
- 3 DefaultMQPushConsumerImpl#pullMessage拉取消息
-
    - 3.1 pullKernelImpl拉取消息
- 3.2 pullMessage发起拉取消息请求
- 4 总结

## 1 PullMessageService拉取消息

**Push模式下，消息拉取由PullMessageService服务实现，PullMessageService继承了ServiceThread，因此他也是一个异步线程任务。**

**我们来看看它的run方法，该方法在一个循环中，不断地从pullRequestQueue中阻塞式的获取并移除队列的头部数据，即拉取消息的请求，然后调用pullMessage方法根据该请求去broker拉取消息。
**

**也就是说只要pullRequestQueue队列中有拉取请求，它就会去Broker拉取消息，如果没有就阻塞。**

```java
@Override
public void run() {
   
     
    log.info(this.getServiceName() + " service started");
    /*
     * 运行时逻辑
     * 如果服务没有停止，则在死循环中执行拉取消息的操作
     */
    while (!this.isStopped()) {
   
     
        try {
   
     
            //阻塞式的获取并移除队列的头部数据，即拉取消息的请求
            PullRequest pullRequest = this.pullRequestQueue.take();
            //根据该请求去broker拉取消息
            this.pullMessage(pullRequest);
        } catch (InterruptedException ignored) {
   
     
        } catch (Exception e) {
   
     
            log.error("Pull Message Service Run Method exception", e);
        }
    }

    log.info(this.getServiceName() + " service end");
}
```

## 2 PullMessageService#pullMessage拉取消息

**pullMessage方法是拉取消息的入口方法。内部实际调用DefaultMQPushConsumerImpl的pullMessage方法。**

```java
/**
 * PullMessageService的方法
 *
 * @param pullRequest
 */
private void pullMessage(final PullRequest pullRequest) {
   
     
    //从consumerTable中获取pullRequest中保存的消费者组的消费者实例
    final MQConsumerInner consumer = this.mQClientFactory.selectConsumer(pullRequest.getConsumerGroup());
    if (consumer != null) {
   
     
        //强制转型
        DefaultMQPushConsumerImpl impl = (DefaultMQPushConsumerImpl) consumer;
        //拉取消息
        impl.pullMessage(pullRequest);
    } else {
   
     
        log.warn("No matched consumer for the PullRequest {}, drop it", pullRequest);
    }
}
```

## 3 DefaultMQPushConsumerImpl#pullMessage拉取消息

**下面是DefaultMQPushConsumerImpl的pullMessage方法的源码，代码很长内容很多，但是我们只需要关心几个重点步骤和方法：**

**1、** **服务状态校验**如果消费者服务状态异常，或者消费者暂停了，那么延迟发送拉取消息请求；
**2、** **流控校验\**\*
*默认请款下，如果processQueue中已缓存的消息总数量大于设定的阈值，默认1000，或者processQueue中已缓存的消息总大小大于设定的阈值，默认100MB那么同样延迟发送拉取消息请求**；
**3、** **顺序消费和并发消费的校验\**\*
*如果是并发消费并且内存中消息的offset的最大跨度大于设定的阈值，默认2000那么延迟发送拉取消息请求如果是顺序消费并且没有锁定过，那么需要设置消费点位**；
**4、** **创建拉取消息的回调函数对象PullCallback，当拉取消息的请求返回之后，将会调用回调函数这里面的源码我们后面再讲**；
**5、** **判断是否允许上报消费点位**
，如果是集群消费模式，并且本地内存有关于此mq的offset，那么设置commitOffsetEnable为true，表示拉取消息时可以上报消费位点给Broker进行持久化；
**6、** **调用pullAPIWrapper.pullKernelImpl方法真正的拉取消息**；

```java
/**
 * DefaultMQPushConsumerImpl的方法
 * 拉取消息
 *
 * @param pullRequest 拉取消息请求
 */
public void pullMessage(final PullRequest pullRequest) {
   
     
    //获取对应的处理队列
    final ProcessQueue processQueue = pullRequest.getProcessQueue();
    //如果该处理队列已被丢去，那么直接返回
    if (processQueue.isDropped()) {
   
     
        log.info("the pull request[{}] is dropped.", pullRequest.toString());
        return;
    }
    //设置最后的拉取时间戳
    pullRequest.getProcessQueue().setLastPullTimestamp(System.currentTimeMillis());
    /*
     * 1 状态校验
     */
    try {
   
     
        //确定此consumer的服务状态正常，如果服务状态不是RUNNING，那么抛出异常
        this.makeSureStateOK();
    } catch (MQClientException e) {
   
     
        log.warn("pullMessage exception, consumer state not ok", e);
        //延迟3s发送拉取消息请求
        this.executePullRequestLater(pullRequest, pullTimeDelayMillsWhenException);
        return;
    }
    //如果消费者暂停了，那么延迟1s发送拉取消息请求
    if (this.isPause()) {
   
     
        log.warn("consumer was paused, execute pull request later. instanceName={}, group={}", this.defaultMQPushConsumer.getInstanceName(), this.defaultMQPushConsumer.getConsumerGroup());
        this.executePullRequestLater(pullRequest, PULL_TIME_DELAY_MILLS_WHEN_SUSPEND);
        return;
    }
    /*
     * 2 流控校验
     */
    //获取processQueue中已缓存的消息总数量
    long cachedMessageCount = processQueue.getMsgCount().get();
    //获取processQueue中已缓存的消息总大小MB
    long cachedMessageSizeInMiB = processQueue.getMsgSize().get() / (1024 * 1024);
    //如果processQueue中已缓存的消息总数量大于设定的阈值，默认1000
    if (cachedMessageCount > this.defaultMQPushConsumer.getPullThresholdForQueue()) {
   
     
        //延迟50ms发送拉取消息请求
        this.executePullRequestLater(pullRequest, PULL_TIME_DELAY_MILLS_WHEN_FLOW_CONTROL);
        if ((queueFlowControlTimes++ % 1000) == 0) {
   
     
            log.warn(
                    "the cached message count exceeds the threshold {}, so do flow control, minOffset={}, maxOffset={}, count={}, size={} MiB, pullRequest={}, flowControlTimes={}",
                    this.defaultMQPushConsumer.getPullThresholdForQueue(), processQueue.getMsgTreeMap().firstKey(), processQueue.getMsgTreeMap().lastKey(), cachedMessageCount, cachedMessageSizeInMiB, pullRequest, queueFlowControlTimes);
        }
        return;
    }
    //如果processQueue中已缓存的消息总大小大于设定的阈值，默认100MB
    if (cachedMessageSizeInMiB > this.defaultMQPushConsumer.getPullThresholdSizeForQueue()) {
   
     
        //延迟50ms发送拉取消息请求
        this.executePullRequestLater(pullRequest, PULL_TIME_DELAY_MILLS_WHEN_FLOW_CONTROL);
        if ((queueFlowControlTimes++ % 1000) == 0) {
   
     
            log.warn(
                    "the cached message size exceeds the threshold {} MiB, so do flow control, minOffset={}, maxOffset={}, count={}, size={} MiB, pullRequest={}, flowControlTimes={}",
                    this.defaultMQPushConsumer.getPullThresholdSizeForQueue(), processQueue.getMsgTreeMap().firstKey(), processQueue.getMsgTreeMap().lastKey(), cachedMessageCount, cachedMessageSizeInMiB, pullRequest, queueFlowControlTimes);
        }
        return;
    }
    /*
     * 3 顺序消费和并发消费的校验
     */
    //如果不是顺序消息，即并发消费
    if (!this.consumeOrderly) {
   
     
        //如果内存中消息的offset的最大跨度大于设定的阈值，默认2000
        if (processQueue.getMaxSpan() > this.defaultMQPushConsumer.getConsumeConcurrentlyMaxSpan()) {
   
     
            //延迟50ms发送拉取消息请求
            this.executePullRequestLater(pullRequest, PULL_TIME_DELAY_MILLS_WHEN_FLOW_CONTROL);
            if ((queueMaxSpanFlowControlTimes++ % 1000) == 0) {
   
     
                log.warn(
                        "the queue's messages, span too long, so do flow control, minOffset={}, maxOffset={}, maxSpan={}, pullRequest={}, flowControlTimes={}",
                        processQueue.getMsgTreeMap().firstKey(), processQueue.getMsgTreeMap().lastKey(), processQueue.getMaxSpan(),
                        pullRequest, queueMaxSpanFlowControlTimes);
            }
            return;
        }
    } else {
   
     
        //顺序消费校验，如果已锁定
        if (processQueue.isLocked()) {
   
     
            //如果此前没有锁定过，那么需要设置消费点位
            if (!pullRequest.isPreviouslyLocked()) {
   
     
                long offset = -1L;
                try {
   
     
                    //获取该MessageQueue的下一个消息的消费偏移量offset
                    offset = this.rebalanceImpl.computePullFromWhereWithException(pullRequest.getMessageQueue());
                } catch (Exception e) {
   
     
                    //延迟3s发送拉取消息请求
                    this.executePullRequestLater(pullRequest, pullTimeDelayMillsWhenException);
                    log.error("Failed to compute pull offset, pullResult: {}", pullRequest, e);
                    return;
                }
                //消费点位超前，那么重设消费点位
                boolean brokerBusy = offset < pullRequest.getNextOffset();
                log.info("the first time to pull message, so fix offset from broker. pullRequest: {} NewOffset: {} brokerBusy: {}",
                        pullRequest, offset, brokerBusy);
                if (brokerBusy) {
   
     
                    log.info("[NOTIFYME]the first time to pull message, but pull request offset larger than broker consume offset. pullRequest: {} NewOffset: {}",
                            pullRequest, offset);
                }
                //设置previouslyLocked为true
                pullRequest.setPreviouslyLocked(true);
                //重设消费点位
                pullRequest.setNextOffset(offset);
            }
        } else {
   
     
            //如果没有被锁住，那么延迟3s发送拉取消息请求
            this.executePullRequestLater(pullRequest, pullTimeDelayMillsWhenException);
            log.info("pull message later because not locked in broker, {}", pullRequest);
            return;
        }
    }
    //获取topic对应的SubscriptionData订阅关系
    final SubscriptionData subscriptionData = this.rebalanceImpl.getSubscriptionInner().get(pullRequest.getMessageQueue().getTopic());
    //如果没有订阅信息
    if (null == subscriptionData) {
   
     
        //延迟3s发送拉取消息请求
        this.executePullRequestLater(pullRequest, pullTimeDelayMillsWhenException);
        log.warn("find the consumer's subscription failed, {}", pullRequest);
        return;
    }
    //起始时间
    final long beginTimestamp = System.currentTimeMillis();
    /*
     * 4 创建拉取消息的回调函数对象，当拉取消息的请求返回之后，将会指定回调函数
     */
    PullCallback pullCallback = new PullCallback() {
   
     
        @Override
        public void onSuccess(PullResult pullResult) {
   
     
            if (pullResult != null) {
   
     
                pullResult = DefaultMQPushConsumerImpl.this.pullAPIWrapper.processPullResult(pullRequest.getMessageQueue(), pullResult,
                        subscriptionData);

                switch (pullResult.getPullStatus()) {
   
     
                    case FOUND:
                        long prevRequestOffset = pullRequest.getNextOffset();
                        pullRequest.setNextOffset(pullResult.getNextBeginOffset());
                        long pullRT = System.currentTimeMillis() - beginTimestamp;
                        DefaultMQPushConsumerImpl.this.getConsumerStatsManager().incPullRT(pullRequest.getConsumerGroup(),
                                pullRequest.getMessageQueue().getTopic(), pullRT);

                        long firstMsgOffset = Long.MAX_VALUE;
                        if (pullResult.getMsgFoundList() == null || pullResult.getMsgFoundList().isEmpty()) {
   
     
                            DefaultMQPushConsumerImpl.this.executePullRequestImmediately(pullRequest);
                        } else {
   
     
                            firstMsgOffset = pullResult.getMsgFoundList().get(0).getQueueOffset();

                            DefaultMQPushConsumerImpl.this.getConsumerStatsManager().incPullTPS(pullRequest.getConsumerGroup(),
                                    pullRequest.getMessageQueue().getTopic(), pullResult.getMsgFoundList().size());

                            boolean dispatchToConsume = processQueue.putMessage(pullResult.getMsgFoundList());
                            DefaultMQPushConsumerImpl.this.consumeMessageService.submitConsumeRequest(
                                    pullResult.getMsgFoundList(),
                                    processQueue,
                                    pullRequest.getMessageQueue(),
                                    dispatchToConsume);

                            if (DefaultMQPushConsumerImpl.this.defaultMQPushConsumer.getPullInterval() > 0) {
   
     
                                DefaultMQPushConsumerImpl.this.executePullRequestLater(pullRequest,
                                        DefaultMQPushConsumerImpl.this.defaultMQPushConsumer.getPullInterval());
                            } else {
   
     
                                DefaultMQPushConsumerImpl.this.executePullRequestImmediately(pullRequest);
                            }
                        }

                        if (pullResult.getNextBeginOffset() < prevRequestOffset
                                || firstMsgOffset < prevRequestOffset) {
   
     
                            log.warn(
                                    "[BUG] pull message result maybe data wrong, nextBeginOffset: {} firstMsgOffset: {} prevRequestOffset: {}",
                                    pullResult.getNextBeginOffset(),
                                    firstMsgOffset,
                                    prevRequestOffset);
                        }

                        break;
                    case NO_NEW_MSG:
                    case NO_MATCHED_MSG:
                        pullRequest.setNextOffset(pullResult.getNextBeginOffset());

                        DefaultMQPushConsumerImpl.this.correctTagsOffset(pullRequest);

                        DefaultMQPushConsumerImpl.this.executePullRequestImmediately(pullRequest);
                        break;
                    case OFFSET_ILLEGAL:
                        log.warn("the pull request offset illegal, {} {}",
                                pullRequest.toString(), pullResult.toString());
                        pullRequest.setNextOffset(pullResult.getNextBeginOffset());

                        pullRequest.getProcessQueue().setDropped(true);
                        DefaultMQPushConsumerImpl.this.executeTaskLater(new Runnable() {
   
     

                            @Override
                            public void run() {
   
     
                                try {
   
     
                                    DefaultMQPushConsumerImpl.this.offsetStore.updateOffset(pullRequest.getMessageQueue(),
                                            pullRequest.getNextOffset(), false);

                                    DefaultMQPushConsumerImpl.this.offsetStore.persist(pullRequest.getMessageQueue());

                                    DefaultMQPushConsumerImpl.this.rebalanceImpl.removeProcessQueue(pullRequest.getMessageQueue());

                                    log.warn("fix the pull request offset, {}", pullRequest);
                                } catch (Throwable e) {
   
     
                                    log.error("executeTaskLater Exception", e);
                                }
                            }
                        }, 10000);
                        break;
                    default:
                        break;
                }
            }
        }

        @Override
        public void onException(Throwable e) {
   
     
            if (!pullRequest.getMessageQueue().getTopic().startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX)) {
   
     
                log.warn("execute the pull request exception", e);
            }

            DefaultMQPushConsumerImpl.this.executePullRequestLater(pullRequest, pullTimeDelayMillsWhenException);
        }
    };
    /*
     * 5 是否允许上报消费点位
     */
    boolean commitOffsetEnable = false;
    long commitOffsetValue = 0L;
    //如果是集群消费模式
    if (MessageModel.CLUSTERING == this.defaultMQPushConsumer.getMessageModel()) {
   
     
        //从本地内存offsetTable读取commitOffsetValue
        commitOffsetValue = this.offsetStore.readOffset(pullRequest.getMessageQueue(), ReadOffsetType.READ_FROM_MEMORY);
        if (commitOffsetValue > 0) {
   
     
            //如果本地内存有关于此mq的offset，那么设置为true，表示可以上报消费位点给Broker
            commitOffsetEnable = true;
        }
    }

    String subExpression = null;
    boolean classFilter = false;
    //classFilter相关处理
    SubscriptionData sd = this.rebalanceImpl.getSubscriptionInner().get(pullRequest.getMessageQueue().getTopic());
    if (sd != null) {
   
     
        if (this.defaultMQPushConsumer.isPostSubscriptionWhenPull() && !sd.isClassFilterMode()) {
   
     
            subExpression = sd.getSubString();
        }

        classFilter = sd.isClassFilterMode();
    }
    //系统标记
    int sysFlag = PullSysFlag.buildSysFlag(
            commitOffsetEnable, // commitOffset
            true, // suspend
            subExpression != null, // subscription
            classFilter // class filter
    );
    /*
     * 6 真正的开始拉取消息
     */
    try {
   
     
        this.pullAPIWrapper.pullKernelImpl(
                pullRequest.getMessageQueue(),
                subExpression,
                subscriptionData.getExpressionType(),
                subscriptionData.getSubVersion(),
                pullRequest.getNextOffset(),
                this.defaultMQPushConsumer.getPullBatchSize(),
                sysFlag,
                commitOffsetValue,
                BROKER_SUSPEND_MAX_TIME_MILLIS,
                CONSUMER_TIMEOUT_MILLIS_WHEN_SUSPEND,
                CommunicationMode.ASYNC,
                pullCallback
        );
    } catch (Exception e) {
   
     
        log.error("pullKernelImpl exception", e);
        //拉取异常，延迟3s发送拉取消息请求
        this.executePullRequestLater(pullRequest, pullTimeDelayMillsWhenException);
    }
}
```

### 3.1 pullKernelImpl拉取消息

PullAPIWrapper的方法，用于拉取消息。

**首先获取指定brokerName的broker地址，默认获取master地址，如果由建议的拉取地址，则获取建议的broker地址，没找到broker地址，那么更新topic路由信息再获取一次。
**

**找到了broker之后，校验版本号，通过之后构造PullMessageRequestHeader请求头，然后调用MQClientAPIImpl#pullMessage方法发送请求，进行消息拉取。
**

```java
/**
 * PullAPIWrapper的方法
 *
 * @param mq                         消息队列
 * @param subExpression              订阅关系表达式，它仅支持或操作，如“tag1 | | tag2 | | tag3”，如果为 null 或 *，则表示订阅全部
 * @param expressionType             订阅关系表达式类型，支持TAG和SQL92，用于过滤
 * @param subVersion                 订阅关系版本
 * @param offset                     下一个拉取的offset
 * @param maxNums                    一次批量拉取的最大消息数，默认32
 * @param sysFlag                    系统标记
 * @param commitOffset               提交的消费点位
 * @param brokerSuspendMaxTimeMillis broker挂起请求的最长时间，默认15s
 * @param timeoutMillis              消费者消息拉取超时时间，默认30s
 * @param communicationMode          消息拉取模式，默认为异步拉取
 * @param pullCallback               拉取到消息之后调用的回调函数
 * @return 拉取结果
 */
public PullResult pullKernelImpl(
        final MessageQueue mq,
        final String subExpression,
        final String expressionType,
        final long subVersion,
        final long offset,
        final int maxNums,
        final int sysFlag,
        final long commitOffset,
        final long brokerSuspendMaxTimeMillis,
        final long timeoutMillis,
        final CommunicationMode communicationMode,
        final PullCallback pullCallback
) throws MQClientException, RemotingException, MQBrokerException, InterruptedException {
   
     
    //获取指定brokerName的broker地址，默认获取master地址，如果由建议的拉取地址，则获取建议的broker地址
    FindBrokerResult findBrokerResult =
            this.mQClientFactory.findBrokerAddressInSubscribe(mq.getBrokerName(),
                    this.recalculatePullFromWhichNode(mq), false);
    //没找到broker地址，那么更新topic路由信息再获取一次
    if (null == findBrokerResult) {
   
     
        this.mQClientFactory.updateTopicRouteInfoFromNameServer(mq.getTopic());
        findBrokerResult =
                this.mQClientFactory.findBrokerAddressInSubscribe(mq.getBrokerName(),
                        this.recalculatePullFromWhichNode(mq), false);
    }
    //找到了broker
    if (findBrokerResult != null) {
   
     
        {
   
     
            // check version
            //检查版本
            if (!ExpressionType.isTagType(expressionType)
                    && findBrokerResult.getBrokerVersion() < MQVersion.Version.V4_1_0_SNAPSHOT.ordinal()) {
   
     
                throw new MQClientException("The broker[" + mq.getBrokerName() + ", "
                        + findBrokerResult.getBrokerVersion() + "] does not upgrade to support for filter message by " + expressionType, null);
            }
        }
        int sysFlagInner = sysFlag;

        if (findBrokerResult.isSlave()) {
   
     
            sysFlagInner = PullSysFlag.clearCommitOffsetFlag(sysFlagInner);
        }
        /*
         * 构造PullMessageRequestHeader请求头
         */
        PullMessageRequestHeader requestHeader = new PullMessageRequestHeader();
        //消费者组
        requestHeader.setConsumerGroup(this.consumerGroup);
        //topic
        requestHeader.setTopic(mq.getTopic());
        //队列id
        requestHeader.setQueueId(mq.getQueueId());
        //拉取偏移量
        requestHeader.setQueueOffset(offset);
        //最大拉取消息数量
        requestHeader.setMaxMsgNums(maxNums);
        //系统标记
        requestHeader.setSysFlag(sysFlagInner);
        //提交的消费点位
        requestHeader.setCommitOffset(commitOffset);
        //broker挂起请求的最长时间，默认15s
        requestHeader.setSuspendTimeoutMillis(brokerSuspendMaxTimeMillis);
        //订阅关系表达式，它仅支持或操作，如“tag1 | | tag2 | | tag3”，如果为 null 或 *，则表示订阅全部
        requestHeader.setSubscription(subExpression);
        //订阅关系版本
        requestHeader.setSubVersion(subVersion);
        //表达式类型 TAG 或者SQL92
        requestHeader.setExpressionType(expressionType);

        String brokerAddr = findBrokerResult.getBrokerAddr();
        if (PullSysFlag.hasClassFilterFlag(sysFlagInner)) {
   
     
            brokerAddr = computePullFromWhichFilterServer(mq.getTopic(), brokerAddr);
        }
        /*
         * 调用MQClientAPIImpl#pullMessage方法发送请求，进行消息拉取
         */
        PullResult pullResult = this.mQClientFactory.getMQClientAPIImpl().pullMessage(
                brokerAddr,
                requestHeader,
                timeoutMillis,
                communicationMode,
                pullCallback);

        return pullResult;
    }

    throw new MQClientException("The broker[" + mq.getBrokerName() + "] not exist", null);
}
```

### 3.2 pullMessage发起拉取消息请求

**MQClientAPIImpl的方法，首先构建构建请求命令对象，请求Code为PULL_MESSAGE，然后根据设置的消息拉取模式，调用不同的方法发起不同请求进行消息拉取。
**

```java
/**
 * MQClientAPIImpl的方法
 *
 * @param addr              broker地址
 * @param requestHeader     请求头
 * @param timeoutMillis     消费者消息拉取超时时间，默认30s
 * @param communicationMode 消息拉取模式，默认为异步拉取
 * @param pullCallback      拉取到消息之后调用的回调函数
 * @return 拉取结果
 * @throws RemotingException
 * @throws MQBrokerException
 * @throws InterruptedException
 */
public PullResult pullMessage(
        final String addr,
        final PullMessageRequestHeader requestHeader,
        final long timeoutMillis,
        final CommunicationMode communicationMode,
        final PullCallback pullCallback
) throws RemotingException, MQBrokerException, InterruptedException {
   
     
    //构建请求命令对象，请求Code为PULL_MESSAGE
    RemotingCommand request = RemotingCommand.createRequestCommand(RequestCode.PULL_MESSAGE, requestHeader);

    switch (communicationMode) {
   
     
        case ONEWAY:
            assert false;
            return null;
        case ASYNC:
            //push模式默认异步拉取消息
            this.pullMessageAsync(addr, request, timeoutMillis, pullCallback);
            return null;
        case SYNC:
            return this.pullMessageSync(addr, request, timeoutMillis);
        default:
            assert false;
            break;
    }

    return null;
}
```

**push消费模式默认异步拉取消息，即调用pullMessageAsync方法拉取消息。**

**该方法内部调用remotingClient.invokeAsync方法，基于netty给broker发送异步消息，设置一个InvokeCallback回调对象。**

**InvokeCallback#operationComplete方法将会在得到结果之后进行回调，内部调用pullCallback的回调方法。**

**在回调方法中，如果解析到了响应结果，那么调用pullCallback#onSuccess方法处理，否则调用pullCallback#onException方法处理。**

```java
/**
 * MQClientAPIImpl的方法
 * 异步的拉取消息，并且触发回调函数
 *
 * @param addr          broker地址
 * @param request       请求命令对象
 * @param timeoutMillis 消费者消息拉取超时时间，默认30s
 * @param pullCallback  拉取到消息之后调用的回调函数
 * @throws RemotingException
 * @throws InterruptedException
 */
private void pullMessageAsync(
        final String addr,
        final RemotingCommand request,
        final long timeoutMillis,
        final PullCallback pullCallback
) throws RemotingException, InterruptedException {
   
     
    /*
     * 基于netty给broker发送异步消息，设置一个InvokeCallback回调对象
     *
     * InvokeCallback#operationComplete方法将会在得到结果之后进行回调，内部调用pullCallback的回调方法
     */
    this.remotingClient.invokeAsync(addr, request, timeoutMillis, new InvokeCallback() {
   
     
        /**
         * 异步执行的回调方法
         */
        @Override
        public void operationComplete(ResponseFuture responseFuture) {
   
     
            //返回命令对象
            RemotingCommand response = responseFuture.getResponseCommand();
            if (response != null) {
   
     
                try {
   
     
                    //解析响应获取结果
                    PullResult pullResult = MQClientAPIImpl.this.processPullResponse(response, addr);
                    assert pullResult != null;
                    //如果解析到了结果，那么调用pullCallback#onSuccess方法处理
                    pullCallback.onSuccess(pullResult);
                } catch (Exception e) {
   
     
                    //出现异常则调用pullCallback#onException方法处理异常
                    pullCallback.onException(e);
                }
            } else {
   
     
                //没有结果，都调用onException方法处理异常
                if (!responseFuture.isSendRequestOK()) {
   
     
                    //发送失败
                    pullCallback.onException(new MQClientException("send request failed to " + addr + ". Request: " + request, responseFuture.getCause()));
                } else if (responseFuture.isTimeout()) {
   
     
                    //超时
                    pullCallback.onException(new MQClientException("wait response from " + addr + " timeout :" + responseFuture.getTimeoutMillis() + "ms" + ". Request: " + request,
                            responseFuture.getCause()));
                } else {
   
     
                    pullCallback.onException(new MQClientException("unknown reason. addr: " + addr + ", timeoutMillis: " + timeoutMillis + ". Request: " + request, responseFuture.getCause()));
                }
            }
        }
    });
}
```

## 4 总结

本次我们讲解了DefaultMQPushConsumer消费者客户端如何发起的拉取消息请求。

消息拉取由PullMessageService服务实现，PullMessageService继承了ServiceThread，因此他也是一个异步线程任务，将会在线程任务中，不断循环的从pullRequestQueue中阻塞式的获取并移除队列的头部数据，即拉取消息的请求，然后调用pullMessage方法根据该请求去broker拉取消息。

发起拉取请求之前，会进行一系列校验，例如服务状态校验、**流控校验、顺序消费和并发消费的校验，都通过之后，创建拉取消息的回调函数对象PullCallback
**，当拉取消息的请求返回之后，将会调用回调函数。最后通过**pullAPIWrapper.pullKernelImpl**方法真正的拉取消息。

最终，拉取消息请求Code为PULL_MESSAGE，push消费模式默认异步拉取消息，即调用**pullMessageAsync**
方法拉取消息。服务端收到该请求之后，会处理该消息拉取请求，我们下文再讲。