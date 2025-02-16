---

layout: 13、RocketMQ源码分析：Broker消息重放服务ReputMessageService源码解析

title:  13、RocketMQ源码分析：Broker消息重放服务ReputMessageService源码解析

tags: RocketMq

categories: Web

top: 56

path: /article/1739713338

abbrlink: 1739713338

date: 2025-02-16 21:42:06


--- 

# 13、RocketMQ源码分析：Broker消息重放服务ReputMessageService源码解析

此前我们学习了[RocketMQ源码(12)—Broker 消息刷盘服务GroupCommitService、FlushRealTimeService、CommitRealTimeService源码深度解析【一万字】](https://blog.csdn.net/weixin_43767015/article/details/127379381)
，这篇文将讲的是如何构建消息文件ConsumeQueue和IndexFile。

CommitLog文件顺序存储着所有的消息，理论上来说RocketMQ只要有CommitLog文件就可以正常运行了，但是我们再此前的文章（[RocketMQ的底层消息存储架构以及优化措施](https://blog.csdn.net/weixin_43767015/article/details/121436088)
）中介绍过，RocketMQ还存在另外两个重要的文件服务：

**1、**
ConsumeQueue文件：ConsumeQueue文件可以看作是CommitLog的消息偏移量索引文件，其存储了它所属Topic的消息在CommitLog中的偏移量消费者拉取消息的时候，可以从ConsumeQueue中快速的根据偏移量定位消息在CommitLog中的位置；
**2、** IndexFile索引文件：IndexFile文件可以看作是CommitLog的消息时间范围索引文件IndexFile（索引文件）提供了一种可以通过key或时间区间来查询消息的方法；

*
*虽然CommitLog文件顺序存储着所有的消息，但是其并没有区分任何的topic、tag等信息，我们只能顺序遍历CommitLog文件去查找消费数据，性能非常底下，因此才有了ConsumeQueue和IndexFile这两种索引文件系统，这两个文件系统的主要母的也是用于加快客户端的消费速度或者是查询效率。
**

**此前我们学习了broker的消息刷盘的源码，我们仅仅是了解了CommitLog文件刷盘的流程，现在我们来学习ConsumeQueue文件和IndexFile文件的构建流程
**

#### 文章目录

- 1 ReputMessageService消息重放服务
- 2 doReput执行重放
-
    - 2.1 isCommitLogAvailable是否需要重放
- 2.2 getData获取重放数据
-
    - 2.2.1 selectMappedBuffer截取一段内存
- 2.3 checkMessageAndReturnSize检查消息并构建请求
- 2.4 doDispatch分发请求
- 3 总结

## 1 ReputMessageService消息重放服务

ReputMessageService服务将会在循环中异步的每隔1ms对于写入CommitLog的消息进行重放，即将消息构建成为DispatchRequest对象，然后将DispatchRequest对象分发给各个CommitLogDispatcher处理，这些CommitLogDispatcher通常会尝试构建ConsumeQueue索引、IndexFile索引以及SQL92布隆过滤器。

ReputMessageService和此前介绍的刷盘服务一样，属于异步线程服务。其随着消息存储对象DefaultMessageStore的创建而创建，并且在DefaultMessageStore：start方法中被启动。我们直接看它的run方法。

```java
/**
 * ReputMessageService的方法
 */
@Override
public void run() {
   
     
    DefaultMessageStore.log.info(this.getServiceName() + " service started");
    /*
     * 运行时逻辑
     * 如果服务没有停止，则在死循环中执行重放的操作
     */
    while (!this.isStopped()) {
   
     
        try {
   
     
            //睡眠1ms
            Thread.sleep(1);
            //执行重放
            this.doReput();
        } catch (Exception e) {
   
     
            DefaultMessageStore.log.warn(this.getServiceName() + " service has exception. ", e);
        }
    }

    DefaultMessageStore.log.info(this.getServiceName() + " service end");
}
```

可以看到，该服务将会在一个循环中，每隔1ms执行一次duReput方法，doReput方法也就是重放的方法。

## 2 doReput执行重放

该方法对于写入CommitLog的消息进行重放，所谓的重放就是完成诸如ConsumeQueue索引、IndexFile索引、布隆过滤器、唤醒长轮询线程和被hold住的请求等操作。

该方法的大概逻辑为：

**1、** 如果重放偏移量reputFromOffset小于commitlog的最小物理偏移量，那么设置为commitlog的最小物理偏移量，如果重放偏移量小于commitlog的最大物理偏移量，那么循环重放；
**2、**
调用getData方法根据reputFromOffset的物理偏移量找到mappedFileQueue中对应的CommitLog文件的MappedFile，然后从该MappedFile中截取一段自reputFromOffset偏移量开始的ByteBuffer，这段内存存储着将要重放的消息；
**3、** 开始循环读取这段ByteBuffer中的消息，依次进行重放；

**1、** 如果存在消息，调用checkMessageAndReturnSize方法检查当前消息的属性并且构建一个DispatchRequest对象返回；

2. 调用doDispatch方法分发重放请求，将会调用所有CommitLogDispatcher#dispatch方法。

```
1.  CommitLogDispatcherBuildConsumeQueue：根据DispatchRequest写ConsumeQueue文件，构建ConsumeQueue索引。
2.  CommitLogDispatcherBuildIndex：根据DispatchRequest写IndexFile文件，构建IndexFile索引。
3.  CommitLogDispatcherCalcBitMap：根据DispatchRequest构建布隆过滤器，加速SQL92过滤效率，避免每次都解析sql。
```

**3、**
如果broker角色不是SLAVE，并且支持长轮询，并且消息送达的监听器不为null，那么通过该监听器的arriving方法触发调用pullRequestHoldService的pullRequestHoldService方法，即唤醒挂起的拉取消息请求，表示有新的消息落盘，可以进行拉取了；
**4、** 如果读取到MappedFile文件尾，那么获取下一个文件的起始索引继续重放；

```java
/**
 * DefaultMessageStore的方法
 * <p>
 * 执行重放
 */
private void doReput() {
   
     
    //如果重放偏移量reputFromOffset小于commitlog的最小物理偏移量，那么设置为commitlog的最小物理偏移量
    if (this.reputFromOffset < DefaultMessageStore.this.commitLog.getMinOffset()) {
   
     
        log.warn("The reputFromOffset={} is smaller than minPyOffset={}, this usually indicate that the dispatch behind too much and the commitlog has expired.",
                this.reputFromOffset, DefaultMessageStore.this.commitLog.getMinOffset());
        this.reputFromOffset = DefaultMessageStore.this.commitLog.getMinOffset();
    }
    /*
     *
     * 如果重放偏移量小于commitlog的最大物理偏移量，那么循环重放
     */
    for (boolean doNext = true; this.isCommitLogAvailable() && doNext; ) {
   
     
        //如果消息允许重复复制（默认为 false）并且reputFromOffset大于等于已确定的偏移量confirmOffset，那么结束循环
        if (DefaultMessageStore.this.getMessageStoreConfig().isDuplicationEnable()
                && this.reputFromOffset >= DefaultMessageStore.this.getConfirmOffset()) {
   
     
            break;
        }
        /*
         * 根据reputFromOffset的物理偏移量找到mappedFileQueue中对应的CommitLog文件的MappedFile
         * 然后从该MappedFile中截取一段自reputFromOffset偏移量开始的ByteBuffer，这段内存存储着将要重放的消息
         */
        SelectMappedBufferResult result = DefaultMessageStore.this.commitLog.getData(reputFromOffset);
        if (result != null) {
   
     
            try {
   
     
                //将截取的起始物理偏移量设置为重放偏起始移量
                this.reputFromOffset = result.getStartOffset();
                /*
                 * 开始读取这段ByteBuffer中的消息，依次进行重放
                 */
                for (int readSize = 0; readSize < result.getSize() && doNext; ) {
   
     
                    //检查消息的属性并且构建一个DispatchRequest对象返回
                    DispatchRequest dispatchRequest =
                            DefaultMessageStore.this.commitLog.checkMessageAndReturnSize(result.getByteBuffer(), false, false);
                    //消息大小，如果是基于Dledger技术的高可用DLedgerCommitLog则取bufferSize
                    int size = dispatchRequest.getBufferSize() == -1 ? dispatchRequest.getMsgSize() : dispatchRequest.getBufferSize();

                    if (dispatchRequest.isSuccess()) {
   
     
                        //如果大小大于0，表示有消息
                        if (size > 0) {
   
     
                            /*
                             * 分发请求
                             * 1.  CommitLogDispatcherBuildConsumeQueue：根据DispatchRequest写ConsumeQueue文件，构建ConsumeQueue索引。
                             * 2.  CommitLogDispatcherBuildIndex：根据DispatchRequest写IndexFile文件，构建IndexFile索引。
                             * 3.  CommitLogDispatcherCalcBitMap：根据DispatchRequest构建布隆过滤器，加速SQL92过滤效率，避免每次都解析sql。
                             */
                            DefaultMessageStore.this.doDispatch(dispatchRequest);
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
                            //设置重放偏起始移量加上当前消息大小
                            this.reputFromOffset += size;
                            //设置读取的大小加上当前消息大小
                            readSize += size;
                            //如果是SLAVE角色，那么存储数据的统计信息更新
                            if (DefaultMessageStore.this.getMessageStoreConfig().getBrokerRole() == BrokerRole.SLAVE) {
   
     
                                DefaultMessageStore.this.storeStatsService
                                        .getSinglePutMessageTopicTimesTotal(dispatchRequest.getTopic()).add(1);
                                DefaultMessageStore.this.storeStatsService
                                        .getSinglePutMessageTopicSizeTotal(dispatchRequest.getTopic())
                                        .add(dispatchRequest.getMsgSize());
                            }
                        } else if (size == 0) {
   
     
                            //如果等于0，表示读取到MappedFile文件尾
                            //获取下一个文件的起始索引
                            this.reputFromOffset = DefaultMessageStore.this.commitLog.rollNextFile(this.reputFromOffset);
                            //设置readSize为0，将会结束循环
                            readSize = result.getSize();
                        }
                    } else if (!dispatchRequest.isSuccess()) {
   
     

                        if (size > 0) {
   
     
                            log.error("[BUG]read total count not equals msg total size. reputFromOffset={}", reputFromOffset);
                            this.reputFromOffset += size;
                        } else {
   
     
                            doNext = false;
                            // If user open the dledger pattern or the broker is master node,
                            // it will not ignore the exception and fix the reputFromOffset variable
                            if (DefaultMessageStore.this.getMessageStoreConfig().isEnableDLegerCommitLog() ||
                                    DefaultMessageStore.this.brokerConfig.getBrokerId() == MixAll.MASTER_ID) {
   
     
                                log.error("[BUG]dispatch message to consume queue error, COMMITLOG OFFSET: {}",
                                        this.reputFromOffset);
                                this.reputFromOffset += result.getSize() - readSize;
                            }
                        }
                    }
                }
            } finally {
   
     
                result.release();
            }
        } else {
   
     
            //如果重做完毕，则跳出循环
            doNext = false;
        }
    }
}
```

### 2.1 isCommitLogAvailable是否需要重放

该方法用于判断CommitLog是否需要执行重放，如果重放偏移量小于commitlog的最大物理偏移量，那么就需要执行重放。

```java
/**
 * ReputMessageService的方法
 * CommitLog是否需要执行重放
 */
private boolean isCommitLogAvailable() {
   
     
    //重放偏移量是否小于commitlog的最大物理偏移量
    return this.reputFromOffset < DefaultMessageStore.this.commitLog.getMaxOffset();
}
```

### 2.2 getData获取重放数据

根据reputFromOffset的物理偏移量找到mappedFileQueue中对应的CommitLog文件的MappedFile，然后从该MappedFile中截取一段自reputFromOffset偏移量开始的ByteBuffer，这段内存存储着将要重放的消息。

```java
/**
 * CommitLog的方法
 *
 * 获取CommitLog的数据
 */
public SelectMappedBufferResult getData(final long offset) {
   
     
    return this.getData(offset, offset == 0);
}

public SelectMappedBufferResult getData(final long offset, final boolean returnFirstOnNotFound) {
   
     
    //获取CommitLog文件大小，默认1G
    int mappedFileSize = this.defaultMessageStore.getMessageStoreConfig().getMappedFileSizeCommitLog();
    //根据指定的offset从mappedFileQueue中对应的CommitLog文件的MappedFile
    MappedFile mappedFile = this.mappedFileQueue.findMappedFileByOffset(offset, returnFirstOnNotFound);
    if (mappedFile != null) {
   
     
        //通过指定物理偏移量，除以文件大小，得到指定的相对偏移量
        int pos = (int) (offset % mappedFileSize);
        //从指定相对偏移量开始截取一段ByteBuffer，这段内存存储着将要重放的消息。
        SelectMappedBufferResult result = mappedFile.selectMappedBuffer(pos);
        return result;
    }

    return null;
}
```

#### 2.2.1 selectMappedBuffer截取一段内存

从指定相对偏移量开始从指定MappedFile中的mappedByteBuffer中截取一段ByteBuffer，这段内存存储着将要重放的消息。这段ByteBuffer和原mappedByteBuffer共享同一块内存，但是拥有自己的指针。

然后根据起始物理索引、截取的ByteBuffer、截取的ByteBuffer大小以及当前CommitLog对象构建一个SelectMappedBufferResult对象返回。

```java
/**
 * MappedFile的方法
 * @param pos 相对偏移量
 */
public SelectMappedBufferResult selectMappedBuffer(int pos) {
   
     
    //获取写入位置，即最大偏移量
    int readPosition = getReadPosition();
    //如果指定相对偏移量小于最大偏移量并且大于等于0，那么截取内存
    if (pos < readPosition && pos >= 0) {
   
     
        if (this.hold()) {
   
     
            //从mappedByteBuffer截取一段内存
            ByteBuffer byteBuffer = this.mappedByteBuffer.slice();
            byteBuffer.position(pos);
            int size = readPosition - pos;
            ByteBuffer byteBufferNew = byteBuffer.slice();
            byteBufferNew.limit(size);
            //根据起始物理索引、新的ByteBuffer、ByteBuffer大小、当前CommitLog对象构建一个SelectMappedBufferResult对象返回
            return new SelectMappedBufferResult(this.fileFromOffset + pos, byteBufferNew, size, this);
        }
    }

    return null;
}
```

### 2.3 checkMessageAndReturnSize检查消息并构建请求

该方法将会检查这段内存中的下一条消息，这里我们仅仅需要读取消息的各种属性即可，不需要读取具体的消息内容body。最后并且根据这些属性构建一个DispatchRequest对象返回。

**需要注意这里有个对于延迟消息的特殊处理，即tagCode属性，对于普通消息就是tags的hashCode值，对于延迟消息则是消息将来投递的时间戳，用于用于后续判断消息是否到期。
**

```java
/**
 * CommitLog的方法
 *
 * @param byteBuffer 一段内存
 * @param checkCRC   是否校验CRC
 * @param readBody   是否读取消息体
 */
public DispatchRequest checkMessageAndReturnSize(java.nio.ByteBuffer byteBuffer, final boolean checkCRC,
                                                 final boolean readBody) {
   
     
    try {
   
     
        // 1 TOTAL SIZE
        //消息条目总长度
        int totalSize = byteBuffer.getInt();

        // 2 MAGIC CODE
        //消息的magicCode属性，魔数，用来判断消息是正常消息还是空消息
        int magicCode = byteBuffer.getInt();
        switch (magicCode) {
   
     
            case MESSAGE_MAGIC_CODE:
                break;
            case BLANK_MAGIC_CODE:
                //读取到文件末尾
                return new DispatchRequest(0, true /* success */);
            default:
                log.warn("found a illegal magic code 0x" + Integer.toHexString(magicCode));
                return new DispatchRequest(-1, false /* success */);
        }

        byte[] bytesContent = new byte[totalSize];
        //消息体CRC校验码
        int bodyCRC = byteBuffer.getInt();
        //消息消费队列id
        int queueId = byteBuffer.getInt();
        //消息flag
        int flag = byteBuffer.getInt();
        //消息在消息消费队列的偏移量
        long queueOffset = byteBuffer.getLong();
        //消息在commitlog中的偏移量
        long physicOffset = byteBuffer.getLong();
        //消息系统flag，例如是否压缩、是否是事务消息
        int sysFlag = byteBuffer.getInt();
        //消息生产者调用消息发送API的时间戳
        long bornTimeStamp = byteBuffer.getLong();
        //消息发送者的IP和端口号
        ByteBuffer byteBuffer1;
        if ((sysFlag & MessageSysFlag.BORNHOST_V6_FLAG) == 0) {
   
     
            byteBuffer1 = byteBuffer.get(bytesContent, 0, 4 + 4);
        } else {
   
     
            byteBuffer1 = byteBuffer.get(bytesContent, 0, 16 + 4);
        }
        //消息存储时间
        long storeTimestamp = byteBuffer.getLong();
        //broker的IP和端口号
        ByteBuffer byteBuffer2;
        if ((sysFlag & MessageSysFlag.STOREHOSTADDRESS_V6_FLAG) == 0) {
   
     
            byteBuffer2 = byteBuffer.get(bytesContent, 0, 4 + 4);
        } else {
   
     
            byteBuffer2 = byteBuffer.get(bytesContent, 0, 16 + 4);
        }
        //消息重试次数
        int reconsumeTimes = byteBuffer.getInt();
        //事务消息物理偏移量
        long preparedTransactionOffset = byteBuffer.getLong();
        //消息体长度
        int bodyLen = byteBuffer.getInt();
        if (bodyLen > 0) {
   
     
            //读取消息体
            if (readBody) {
   
     
                byteBuffer.get(bytesContent, 0, bodyLen);

                if (checkCRC) {
   
     
                    int crc = UtilAll.crc32(bytesContent, 0, bodyLen);
                    if (crc != bodyCRC) {
   
     
                        log.warn("CRC check failed. bodyCRC={}, currentCRC={}", crc, bodyCRC);
                        return new DispatchRequest(-1, false/* success */);
                    }
                }
            } else {
   
     
                //不需要读取消息体，那么跳过这段内存
                byteBuffer.position(byteBuffer.position() + bodyLen);
            }
        }
        //Topic名称内容大小
        byte topicLen = byteBuffer.get();
        byteBuffer.get(bytesContent, 0, topicLen);
        //topic的值
        String topic = new String(bytesContent, 0, topicLen, MessageDecoder.CHARSET_UTF8);

        long tagsCode = 0;
        String keys = "";
        String uniqKey = null;
        //消息属性大小
        short propertiesLength = byteBuffer.getShort();
        Map<String, String> propertiesMap = null;
        if (propertiesLength > 0) {
   
     
            byteBuffer.get(bytesContent, 0, propertiesLength);
            //消息属性
            String properties = new String(bytesContent, 0, propertiesLength, MessageDecoder.CHARSET_UTF8);
            propertiesMap = MessageDecoder.string2messageProperties(properties);

            keys = propertiesMap.get(MessageConst.PROPERTY_KEYS);
            //客户端生成的uniqId，也被称为msgId，从逻辑上代表客户端生成的唯一一条消息
            uniqKey = propertiesMap.get(MessageConst.PROPERTY_UNIQ_CLIENT_MESSAGE_ID_KEYIDX);
            //tag
            String tags = propertiesMap.get(MessageConst.PROPERTY_TAGS);
            //普通消息的tagsCode被设置为tag的hashCode
            if (tags != null && tags.length() > 0) {
   
     
                tagsCode = MessageExtBrokerInner.tagsString2tagsCode(MessageExt.parseTopicFilterType(sysFlag), tags);
            }

            /*
             * 延迟消息处理
             * 对于延迟消息，tagsCode被替换为延迟消息的发送时间，主要用于后续判断消息是否到期
             */
            {
   
     
                //消息属性中获取延迟级别DELAY字段，如果是延迟消息则生产者会在构建消息的时候设置进去
                String t = propertiesMap.get(MessageConst.PROPERTY_DELAY_TIME_LEVEL);
                //如果topic是SCHEDULE_TOPIC_XXXX，即延迟消息的topic
                if (TopicValidator.RMQ_SYS_SCHEDULE_TOPIC.equals(topic) && t != null) {
   
     
                    int delayLevel = Integer.parseInt(t);

                    if (delayLevel > this.defaultMessageStore.getScheduleMessageService().getMaxDelayLevel()) {
   
     
                        delayLevel = this.defaultMessageStore.getScheduleMessageService().getMaxDelayLevel();
                    }

                    if (delayLevel > 0) {
   
     
                        //tagsCode被替换为延迟消息的发送时间，即真正投递时间
                        tagsCode = this.defaultMessageStore.getScheduleMessageService().computeDeliverTimestamp(delayLevel,
                                storeTimestamp);
                    }
                }
            }
        }
        //读取的当前消息的大小
        int readLength = calMsgLength(sysFlag, bodyLen, topicLen, propertiesLength);
        //不相等则记录BUG
        if (totalSize != readLength) {
   
     
            doNothingForDeadCode(reconsumeTimes);
            doNothingForDeadCode(flag);
            doNothingForDeadCode(bornTimeStamp);
            doNothingForDeadCode(byteBuffer1);
            doNothingForDeadCode(byteBuffer2);
            log.error(
                    "[BUG]read total count not equals msg total size. totalSize={}, readTotalCount={}, bodyLen={}, topicLen={}, propertiesLength={}",
                    totalSize, readLength, bodyLen, topicLen, propertiesLength);
            return new DispatchRequest(totalSize, false/* success */);
        }
        //根据读取的消息属性内容，构建为一个DispatchRequest对象并返回
        return new DispatchRequest(
                topic,
                queueId,
                physicOffset,
                totalSize,
                tagsCode,
                storeTimestamp,
                queueOffset,
                keys,
                uniqKey,
                sysFlag,
                preparedTransactionOffset,
                propertiesMap
        );
    } catch (Exception e) {
   
     
    }
    //读取异常
    return new DispatchRequest(-1, false /* success */);
}
```

### 2.4 doDispatch分发请求

该方法将构建的DispatchRequest分发出去，即循环调用DefaultMessageStore内部的dispatcherList中的CommitLogDispatcher的dispatch方法，取处理这个请求。

这个方法可以说是ReputMessageService服务的核心代码了，表面面上看仅仅是分发请求。实际上，ConsumeQueue索引、IndexFile索引等操作都是由对应的CommitLogDispatcher来负责实现的。

**DefaultMessageStore内部的dispatcherList默认有三个CommitLogDispatcher：**

**1、** **CommitLogDispatcherBuildConsumeQueue**：根据DispatchRequest写ConsumeQueue文件，构建ConsumeQueue索引；
**2、** **CommitLogDispatcherBuildIndex**：根据DispatchRequest写IndexFile文件，构建IndexFile索引；
**3、** **CommitLogDispatcherCalcBitMap**：根据DispatchRequest构建布隆过滤器，加速SQL92过滤效率，避免每次都解析sql；

```java
/**
 * DefaultMessageStore的方法
 *
 * @param req 分发请求
 */
public void doDispatch(DispatchRequest req) {
   
     
    //循环调用CommitLogDispatcher#dispatch处理
    for (CommitLogDispatcher dispatcher : this.dispatcherList) {
   
     
        dispatcher.dispatch(req);
    }
}
```

## 3 总结

*
*本次我们学习了ReputMessageService消息重放服务的总体流程，下一篇文章我们将深入学习CommitLogDispatcherBuildConsumeQueue、CommitLogDispatcherBuildIndex到底是如何构建异步构建ConsumeQueue和IndexFile索引文件的。
**