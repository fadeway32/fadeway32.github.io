---

layout: 20、RocketMQ源码分析：DefaultMQPushConsumer处理Broker的拉取消息响应源码

title:  20、RocketMQ源码分析：DefaultMQPushConsumer处理Broker的拉取消息响应源码

tags: RocketMq

categories: Web

top: 56

path: /article/1739713345

abbrlink: 1739713345

date: 2025-02-16 21:42:06


--- 

# 20、RocketMQ源码分析：DefaultMQPushConsumer处理Broker的拉取消息响应源码

此前我们学习了[Consumer如何发起的拉取消息请求](https://blog.csdn.net/weixin_43767015/article/details/128563451)
，以及[Broker如何处理拉取消息请求](https://blog.csdn.net/weixin_43767015/article/details/128694893)
，现在我们来学习Consumer如何处理Broker的拉取消息响应的源码。

#### 文章目录

- 1 客户端异步请求回调
-
    - 1.1.1.1. processPullResponse解析响应
- 2 PullCallback回调
-
    - 2.1 processPullResult处理拉取结果
- 2.2 executePullRequestImmediately再次拉取消息
- 2.3 putMessage存放消息
- 2.4 消息的两次过滤
- 3 总结

## 1 客户端异步请求回调

此前我们讲过在[consumer发起拉取消息请求](https://blog.csdn.net/weixin_43767015/article/details/128563451)
的时候，通过ASYNC模式异步的进行拉取，并且**InvokeCallback#operationComplete**方法将会在得到结果之后进行回调，内部调用*
*pullCallback**的回调方法。

在回调方法中，如果解析到了响应结果，那么调用**pullCallback#onSuccess**方法处理，否则调用**pullCallback#onException**方法处理。

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

### 1.1.1.1. processPullResponse解析响应

该方法处理response获取PullResult，根据响应的数据创建PullResultExt对象返回，注意此时拉取到的消息还是一个字节数组。

```java
/**
 * MQClientAPIImpl的方法
 * 处理response获取PullResult
 */
private PullResult processPullResponse(
        final RemotingCommand response,
        final String addr) throws MQBrokerException, RemotingCommandException {
   
     
    PullStatus pullStatus = PullStatus.NO_NEW_MSG;
    //设置结果状态码
    switch (response.getCode()) {
   
     
        case ResponseCode.SUCCESS:
            pullStatus = PullStatus.FOUND;
            break;
        case ResponseCode.PULL_NOT_FOUND:
            pullStatus = PullStatus.NO_NEW_MSG;
            break;
        case ResponseCode.PULL_RETRY_IMMEDIATELY:
            pullStatus = PullStatus.NO_MATCHED_MSG;
            break;
        case ResponseCode.PULL_OFFSET_MOVED:
            pullStatus = PullStatus.OFFSET_ILLEGAL;
            break;

        default:
            throw new MQBrokerException(response.getCode(), response.getRemark(), addr);
    }
    //解析响应头
    PullMessageResponseHeader responseHeader =
            (PullMessageResponseHeader) response.decodeCommandCustomHeader(PullMessageResponseHeader.class);
    //根据响应的数据创建PullResultExt对象返回，此时拉取到的消息还是一个字节数组
    return new PullResultExt(pullStatus, responseHeader.getNextBeginOffset(), responseHeader.getMinOffset(),
            responseHeader.getMaxOffset(), null, responseHeader.getSuggestWhichBrokerId(), response.getBody());
}
```

## 2 PullCallback回调

在processPullResponse处理response之后，会调用此前DefaultMQPushConsumerImpl#pullMessage方法中创建的PullCallback消息拉取的回调函数，执行onSuccess回调方法。如果解析过程中抛出异常，则调用onException方法。

**onSuccess**回调方法的大概逻辑为：

**1、** 调用**processPullResult**方法处理pullResult，进行**消息解码、过滤以及设置其他属性的操作**，返回pullResult；
**2、** 如果**没有拉取到消息**
，那么设置下一次拉取的起始offset到PullRequest中，调用executePullRequestImmediately方法立即将拉取请求再次放入PullMessageService的pullRequestQueue中，PullMessageService是一个线程服务，PullMessageService将会循环的获取pullRequestQueue中的pullRequest然后向broker发起新的拉取消息请求，
**进行下次消息的拉取**；
**3、** 如果**拉取到了消息**，将拉取到的所有消息，存入对应的**processQueue处理队列**内部的**msgTreeMap中**，等待被异步的消费；
**4、** 通过**consumeMessageService**将拉取到的消息构建为ConsumeRequest，然后通过内部的**consumeExecutor**
线程池消费消息，consumeMessageService有**ConsumeMessageConcurrentlyService并发消费和ConsumeMessageOrderlyService顺序消费
**两种实现；
**5、**
获取配置的消息拉取间隔，默认为0，如果大于0则调用executePullRequestLater方法，等待间隔时间后将拉取请求再次放入pullRequestQueue中，否则立即调用executePullRequestImmediately放入pullRequestQueue中，进行下次消息的拉取；

如果是**onException**方法，那么延迟3s将拉取请求再次放入PullMessageService的pullRequestQueue中，等待下次拉取。

```java
PullCallback pullCallback = new PullCallback() {
   
     
    @Override
    public void onSuccess(PullResult pullResult) {
   
     
        if (pullResult != null) {
   
     
            /*
             * 1 处理pullResult，进行消息解码、过滤以及设置其他属性的操作
             */
            pullResult = DefaultMQPushConsumerImpl.this.pullAPIWrapper.processPullResult(pullRequest.getMessageQueue(), pullResult,
                    subscriptionData);

            switch (pullResult.getPullStatus()) {
   
     
                case FOUND:
                    //拉取的起始offset
                    long prevRequestOffset = pullRequest.getNextOffset();
                    //设置下一次拉取的起始offset到PullRequest中
                    pullRequest.setNextOffset(pullResult.getNextBeginOffset());
                    //增加拉取耗时
                    long pullRT = System.currentTimeMillis() - beginTimestamp;
                    DefaultMQPushConsumerImpl.this.getConsumerStatsManager().incPullRT(pullRequest.getConsumerGroup(),
                            pullRequest.getMessageQueue().getTopic(), pullRT);

                    long firstMsgOffset = Long.MAX_VALUE;
                    //如果没有消息
                    if (pullResult.getMsgFoundList() == null || pullResult.getMsgFoundList().isEmpty()) {
   
     
                        /*
                         * 立即将拉取请求再次放入PullMessageService的pullRequestQueue中，PullMessageService是一个线程服务
                         * PullMessageService将会循环的获取pullRequestQueue中的pullRequest然后向broker发起新的拉取消息请求
                         * 进行下次消息的拉取
                         */
                        DefaultMQPushConsumerImpl.this.executePullRequestImmediately(pullRequest);
                    } else {
   
     
                        //获取第一个消息的offset
                        firstMsgOffset = pullResult.getMsgFoundList().get(0).getQueueOffset();
                        //增加拉取tps
                        DefaultMQPushConsumerImpl.this.getConsumerStatsManager().incPullTPS(pullRequest.getConsumerGroup(),
                                pullRequest.getMessageQueue().getTopic(), pullResult.getMsgFoundList().size());
                        /*
                         * 2 将拉取到的所有消息，存入对应的processQueue处理队列内部的msgTreeMap中
                         */
                        boolean dispatchToConsume = processQueue.putMessage(pullResult.getMsgFoundList());
                        /*
                         * 3 通过consumeMessageService将拉取到的消息构建为ConsumeRequest，然后通过内部的consumeExecutor线程池消费消息
                         * consumeMessageService有ConsumeMessageConcurrentlyService并发消费和ConsumeMessageOrderlyService顺序消费两种实现
                         */
                        DefaultMQPushConsumerImpl.this.consumeMessageService.submitConsumeRequest(
                                pullResult.getMsgFoundList(),
                                processQueue,
                                pullRequest.getMessageQueue(),
                                dispatchToConsume);
                        /*
                         * 4 获取配置的消息拉取间隔，默认为0，则等待间隔时间后将拉取请求再次放入pullRequestQueue中，否则立即放入pullRequestQueue中
                         * 进行下次消息的拉取
                         */
                        if (DefaultMQPushConsumerImpl.this.defaultMQPushConsumer.getPullInterval() > 0) {
   
     
                            /*
                             * 将executePullRequestImmediately的执行放入一个PullMessageService的scheduledExecutorService延迟任务线程池中
                             * 等待给定的延迟时间到了之后再执行executePullRequestImmediately方法
                             */
                            DefaultMQPushConsumerImpl.this.executePullRequestLater(pullRequest,
                                    DefaultMQPushConsumerImpl.this.defaultMQPushConsumer.getPullInterval());
                        } else {
   
     
                            /*
                             * 立即将拉取请求再次放入PullMessageService的pullRequestQueue中，等待下次拉取
                             */
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
                    //没有匹配到消息
                case NO_MATCHED_MSG:
                    //更新下一次拉取偏移量
                    pullRequest.setNextOffset(pullResult.getNextBeginOffset());

                    DefaultMQPushConsumerImpl.this.correctTagsOffset(pullRequest);
                    //立即将拉取请求再次放入PullMessageService的pullRequestQueue中，等待下次拉取
                    DefaultMQPushConsumerImpl.this.executePullRequestImmediately(pullRequest);
                    break;
                //请求offset不合法，过大或者过小
                case OFFSET_ILLEGAL:
                    log.warn("the pull request offset illegal, {} {}",
                            pullRequest.toString(), pullResult.toString());
                    //更新下一次拉取偏移量
                    pullRequest.setNextOffset(pullResult.getNextBeginOffset());
                    //丢弃拉取请求
                    pullRequest.getProcessQueue().setDropped(true);
                    DefaultMQPushConsumerImpl.this.executeTaskLater(new Runnable() {
   
     

                        @Override
                        public void run() {
   
     
                            try {
   
     
                                //更新下次拉取偏移量
                                DefaultMQPushConsumerImpl.this.offsetStore.updateOffset(pullRequest.getMessageQueue(),
                                        pullRequest.getNextOffset(), false);
                                //持久化offset
                                DefaultMQPushConsumerImpl.this.offsetStore.persist(pullRequest.getMessageQueue());
                                //移除对应的消费队列，同时将消息队列从负载均衡服务中移除
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
        /*
         * 出现异常，延迟3s将拉取请求再次放入PullMessageService的pullRequestQueue中，等待下次拉取
         */
        DefaultMQPushConsumerImpl.this.executePullRequestLater(pullRequest, pullTimeDelayMillsWhenException);
    }
};
```

### 2.1 processPullResult处理拉取结果

处理pullResult，进行消息解码、过滤以及设置其他属性的操作。

**1、** 更新下次拉取建议的brokerId，下次拉取消息时从pullFromWhichNodeTable中直接取出；
**2、** 对消息二进制字节数组进行解码转换为java的List消息集合；

3. 如果存在tag，并且不是classFilterMode，那么按照tag过滤消息，这就是客户端的消息过滤。这采用String#equals方法过滤，而broker端则是比较的tagHash值，即hashCode。

**4、** 如果有消息过滤钩子，那么执行钩子方法，这里可以扩展自定义的消息过滤的逻辑；
**5、** 遍历过滤通过的消息，设置属性例如事务id，最大、最小偏移量、brokerName；
**6、** 将过滤后的消息存入msgFoundList集合；
**7、** 因为消息已经被解析了，那么设置消息的字节数组为null，释放内存；

```java
/**
 * PullAPIWrapper的方法
 * 处理pullResult，进行消息解码、过滤以及设置其他属性的操作
 *
 * @param mq               消息队列
 * @param pullResult       拉取结果
 * @param subscriptionData 获取topic对应的SubscriptionData订阅关系
 * @return 处理后的PullResult
 */
public PullResult processPullResult(final MessageQueue mq, final PullResult pullResult,
                                    final SubscriptionData subscriptionData) {
   
     
    PullResultExt pullResultExt = (PullResultExt) pullResult;
    /*
     * 1 更新下次拉取建议的brokerId，下次拉取消息时从pullFromWhichNodeTable中直接取出
     */
    this.updatePullFromWhichNode(mq, pullResultExt.getSuggestWhichBrokerId());

    if (PullStatus.FOUND == pullResult.getPullStatus()) {
   
     
        /*
         * 2 对二进制字节数组进行解码转换为java的List<MessageExt>消息集合
         */
        ByteBuffer byteBuffer = ByteBuffer.wrap(pullResultExt.getMessageBinary());
        List<MessageExt> msgList = MessageDecoder.decodes(byteBuffer);

        List<MessageExt> msgListFilterAgain = msgList;
        /*
         * 3 如果存在tag，并且不是classFilterMode，那么按照tag过滤消息，这就是客户端的消息过滤
         */
        if (!subscriptionData.getTagsSet().isEmpty() && !subscriptionData.isClassFilterMode()) {
   
     
            msgListFilterAgain = new ArrayList<MessageExt>(msgList.size());
            for (MessageExt msg : msgList) {
   
     
                if (msg.getTags() != null) {
   
     
                    //这采用String#equals方法过滤，而broker端则是比较的tagHash值，即hashCode
                    if (subscriptionData.getTagsSet().contains(msg.getTags())) {
   
     
                        msgListFilterAgain.add(msg);
                    }
                }
            }
        }
        /*
         * 4 如果有消息过滤钩子，那么执行钩子方法，这里可以扩展自定义的消息过滤的逻辑
         */
        if (this.hasHook()) {
   
     
            FilterMessageContext filterMessageContext = new FilterMessageContext();
            filterMessageContext.setUnitMode(unitMode);
            filterMessageContext.setMsgList(msgListFilterAgain);
            this.executeHook(filterMessageContext);
        }
        /*
         * 5 遍历过滤通过的消息，设置属性
         */
        for (MessageExt msg : msgListFilterAgain) {
   
     
            //事务消息标识
            String traFlag = msg.getProperty(MessageConst.PROPERTY_TRANSACTION_PREPARED);
            //如果是事务消息，则设置事务id
            if (Boolean.parseBoolean(traFlag)) {
   
     
                msg.setTransactionId(msg.getProperty(MessageConst.PROPERTY_UNIQ_CLIENT_MESSAGE_ID_KEYIDX));
            }
            //将响应中的最小和最大偏移量存入msg
            MessageAccessor.putProperty(msg, MessageConst.PROPERTY_MIN_OFFSET,
                    Long.toString(pullResult.getMinOffset()));
            MessageAccessor.putProperty(msg, MessageConst.PROPERTY_MAX_OFFSET,
                    Long.toString(pullResult.getMaxOffset()));
            //设置brokerName到msg
            msg.setBrokerName(mq.getBrokerName());
        }
        //将过滤后的消息存入msgFoundList集合
        pullResultExt.setMsgFoundList(msgListFilterAgain);
    }
    //6 因为消息已经被解析了，那么设置消息的字节数组为null，释放内存
    pullResultExt.setMessageBinary(null);

    return pullResult;
}

/**
 * PullAPIWrapper的方法
 * 更新下次拉取建议的brokerId
 *
 * @param mq       消息队列
 * @param brokerId 建议的brokerId
 */
public void updatePullFromWhichNode(final MessageQueue mq, final long brokerId) {
   
     
    //存入pullFromWhichNodeTable集合
    AtomicLong suggest = this.pullFromWhichNodeTable.get(mq);
    if (null == suggest) {
   
     
        this.pullFromWhichNodeTable.put(mq, new AtomicLong(brokerId));
    } else {
   
     
        suggest.set(brokerId);
    }
}
```

### 2.2 executePullRequestImmediately再次拉取消息

将拉取请求再次放入PullMessageService的pullRequestQueue中，PullMessageService是一个线程服务。PullMessageService将会循环的获取pullRequestQueue中的pullRequest然后向broker发起新的拉取消息请求，进行下次消息的拉取。

```java
/**
 * DefaultMQPushConsumerImpl的方法
 * 下一次消息拉取
 *
 * @param pullRequest 拉取请求
 */
public void executePullRequestImmediately(final PullRequest pullRequest) {
   
     
    //调用PullMessageService#executePullRequestImmediately方法
    this.mQClientFactory.getPullMessageService().executePullRequestImmediately(pullRequest);
}
/**
 * PullMessageService的方法
 * 下一次消息拉取
 *
 * @param pullRequest 拉取请求
 */
public void executePullRequestImmediately(final PullRequest pullRequest) {
   
     
    try {
   
     
        //存入pullRequestQueue集合，等待下次拉取
        this.pullRequestQueue.put(pullRequest);
    } catch (InterruptedException e) {
   
     
        log.error("executePullRequestImmediately pullRequestQueue.put", e);
    }
}
```

### 2.3 putMessage存放消息

该方法将拉取到的所有消息，存入对应的processQueue处理队列内部的msgTreeMap中。

返回是否需要分发消费dispatchToConsume，当当前processQueue的内部的msgTreeMap中有消息并且consuming=false，即还没有开始消费时，将会返回true。

dispatchToConsume对并发消费无影响，只对顺序消费有影响。

```java
/**
 * ProcessQueue的方法
 * 消息存入msgTreeMap这个红黑树map集合中
 *
 * @param msgs 一批消息
 * @return 是否需要分发消费，当当前processQueue的内部的msgTreeMap中有消息并且consuming=false，即还没有开始消费时，将会返回true
 */
public boolean putMessage(final List<MessageExt> msgs) {
   
     
    boolean dispatchToConsume = false;
    try {
   
     
        //尝试加写锁防止并发
        this.treeMapLock.writeLock().lockInterruptibly();
        try {
   
     
            int validMsgCnt = 0;
            for (MessageExt msg : msgs) {
   
     
                //当该消息的偏移量以及该消息存入msgTreeMap
                MessageExt old = msgTreeMap.put(msg.getQueueOffset(), msg);
                if (null == old) {
   
     
                    //如果集合没有这个offset的消息，那么增加统计数据
                    validMsgCnt++;
                    this.queueOffsetMax = msg.getQueueOffset();
                    msgSize.addAndGet(msg.getBody().length);
                }
            }
            //消息计数
            msgCount.addAndGet(validMsgCnt);
            //当前processQueue的内部的msgTreeMap中有消息并且consuming=false，即还没有开始消费时，dispatchToConsume = true，consuming = true
            if (!msgTreeMap.isEmpty() && !this.consuming) {
   
     
                dispatchToConsume = true;
                this.consuming = true;
            }
            //计算broker累计消息数量
            if (!msgs.isEmpty()) {
   
     
                MessageExt messageExt = msgs.get(msgs.size() - 1);
                String property = messageExt.getProperty(MessageConst.PROPERTY_MAX_OFFSET);
                if (property != null) {
   
     
                    long accTotal = Long.parseLong(property) - messageExt.getQueueOffset();
                    if (accTotal > 0) {
   
     
                        this.msgAccCnt = accTotal;
                    }
                }
            }
        } finally {
   
     
            this.treeMapLock.writeLock().unlock();
        }
    } catch (InterruptedException e) {
   
     
        log.error("putMessage exception", e);
    }

    return dispatchToConsume;
}
```

### 2.4 消息的两次过滤

*
*通过前面的源码可以看到，消息实际上经过了两次过滤，一次是在broekr中，一次是拉取到consumer之后，为什么经过两次过滤呢？因为broker中的过滤是比较的hashCode值，而hashCode存在哈希碰撞的可能，因此hashCode对比相等之后，还需要在consumer端进行equals的比较，再过滤一次。
**

为*
*什么服务端不直接进行equals过滤呢？因为tag的长度是不固定的，而通过hash算法可以生成固定长度的hashCode值，这样才能保证每个consumequeue索引条目的长度一致。而tag的真正值保存在commitLog的消息体中，虽然broker最终会回去到commitLog中的消息并返回，但是获取的获取一段消息字节数组，并没有进行反序列化为Message对象，因此无法获取真实值，而在consumer端一定会做反序列化操作的，因此tag的equals比较放在了consumer端。
**

## 3 总结

本次我们来学习Consumer如何处理Broker的拉取消息响应的源码。入口就是MQClientAPIImpl#pullMessageAsync方法内部的回调函数InvokeCallback#operationComplete方法。

**1、** 在这个方法中，首先进行消息的**解码以及第二次过滤，然后将消息存入对应的processQueue处理队列内部的msgTreeMap中**；

2. 然后通过consumeMessageService#submitConsumeRequest方法将拉取到的消息构建为ConsumeRequest，然后通过内部的consumeExecutor线程池的消费消息。

**1、** consumeMessageService有ConsumeMessageConcurrentlyService并发消费和ConsumeMessageOrderlyService顺序消费两种实现；
**3、** 最后是再次发起消息拉取请求；

**下一篇文章，我们将会去看看ConsumeMessageConcurrentlyService并发消费和ConsumeMessageOrderlyService顺序消费两种实现如何消费消息。
**