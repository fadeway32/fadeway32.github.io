---

layout: 11、RocketMQ源码分析：BrokerasyncPutMessage处理消息以及存储的高性能设计【一万字】

title:  11、RocketMQ源码分析：BrokerasyncPutMessage处理消息以及存储的高性能设计【一万字】

tags: RocketMq

categories: Web

top: 56

path: /article/1739713336

abbrlink: 1739713336

date: 2025-02-16 21:42:06


--- 

# 11、RocketMQ源码分析：BrokerasyncPutMessage处理消息以及存储的高性能设计【一万字】

此前我们学习了[RocketMQ源码(10)—Broker asyncSendMessage处理消息以及自动创建Topic](https://blog.csdn.net/weixin_43767015/article/details/127133660)
的整体流程，从流程中我们知道asyncPutMessage方法真正的用来存储消息。现在我们来看看这个方法的源码。

#### 文章目录

- 1 asyncPutMessage存储普通消息
-
    - 1.1 checkStoreStatus检查存储状态
- 1.2 checkMessage检查消息
- 2 CommitLog#asyncPutMessage异步存储消息
-
    - 2.1 处理延迟消息
- 2.2 获取最新mappedFile
-
    - 2.1.1 tryCreateMappedFile创建新的MappedFile
    - 2.1.2 putRequestAndReturnMappedFile异步创建MappedFile
    - 2.1.3 AllocateMappedFileService创建MappedFile
    - 2.1.4 mmapOperation执行mmap操作
    -
        - 2.1.4.1 采用mmap
        - 2.1.4.2 采用堆外内存
    - 2.1.5 warmMappedFile文件预热
    - 2.1.6 mlock锁定内存
- 2.3 appendMessage追加存储消息
-
    -
        - 2.3.1 doAppend执行追加
    - 2.3.2 消息序列化
- 3 存储高性能设计总结

## 1 asyncPutMessage存储普通消息

普通消息的处理、存储入口方法是DefaultMessageStore#asyncPutMessage方法。

首先会调用checkStoreStatus、checkMessage、checkLmqMessage方法进行一系列的前置校验，如果通过了，则调用CommitLog#asyncPutMessage方法真正的存储消息，最后会更新耗费的时间或者失败次数。

```java
/**
* DefaultMessageStore的方法
* <p>
* 处理、存储消息
*
* @param msg 需要存储的MessageInstance
*/
@Override
    public CompletableFuture<PutMessageResult> asyncPutMessage(MessageExtBrokerInner msg) {
   
     
    /*
* 1 检查存储状态
*/
    PutMessageStatus checkStoreStatus = this.checkStoreStatus();
//如果不是PUT_OK就直接返回了
if (checkStoreStatus != PutMessageStatus.PUT_OK) {
   
     
    return CompletableFuture.completedFuture(new PutMessageResult(checkStoreStatus, null));
}
/*
* 2 检查消息
*/
PutMessageStatus msgCheckStatus = this.checkMessage(msg);
if (msgCheckStatus == PutMessageStatus.MESSAGE_ILLEGAL) {
   
     
    return CompletableFuture.completedFuture(new PutMessageResult(msgCheckStatus, null));
}
/*
* 2 检查 light message queue(LMQ)，即微消息队列
*/
PutMessageStatus lmqMsgCheckStatus = this.checkLmqMessage(msg);
if (msgCheckStatus == PutMessageStatus.LMQ_CONSUME_QUEUE_NUM_EXCEEDED) {
   
     
    return CompletableFuture.completedFuture(new PutMessageResult(lmqMsgCheckStatus, null));
}

//当前时间戳
long beginTime = this.getSystemClock().now();
/*
* 核心方法，调用CommitLog#asyncPutMessage方法存储消息
*/
CompletableFuture<PutMessageResult> putResultFuture = this.commitLog.asyncPutMessage(msg);

putResultFuture.thenAccept((result) -> {
   
     
    //存储消息消耗的时间
    long elapsedTime = this.getSystemClock().now() - beginTime;
    if (elapsedTime > 500) {
   
     
        log.warn("putMessage not in lock elapsed time(ms)={}, bodyLength={}", elapsedTime, msg.getBody().length);
    }
    //更新统计保存消息花费的时间和最大花费的时间
    this.storeStatsService.setPutMessageEntireTimeMax(elapsedTime);

    if (null == result || !result.isOk()) {
   
     
        //如果存储失败在，则增加保存消息失败的次数
        this.storeStatsService.getPutMessageFailedTimes().add(1);
    }
});

return putResultFuture;
}
```

### 1.1 checkStoreStatus检查存储状态

首先就会检查消息存储状态，看是否支持写入消息：

**1、** 如果DefaultMessageStore是shutdown状态，返回SERVICE_NOT_AVAILABLE；
**2、** 如果broker是SLAVE角色，则返回SERVICE_NOT_AVAILABLE，不能将消息写入SLAVE角色；
**3、** 如果不支持写入，那么返回SERVICE_NOT_AVAILABLE，可能因为broker的磁盘已满、写入逻辑队列错误、写入索引文件错误等等原因；
**4、** 如果操作系统页缓存繁忙，则返回OS_PAGECACHE_BUSY，如果broker持有锁的时间超过osPageCacheBusyTimeOutMills，则算作操作系统页缓存繁忙；
**5、** 返回PUT_OK，表示可以存储消息；

```java
/**
 * DefaultMessageStore的方法
 * <p>
 * 检查存储状态
 */
private PutMessageStatus checkStoreStatus() {
   
     
    //如果DefaultMessageStore是shutdown状态，返回SERVICE_NOT_AVAILABLE
    if (this.shutdown) {
   
     
        log.warn("message store has shutdown, so putMessage is forbidden");
        return PutMessageStatus.SERVICE_NOT_AVAILABLE;
    }
    //如果broker是SLAVE角色，则返回SERVICE_NOT_AVAILABLE，不能将消息写入SLAVE角色
    if (BrokerRole.SLAVE == this.messageStoreConfig.getBrokerRole()) {
   
     
        long value = this.printTimes.getAndIncrement();
        if ((value % 50000) == 0) {
   
     
            log.warn("broke role is slave, so putMessage is forbidden");
        }
        return PutMessageStatus.SERVICE_NOT_AVAILABLE;
    }
    //如果不支持写入，那么返回SERVICE_NOT_AVAILABLE
    //可能因为broker的磁盘已满、写入逻辑队列错误、写入索引文件错误等等原因
    if (!this.runningFlags.isWriteable()) {
   
     
        long value = this.printTimes.getAndIncrement();
        if ((value % 50000) == 0) {
   
     
            log.warn("the message store is not writable. It may be caused by one of the following reasons: " +
                    "the broker's disk is full, write to logic queue error, write to index file error, etc");
        }
        return PutMessageStatus.SERVICE_NOT_AVAILABLE;
    } else {
   
     
        this.printTimes.set(0);
    }
    //如果操作系统页缓存繁忙，则返回OS_PAGECACHE_BUSY
    //如果broker持有锁的时间超过osPageCacheBusyTimeOutMills，则算作操作系统页缓存繁忙
    if (this.isOSPageCacheBusy()) {
   
     
        return PutMessageStatus.OS_PAGECACHE_BUSY;
    }
    //返回PUT_OK，表示可以存储消息
    return PutMessageStatus.PUT_OK;
}
```

### 1.2 checkMessage检查消息

检查消息，看是否符合要求：

**1、** 如果topic长度大于127，则返回MESSAGE_ILLEGAL，表示topic过长了；
**2、** 如果设置的属性长度大于32767，则返回MESSAGE_ILLEGAL，表示properties过长了；
**3、** 否则，返回PUT_OK，表示检查通过；

```java
/**
 * DefaultMessageStore的方法
 * <p>
 * 检查消息
 */
private PutMessageStatus checkMessage(MessageExtBrokerInner msg) {
   
     
    //如果topic长度大于127，则返回MESSAGE_ILLEGAL，表示topic过长了
    if (msg.getTopic().length() > Byte.MAX_VALUE) {
   
     
        log.warn("putMessage message topic length too long " + msg.getTopic().length());
        return PutMessageStatus.MESSAGE_ILLEGAL;
    }
    //如果设置的属性长度大于32767，则返回MESSAGE_ILLEGAL，表示properties过长了
    if (msg.getPropertiesString() != null && msg.getPropertiesString().length() > Short.MAX_VALUE) {
   
     
        log.warn("putMessage message properties length too long " + msg.getPropertiesString().length());
        return PutMessageStatus.MESSAGE_ILLEGAL;
    }
    return PutMessageStatus.PUT_OK;
}
```

## 2 CommitLog#asyncPutMessage异步存储消息

**该方法中将会对消息进行真正的保存，即持久化操作，步骤比较繁杂，但同样属于RocketMQ源码的精髓，值得一看**。其大概步骤为：

**1、** 处理延迟消息的逻辑；

**1、**
如果是延迟消息，即DelayTimeLevel大于0，那么替换topic为SCHEDULE_TOPIC_XXXX，替换queueId为延迟队列id，id=level-1，如果延迟级别大于最大级别，则设置为最大级别18，，默认延迟2h这些参数可以在broker端配置类MessageStoreConfig中配置；
**2、** 最后保存真实topic到消息的REAL_TOPIC属性，保存queueId到消息的REAL_QID属性，方便后面恢复；
**2、**
消息编码获取线程本地变量，其内部包含一个线程独立的encoder和keyBuilder对象将消息内容编码，存储到encoder内部的encoderBuffer中，它是通过ByteBuffer.allocateDirect(
size)得到的一个直接缓冲区消息写入之后，会调用encoderBuffer.flip()方法，将Buffer从写模式切换到读模式，可以读取到数据；
**3、** 加锁并写入消息；

**1、**
一个broker将所有的消息都追加到同一个逻辑CommitLog日志文件中，因此需要通过获取putMessageLock锁来控制并发有两种锁，一种是ReentrantLock可重入锁，另一种spin则是CAS锁根据StoreConfig的useReentrantLockWhenPutMessage决定是否使用可重入锁，默认为true，使用可重入锁；
**2、** 从mappedFileQueue中的mappedFiles集合中获取最后一个MappedFile如果最新mappedFile为null，或者mappedFile满了，那么会新建mappedFile；
**3、**
通过mappedFile调用appendMessage方法追加消息，这里仅仅是追加消息到byteBuffer的内存中如果是writeBuffer则表示消息写入了堆外内存中，如果是mappedByteBuffer，则表示消息写入了pagechache中总之，都是存储在内存之中；
**4、** 追加成功之后解锁如果是剩余空间不足，则会重新初始化一个MappedFile并再次尝试追加；
**4、** 如果存在写满的MappedFile并且启用了文件内存预热，那么这里调用unlockMappedFile对MappedFile执行解锁；
**5、** 更新消息统计信息随后调用submitFlushRequest方法提交刷盘请求，将会根据刷盘策略进行刷盘随后调用submitReplicaRequest方法提交副本请求，用于主从同步；

```java
/**
     * CommitLog的方法
     * <p>
     * 异步存储消息
     *
     * @param msg
     * @return
     */
    public CompletableFuture<PutMessageResult> asyncPutMessage(final MessageExtBrokerInner msg) {
   
     
        // Set the storage time
        //设置存储时间
        msg.setStoreTimestamp(System.currentTimeMillis());
        // Set the message body BODY CRC (consider the most appropriate setting
        // on the client)
        //设置消息正文CRC
        msg.setBodyCRC(UtilAll.crc32(msg.getBody()));
        // Back to Results
        AppendMessageResult result = null;

        StoreStatsService storeStatsService = this.defaultMessageStore.getStoreStatsService();

        String topic = msg.getTopic();
//        int queueId msg.getQueueId();
        /*
         * 1 处理延迟消息的逻辑
         *
         * 替换topic和queueId，保存真实topic和queueId
         */
        //根据sysFlag获取事务状态，普通消息的sysFlag为0
        final int tranType = MessageSysFlag.getTransactionValue(msg.getSysFlag());
        //如果不是事务消息，或者commit提交事务小i
        if (tranType == MessageSysFlag.TRANSACTION_NOT_TYPE
                || tranType == MessageSysFlag.TRANSACTION_COMMIT_TYPE) {
   
     
            // Delay Delivery
            //获取延迟级别，判断是否是延迟消息
            if (msg.getDelayTimeLevel() > 0) {
   
     
                //如果延迟级别大于最大级别，则设置为最大级别
                if (msg.getDelayTimeLevel() > this.defaultMessageStore.getScheduleMessageService().getMaxDelayLevel()) {
   
     
                    msg.setDelayTimeLevel(this.defaultMessageStore.getScheduleMessageService().getMaxDelayLevel());
                }
                //获取延迟队列的topic，固定为 SCHEDULE_TOPIC_XXXX
                topic = TopicValidator.RMQ_SYS_SCHEDULE_TOPIC;
                //根据延迟等级获取对应的延迟队列id， id = level - 1
                int queueId = ScheduleMessageService.delayLevel2QueueId(msg.getDelayTimeLevel());

                // Backup real topic, queueId
                //使用扩展属性REAL_TOPIC 记录真实topic
                MessageAccessor.putProperty(msg, MessageConst.PROPERTY_REAL_TOPIC, msg.getTopic());
                //使用扩展属性REAL_QID 记录真实queueId
                MessageAccessor.putProperty(msg, MessageConst.PROPERTY_REAL_QUEUE_ID, String.valueOf(msg.getQueueId()));
                msg.setPropertiesString(MessageDecoder.messageProperties2String(msg.getProperties()));
                //更改topic和queueId为延迟队列的topic和queueId
                msg.setTopic(topic);
                msg.setQueueId(queueId);
            }
        }
        //发送消息的地址
        InetSocketAddress bornSocketAddress = (InetSocketAddress) msg.getBornHost();
        if (bornSocketAddress.getAddress() instanceof Inet6Address) {
   
     
            msg.setBornHostV6Flag();
        }
        //存储消息的地址
        InetSocketAddress storeSocketAddress = (InetSocketAddress) msg.getStoreHost();
        if (storeSocketAddress.getAddress() instanceof Inet6Address) {
   
     
            msg.setStoreHostAddressV6Flag();
        }
        /*
         * 2 消息编码
         */
        //获取线程本地变量，其内部包含一个线程独立的encoder和keyBuilder对象
        PutMessageThreadLocal putMessageThreadLocal = this.putMessageThreadLocal.get();
        //将消息内容编码，存储到encoder内部的encoderBuffer中，它是通过ByteBuffer.allocateDirect(size)得到的一个直接缓冲区
        //消息写入之后，会调用encoderBuffer.flip()方法，将Buffer从写模式切换到读模式，可以读取到数据
        PutMessageResult encodeResult = putMessageThreadLocal.getEncoder().encode(msg);
        if (encodeResult != null) {
   
     
            return CompletableFuture.completedFuture(encodeResult);
        }
        //编码后的encoderBuffer暂时存入msg的encodedBuff中
        msg.setEncodedBuff(putMessageThreadLocal.getEncoder().encoderBuffer);
        //存储消息上下文
        PutMessageContext putMessageContext = new PutMessageContext(generateKey(putMessageThreadLocal.getKeyBuilder(), msg));
        /*
         * 3 加锁并写入消息
         * 一个broker将所有的消息都追加到同一个逻辑CommitLog日志文件中，因此需要通过获取putMessageLock锁来控制并发。
         */
        //持有锁的时间
        long elapsedTimeInLock = 0;
        MappedFile unlockMappedFile = null;
        /*
         * 有两种锁，一种是ReentrantLock可重入锁，另一种spin则是CAS锁
         * 根据StoreConfig的useReentrantLockWhenPutMessage决定是否使用可重入锁，默认为true，使用可重入锁。
         */
        putMessageLock.lock(); //spin or ReentrantLock ,depending on store config
        try {
   
     
            /*
             * 从mappedFileQueue中的mappedFiles集合中获取最后一个MappedFile
             */
            MappedFile mappedFile = this.mappedFileQueue.getLastMappedFile();
            //加锁后的起始时间
            long beginLockTimestamp = this.defaultMessageStore.getSystemClock().now();
            this.beginTimeInLock = beginLockTimestamp;

            // Here settings are stored timestamp, in order to ensure an orderly
            // global
            //设置存储的时间戳为加锁后的起始时间，保证有序
            msg.setStoreTimestamp(beginLockTimestamp);
            /*
             * 如果最新mappedFile为null，或者mappedFile满了，那么会新建mappedFile并返回
             */
            if (null == mappedFile || mappedFile.isFull()) {
   
     
                mappedFile = this.mappedFileQueue.getLastMappedFile(0); // Mark: NewFile may be cause noise
            }
            if (null == mappedFile) {
   
     
                log.error("create mapped file1 error, topic: " + msg.getTopic() + " clientAddr: " + msg.getBornHostString());
                return CompletableFuture.completedFuture(new PutMessageResult(PutMessageStatus.CREATE_MAPEDFILE_FAILED, null));
            }
            /*
             *  追加存储消息
             */
            result = mappedFile.appendMessage(msg, this.appendMessageCallback, putMessageContext);
            switch (result.getStatus()) {
   
     
                case PUT_OK:
                    break;
                case END_OF_FILE:
                    //文件剩余空间不足，那么初始化新的文件并尝试再次存储
                    unlockMappedFile = mappedFile;
                    // Create a new file, re-write the message
                    mappedFile = this.mappedFileQueue.getLastMappedFile(0);
                    if (null == mappedFile) {
   
     
                        // XXX: warn and notify me
                        log.error("create mapped file2 error, topic: " + msg.getTopic() + " clientAddr: " + msg.getBornHostString());
                        return CompletableFuture.completedFuture(new PutMessageResult(PutMessageStatus.CREATE_MAPEDFILE_FAILED, result));
                    }
                    result = mappedFile.appendMessage(msg, this.appendMessageCallback, putMessageContext);
                    break;
                case MESSAGE_SIZE_EXCEEDED:
                case PROPERTIES_SIZE_EXCEEDED:
                    return CompletableFuture.completedFuture(new PutMessageResult(PutMessageStatus.MESSAGE_ILLEGAL, result));
                case UNKNOWN_ERROR:
                    return CompletableFuture.completedFuture(new PutMessageResult(PutMessageStatus.UNKNOWN_ERROR, result));
                default:
                    return CompletableFuture.completedFuture(new PutMessageResult(PutMessageStatus.UNKNOWN_ERROR, result));
            }
            //加锁的持续时间
            elapsedTimeInLock = this.defaultMessageStore.getSystemClock().now() - beginLockTimestamp;
        } finally {
   
     
            //重置开始时间，释放锁
            beginTimeInLock = 0;
            putMessageLock.unlock();
        }

        if (elapsedTimeInLock > 500) {
   
     
            log.warn("[NOTIFYME]putMessage in lock cost time(ms)={}, bodyLength={} AppendMessageResult={}", elapsedTimeInLock, msg.getBody().length, result);
        }
        //如果存在写满的MappedFile并且启用了文件内存预热，那么这里对MappedFile执行解锁
        if (null != unlockMappedFile && this.defaultMessageStore.getMessageStoreConfig().isWarmMapedFileEnable()) {
   
     
            this.defaultMessageStore.unlockMappedFile(unlockMappedFile);
        }

        PutMessageResult putMessageResult = new PutMessageResult(PutMessageStatus.PUT_OK, result);

        // Statistics
        //存储数据的统计信息更新
        storeStatsService.getSinglePutMessageTopicTimesTotal(msg.getTopic()).add(1);
        storeStatsService.getSinglePutMessageTopicSizeTotal(topic).add(result.getWroteBytes());
        /*
         * 4 提交刷盘请求，将会根据刷盘策略进行刷盘
         */
        CompletableFuture<PutMessageStatus> flushResultFuture = submitFlushRequest(result, msg);
        /*
         * 5 提交副本请求，用于主从同步
         */
        CompletableFuture<PutMessageStatus> replicaResultFuture = submitReplicaRequest(result, msg);
        return flushResultFuture.thenCombine(replicaResultFuture, (flushStatus, replicaStatus) -> {
   
     
            if (flushStatus != PutMessageStatus.PUT_OK) {
   
     
                putMessageResult.setPutMessageStatus(flushStatus);
            }
            if (replicaStatus != PutMessageStatus.PUT_OK) {
   
     
                putMessageResult.setPutMessageStatus(replicaStatus);
            }
            return putMessageResult;
        });
    }
```

### 2.1 处理延迟消息

如果是延迟消息，即DelayTimeLevel大于0，那么替换topic为SCHEDULE_TOPIC_XXXX，替换queueId为延迟队列id， id = level -
1，如果延迟级别大于最大级别，则设置为最大级别18，，默认延迟2h。这些参数可以在broker端配置类MessageStoreConfig中配置。

最后保存真实topic到消息的REAL_TOPIC属性，保存queueId到消息的REAL_QID属性，方便后面恢复。

```java
/*
 * 1 处理延迟消息的逻辑
 *
 * 替换topic和queueId，保存真实topic和queueId
 */
//根据sysFlag获取事务状态，普通消息的sysFlag为0
final int tranType = MessageSysFlag.getTransactionValue(msg.getSysFlag());
//如果不是事务消息，或者commit提交事务消息
if (tranType == MessageSysFlag.TRANSACTION_NOT_TYPE
        || tranType == MessageSysFlag.TRANSACTION_COMMIT_TYPE) {
   
     
    // Delay Delivery
    //获取延迟级别，判断是否是延迟消息
    if (msg.getDelayTimeLevel() > 0) {
   
     
        //如果延迟级别大于最大级别，则设置为最大级别
        if (msg.getDelayTimeLevel() > this.defaultMessageStore.getScheduleMessageService().getMaxDelayLevel()) {
   
     
            msg.setDelayTimeLevel(this.defaultMessageStore.getScheduleMessageService().getMaxDelayLevel());
        }
        //获取延迟队列的topic，固定为 SCHEDULE_TOPIC_XXXX
        topic = TopicValidator.RMQ_SYS_SCHEDULE_TOPIC;
        //根据延迟等级获取对应的延迟队列id， id = level - 1
        int queueId = ScheduleMessageService.delayLevel2QueueId(msg.getDelayTimeLevel());

        // Backup real topic, queueId
        //使用扩展属性REAL_TOPIC 记录真实topic
        MessageAccessor.putProperty(msg, MessageConst.PROPERTY_REAL_TOPIC, msg.getTopic());
        //使用扩展属性REAL_QID 记录真实queueId
        MessageAccessor.putProperty(msg, MessageConst.PROPERTY_REAL_QUEUE_ID, String.valueOf(msg.getQueueId()));
        msg.setPropertiesString(MessageDecoder.messageProperties2String(msg.getProperties()));
        //更改topic和queueId为延迟队列的topic和queueId
        msg.setTopic(topic);
        msg.setQueueId(queueId);
    }
}
```

### 2.2 获取最新mappedFile

首先从mappedFileQueue中的mappedFiles集合中获取最后一个MappedFile。

```java
/**
 * MappedFileQueue的方法
 * <p>
 * 获取最新的MappedFile
 */
public MappedFile getLastMappedFile() {
   
     
    MappedFile mappedFileLast = null;

    while (!this.mappedFiles.isEmpty()) {
   
     
        try {
   
     
            //从mappedFiles中获取最后一个mappedFile
            mappedFileLast = this.mappedFiles.get(this.mappedFiles.size() - 1);
            break;
        } catch (IndexOutOfBoundsException e) {
   
     
            //continue;
        } catch (Exception e) {
   
     
            log.error("getLastMappedFile has exception.", e);
            break;
        }
    }

    return mappedFileLast;
}
```

如果最新mappedFile为null，或者mappedFile满了，那么会新建mappedFile。

```java
/**
 * MappedFileQueue的方法
 * <p>
 * 创建新的MappedFile
 *
 * @param startOffset 指定起始offset
 */
public MappedFile getLastMappedFile(final long startOffset) {
   
     
    return getLastMappedFile(startOffset, true);
}

/**
 * MappedFileQueue的方法
 * <p>
 * 创建或者获取最新的MappedFile
 *
 * @param startOffset 起始offset
 * @param needCreate  是否创建
 */
public MappedFile getLastMappedFile(final long startOffset, boolean needCreate) {
   
     
    long createOffset = -1;
    //从mappedFiles集合中获取最后一个MappedFile
    MappedFile mappedFileLast = getLastMappedFile();
    //如果为null，那么设置创建索引，默认为0，即新建的文件为第一个mappedFile文件，从0开始
    if (mappedFileLast == null) {
   
     
        createOffset = startOffset - (startOffset % this.mappedFileSize);
    }
    //如果满了，那么设置新mappedFile文件的创建索引 = 上一个文件的起始索引（即文件名） + mappedFileSize
    if (mappedFileLast != null && mappedFileLast.isFull()) {
   
     
        createOffset = mappedFileLast.getFileFromOffset() + this.mappedFileSize;
    }
    //如果需要创建新mappedFile，那么根据起始索引创建新的mappedFile
    if (createOffset != -1 && needCreate) {
   
     
        return tryCreateMappedFile(createOffset);
    }

    return mappedFileLast;
}
```

#### 2.1.1 tryCreateMappedFile创建新的MappedFile

该方法会获取下两个MappedFile的路径nextFilePath和nextNextFilePath，然后调用doCreateMappedFile真正的创建。也就是说一次请求创建两个MappedFile，对应两个commitlog。

为什么创建两个commitlog呢？这就是RocketMQ的一个优化，即commitlog文件预创建或者文件预分配，如果启用了MappedFile（MappedFile类可以看作是commitlog文件在Java中的抽象）预分配服务，那么在创建MappedFile时会同时创建两个MappedFile，一个同步创建并返回用于本次实际使用，一个后台异步创建用于下次取用。这样的好处是避免等到当前文件真正用完了才创建下一个文件，目的同样是提升性能。

```java
/**
 * MappedFileQueue的方法
 * <p>
 * 创建commitlog文件，映射MappedFile
 *
 * @param createOffset 起始索引，即新文件的文件名
 */
protected MappedFile tryCreateMappedFile(long createOffset) {
   
     
    //下一个文件路径 {storePathCommitLog}/createOffset，即文件名为createOffset，即起始物理offset
    String nextFilePath = this.storePath + File.separator + UtilAll.offset2FileName(createOffset);
    //下下一个文件路径 {storePathCommitLog}/createOffset+mappedFileSize，即文件名为createOffset + mappedFileSize，即起始offset
    String nextNextFilePath = this.storePath + File.separator + UtilAll.offset2FileName(createOffset
            + this.mappedFileSize);
    //真正创建文件
    return doCreateMappedFile(nextFilePath, nextNextFilePath);
}
```

doCreateMappedFile方法中，会判断如果allocateMappedFileService不为null，那么异步的创建MappedFile，否则，同步创建一个MappedFile。CommitLog的MappedFileQueue初始化时会初始化allocateMappedFileService，因此一般都不为null。

```java
/**
 * MappedFileQueue的方法
 * <p>
 * 创建commitlog文件，映射MappedFile
 *
 * @param nextFilePath     要创建的下一个文件路径
 * @param nextNextFilePath 要创建的下下一个文件路径
 */
protected MappedFile doCreateMappedFile(String nextFilePath, String nextNextFilePath) {
   
     
    MappedFile mappedFile = null;
    //如果allocateMappedFileService不为null，那么异步的创建MappedFile
    //CommitLog的MappedFileQueue初始化时会初始化allocateMappedFileService，因此一般都不为null
    if (this.allocateMappedFileService != null) {
   
     
        //添加两个请求到处理任务池，然后阻塞等待异步创建默认1G大小的MappedFile
        mappedFile = this.allocateMappedFileService.putRequestAndReturnMappedFile(nextFilePath,
                nextNextFilePath, this.mappedFileSize);
    } else {
   
     
        try {
   
     
            //同步创建MappedFile
            mappedFile = new MappedFile(nextFilePath, this.mappedFileSize);
        } catch (IOException e) {
   
     
            log.error("create mappedFile exception", e);
        }
    }

    if (mappedFile != null) {
   
     
        //如果是第一次创建，那么设置标志位firstCreateInQueue为true
        if (this.mappedFiles.isEmpty()) {
   
     
            mappedFile.setFirstCreateInQueue(true);
        }
        //将创建的mappedFile加入mappedFiles集合中
        this.mappedFiles.add(mappedFile);
    }

    return mappedFile;
}
```

#### 2.1.2 putRequestAndReturnMappedFile异步创建MappedFile

**MappedFile**作为一个RocketMQ的物理文件在Java中的映射类。实际上，**commitLog consumerQueue、indexFile**
3种文件磁盘的读写都是通过MappedFile操作的。它的构造器中会对当前文件进行mmap内存映射操作。

**putRequestAndReturnMappedFile**
方法用于创建MappedFile，会同时创建两个MappedFile，一个同步创建并返回用于本次实际使用，一个后台异步创建用于下次取用。这样的好处是避免等到当前文件真正用完了才创建下一个文件，目的同样是提升性能。

这里的同步和异步实际上都是通过一个服务线程执行的，该方法只是提交两个映射文件创建请求AllocateRequest，并且提交到requestTable和requestQueue中。随后当前线程只会同步等待第一个映射文件的创建，最多等待5s，如果创建成功则返回，而较大的offset那一个映射文件则会异步的创建，不会等待。

这里线程等待使用的是倒计数器**CountDownLatch**
，一个请求一个AllocateRequest对象，其内部还持有一个CountDownLatch对象，当该请求对应的MappedFile被创建完毕之后，会调用内部的CountDownLatch#countDown方法，自然会唤醒该等待的线程。

```java
/**
 * AllocateMappedFileService的方法
 * 添加两个请求到处理任务池，然后阻塞等待异步创建并返回MappedFile
 *
 * @param nextFilePath
 * @param nextNextFilePath
 * @param fileSize 文件大小默认1G
 * @return
 */
public MappedFile putRequestAndReturnMappedFile(String nextFilePath, String nextNextFilePath, int fileSize) {
   
     
    //可以提交的请求
    int canSubmitRequests = 2;
    //如果当前节点不是从节点，并且是异步刷盘策略，并且transientStorePoolEnable参数配置为true，并且fastFailIfNoBufferInStorePool为true
    //那么重新计算最多可以提交几个文件创建请求
    if (this.messageStore.getMessageStoreConfig().isTransientStorePoolEnable()) {
   
     
        if (this.messageStore.getMessageStoreConfig().isFastFailIfNoBufferInStorePool()
            && BrokerRole.SLAVE != this.messageStore.getMessageStoreConfig().getBrokerRole()) {
   
      //if broker is slave, don't fast fail even no buffer in pool
            canSubmitRequests = this.messageStore.getTransientStorePool().availableBufferNums() - this.requestQueue.size();
        }
    }
    //根据nextFilePath创建一个请求对象，并将请求对象存入requestTable这个map集合中
    AllocateRequest nextReq = new AllocateRequest(nextFilePath, fileSize);
    boolean nextPutOK = this.requestTable.putIfAbsent(nextFilePath, nextReq) == null;
    //如果存入成功
    if (nextPutOK) {
   
     
        if (canSubmitRequests <= 0) {
   
     
            log.warn("[NOTIFYME]TransientStorePool is not enough, so create mapped file error, " +
                "RequestQueueSize : {}, StorePoolSize: {}", this.requestQueue.size(), this.messageStore.getTransientStorePool().availableBufferNums());
            this.requestTable.remove(nextFilePath);
            return null;
        }
        //将请求存入requestQueue中
        boolean offerOK = this.requestQueue.offer(nextReq);
        if (!offerOK) {
   
     
            log.warn("never expected here, add a request to preallocate queue failed");
        }
        //可以提交的请求数量自减
        canSubmitRequests--;
    }
    //根据nextNextFilePath创建另一个请求对象，并将请求对象存入requestTable这个map集合中
    AllocateRequest nextNextReq = new AllocateRequest(nextNextFilePath, fileSize);
    boolean nextNextPutOK = this.requestTable.putIfAbsent(nextNextFilePath, nextNextReq) == null;
    if (nextNextPutOK) {
   
     
        if (canSubmitRequests <= 0) {
   
     
            log.warn("[NOTIFYME]TransientStorePool is not enough, so skip preallocate mapped file, " +
                "RequestQueueSize : {}, StorePoolSize: {}", this.requestQueue.size(), this.messageStore.getTransientStorePool().availableBufferNums());
            this.requestTable.remove(nextNextFilePath);
        } else {
   
     
            //将请求存入requestQueue中
            boolean offerOK = this.requestQueue.offer(nextNextReq);
            if (!offerOK) {
   
     
                log.warn("never expected here, add a request to preallocate queue failed");
            }
        }
    }
    //有异常就直接返回
    if (hasException) {
   
     
        log.warn(this.getServiceName() + " service has exception. so return null");
        return null;
    }
    //获取此前存入的nextFilePath对应的请求
    AllocateRequest result = this.requestTable.get(nextFilePath);
    try {
   
     
        if (result != null) {
   
     
            //同步等待最多5s
            boolean waitOK = result.getCountDownLatch().await(waitTimeOut, TimeUnit.MILLISECONDS);
            if (!waitOK) {
   
     
                //超时
                log.warn("create mmap timeout " + result.getFilePath() + " " + result.getFileSize());
                return null;
            } else {
   
     
                //如果nextFilePath对应的MappedFile创建成功，那么从requestTable移除对应的请求
                this.requestTable.remove(nextFilePath);
                //返回创建的mappedFile
                return result.getMappedFile();
            }
        } else {
   
     
            log.error("find preallocate mmap failed, this never happen");
        }
    } catch (InterruptedException e) {
   
     
        log.warn(this.getServiceName() + " service has exception. ", e);
    }

    return null;
}
```

#### 2.1.3 AllocateMappedFileService创建MappedFile

*
*我们上面学习了putRequestAndReturnMappedFile方法，该方法仅仅是创建了两个AllocateRequest请求，并且提交到requestTable这个map集合中，但是并没有找到任何创建MappedFile的代码，那么MappedFile再哪里被创建的呢？
**

实际上，**AllocateMappedFileService**这个类继承了**ServiceThread**
，而ServiceThread实现了Runnable接口，那么我们能够知道AllocateMappedFileService实际上就是一个线程任务类，据此，我们很容易的联想到，具体的创建MappedFile的逻辑是通过这个线程任务来完成的。

在我们学习broker启动源码的时候，我们就见过了**AllocateMappedFileService**这个类，broker启动时创建**DefaultMessageStore**
的时候，就会创建**AllocateMappedFileService**实例，并且调用start方法进行启动。

```java
/**
 * ServiceThread的方法
 * 启动一个线程执行线程任务
 */
public void start() {
   
     
    log.info("Try to start service thread:{} started:{} lastThread:{}", getServiceName(), started.get(), thread);
    //只能启动一次
    if (!started.compareAndSet(false, true)) {
   
     
        return;
    }
    stopped = false;
    //新建线程
    this.thread = new Thread(this, getServiceName());
    //后台线程
    this.thread.setDaemon(isDaemon);
    //启动线程
    this.thread.start();
}
```

启动线程任务之后，自然会运行run方法执行线程任务。

我们来看看AllocateMappedFileService的线程任务，内部是一个死循环，如果服务没有停止，并且没有被线程中断，那么一直循环执行mmapOperation方法。

```java
/**
 * AllocateMappedFileService的方法
 * 创建mappedFile
 */
public void run() {
   
     
    log.info(this.getServiceName() + " service started");
    //死循环
    //如果服务没有停止，并且没有被线程中断，那么一直循环执行mmapOperation方法
    while (!this.isStopped() && this.mmapOperation()) {
   
     

    }
    log.info(this.getServiceName() + " service end");
}
```

#### 2.1.4 mmapOperation执行mmap操作

该方法用于创建MappedFile。大概步骤为：

**1、** 从**requestQueue**中获取优先级最高的一个请求，即文件名最小或者说起始offset最小的请求requestQueue是一个优先级队列；
**2、** 判断是否需要通过**堆外内存**创建MappedFile，如果当前节点不是从节点，并且是异步刷盘策略，并且*
*transientStorePoolEnable**参数配置为true，那么使用堆外内存，默认不使用；

**1、** RocketMQ中引入的**transientStorePoolEnable能缓解pagecache的压力，其原理是基于DirectByteBuffer和MappedByteBuffer**的
**读写分离**；
**2、** 消息先写入**DirectByteBuffer**（堆外内存），随后从MappedByteBuffer（pageCache）读取；
**3、** 如果没有启动堆外内存，那么普通方式创建mappedFile，并且进行mmap操作；
**4、**
如果mappedFile大小大于等于1G并且warmMapedFileEnable参数为true，那么预写mappedFile，也就是所谓的内存预热或者文件预热注意warmMapedFileEnable参数默认为false，即默认不开启文件预热，因此需要手动开启；
**5、** 如果创建成功，那么将请求对象中的**countDownLatch**释放计数，这样就可以唤醒在putRequestAndReturnMappedFile方法中被阻塞的线程了；

```java
/**
 * AllocateMappedFileService的方法
 * <p>
 * mmap 操作，只有被外部线程中断，才会返回false
 */
private boolean mmapOperation() {
   
     
    boolean isSuccess = false;
    AllocateRequest req = null;
    try {
   
     
        //从requestQueue中获取优先级最高的一个请求，即文件名最小或者说起始offset最小的请求
        //requestQueue是一个优先级队列
        req = this.requestQueue.take();
        //从requestTable获取对应的请求
        AllocateRequest expectedRequest = this.requestTable.get(req.getFilePath());
        if (null == expectedRequest) {
   
     
            log.warn("this mmap request expired, maybe cause timeout " + req.getFilePath() + " "
                    + req.getFileSize());
            return true;
        }
        if (expectedRequest != req) {
   
     
            log.warn("never expected here,  maybe cause timeout " + req.getFilePath() + " "
                    + req.getFileSize() + ", req:" + req + ", expectedRequest:" + expectedRequest);
            return true;
        }
        //获取对应的mappedFile，如果为null则创建
        if (req.getMappedFile() == null) {
   
     
            //起始时间
            long beginTime = System.currentTimeMillis();

            MappedFile mappedFile;
            //如果当前节点不是从节点，并且是异步刷盘策略，并且transientStorePoolEnable参数配置为true，那么使用堆外内存，默认不使用
            //RocketMQ中引入的 transientStorePoolEnable 能缓解 pagecache 的压力，其原理是基于DirectByteBuffer和MappedByteBuffer的读写分离
            //消息先写入DirectByteBuffer（堆外内存），随后从MappedByteBuffer（pageCache）读取。
            if (messageStore.getMessageStoreConfig().isTransientStorePoolEnable()) {
   
     
                try {
   
     
                    //可以基于SPI机制获取自定义的MappedFile
                    mappedFile = ServiceLoader.load(MappedFile.class).iterator().next();
                    //初始化
                    mappedFile.init(req.getFilePath(), req.getFileSize(), messageStore.getTransientStorePool());
                } catch (RuntimeException e) {
   
     
                    log.warn("Use default implementation.");
                    mappedFile = new MappedFile(req.getFilePath(), req.getFileSize(), messageStore.getTransientStorePool());
                }
            } else {
   
     
                //普通方式创建mappedFile，并且进行mmap
                mappedFile = new MappedFile(req.getFilePath(), req.getFileSize());
            }
            //创建mappedFile消耗的时间
            long elapsedTime = UtilAll.computeElapsedTimeMilliseconds(beginTime);
            if (elapsedTime > 10) {
   
     
                int queueSize = this.requestQueue.size();
                log.warn("create mappedFile spent time(ms) " + elapsedTime + " queue size " + queueSize
                        + " " + req.getFilePath() + " " + req.getFileSize());
            }

            // pre write mappedFile
            //如果mappedFile大小大于等于1G并且warmMapedFileEnable参数为true，那么预写mappedFile，也就是所谓的内存预热或者文件预热
            //注意warmMapedFileEnable参数默认为false，即默认不开启文件预热，因此选哟手动开启
            if (mappedFile.getFileSize() >= this.messageStore.getMessageStoreConfig()
                    .getMappedFileSizeCommitLog()
                    &&
                    this.messageStore.getMessageStoreConfig().isWarmMapedFileEnable()) {
   
     
                //预热文件
                mappedFile.warmMappedFile(this.messageStore.getMessageStoreConfig().getFlushDiskType(),
                        this.messageStore.getMessageStoreConfig().getFlushLeastPagesWhenWarmMapedFile());
            }

            req.setMappedFile(mappedFile);
            this.hasException = false;
            isSuccess = true;
        }
    } catch (InterruptedException e) {
   
     
        log.warn(this.getServiceName() + " interrupted, possibly by shutdown.");
        this.hasException = true;
        return false;
    } catch (IOException e) {
   
     
        log.warn(this.getServiceName() + " service has exception. ", e);
        this.hasException = true;
        if (null != req) {
   
     
            requestQueue.offer(req);
            try {
   
     
                Thread.sleep(1);
            } catch (InterruptedException ignored) {
   
     
            }
        }
    } finally {
   
     
        //如果创建成功，那么将请求对象中的countDownLatch释放计数，这样就可以唤醒在putRequestAndReturnMappedFile方法中被阻塞的线程了
        if (req != null && isSuccess)
            req.getCountDownLatch().countDown();
    }
    return true;
}
```

##### 2.1.4.1 采用mmap

普通创建MappedFile的方法即调用它的构造器。该构造器内部将会以给定的文件路径创建一个file，并且把commitlog文从磁盘空间件完全的映射到虚拟内存，也就是内存映射，即mmap，提升读写性能。

```java
public MappedFile(final String fileName, final int fileSize) throws IOException {
   
     
//调用init初始化
    init(fileName, fileSize);
}

private void init(final String fileName, final int fileSize) throws IOException {
   
     
    //文件名。长度为20位，左边补零，剩余为起始偏移量，比如00000000000000000000代表了第一个文件，起始偏移量为0
    this.fileName = fileName;
    //文件大小。默认1G=1073741824
    this.fileSize = fileSize;
    //构建file对象
    this.file = new File(fileName);
    //构建文件起始索引，就是取自文件名
    this.fileFromOffset = Long.parseLong(this.file.getName());
    boolean ok = false;
    //确保文件目录存在
    ensureDirOK(this.file.getParent());

    try {
   
     
        //对当前commitlog文件构建文件通道fileChannel
        this.fileChannel = new RandomAccessFile(this.file, "rw").getChannel();
        //把commitlog文件完全的映射到虚拟内存，也就是内存映射，即mmap，提升读写性能
        this.mappedByteBuffer = this.fileChannel.map(MapMode.READ_WRITE, 0, fileSize);
        //记录数据
        TOTAL_MAPPED_VIRTUAL_MEMORY.addAndGet(fileSize);
        TOTAL_MAPPED_FILES.incrementAndGet();
        ok = true;
    } catch (FileNotFoundException e) {
   
     
        log.error("Failed to create file " + this.fileName, e);
        throw e;
    } catch (IOException e) {
   
     
        log.error("Failed to map file " + this.fileName, e);
        throw e;
    } finally {
   
     
        //释放fileChannel，注意释放fileChannel不会对之前的mappedByteBuffer映射产生影响
        if (!ok && this.fileChannel != null) {
   
     
            this.fileChannel.close();
        }
    }
}
```

##### 2.1.4.2 采用堆外内存

如果开启了堆外内存，那么将采用此方式创建MappedFile，其相比于mmap的方式，多了一步操作，即会设置一个writeBuffer。

```java
public void init(final String fileName, final int fileSize,
    final TransientStorePool transientStorePool) throws IOException {
   
     
    //普通初始化
    init(fileName, fileSize);
    //设置写buffer，采用堆外内存
    this.writeBuffer = transientStorePool.borrowBuffer();
    this.transientStorePool = transientStorePool;
}
```

**borrowBuffer**方法中，会返回**TransientStorePool**内部的一个availableBuffer，如果启动堆外内存，那么在broker启动创建DefaultMessageStore的时候将会执行
**TransientStorePool#init**方法，该方法默认会**初始化5个1G大小的堆外内存并且锁定住**。这是一个重量级初始化操作，将会延长broker启动时间。

堆外内存就是通过**ByteBuffer.allocateDirect**方法分配的，这5块内存可以被重复利用。

```java
/**
 * TransientStorePool的方法
 *
 * It's a heavy init method.
 */
public void init() {
   
     
    //默认5个
    for (int i = 0; i < poolSize; i++) {
   
     
        //分配堆外内存，默认大小1G
        ByteBuffer byteBuffer = ByteBuffer.allocateDirect(fileSize);

        final long address = ((DirectBuffer) byteBuffer).address();
        Pointer pointer = new Pointer(address);
        //锁定堆外内存，确保不会被置换到虚拟内存中去
        LibC.INSTANCE.mlock(pointer, new NativeLong(fileSize));
        //存入队列中
        availableBuffers.offer(byteBuffer);
    }
}
```

*
*如果是普通模式，将会采用mmap同时进行读写。如果采用读写分离，那么Broker将消息写入writeBuffer，即先写入DirectByteBuffer（堆外内存）就可以直接返回。然后异步转存服务CommitRealTimeService不断地从堆外内存中批量Commit到Page
Cache中（将writeBuffer的数据写入到fileChannel中），而消费者始终从mappedByteBuffer（即page
cache，mappedByteBuffer能获取到写入fileChannel的数据）中读取消息。后面我们学习到消息刷盘的时候会介绍源码。**

**高并发下写入 page cache 可能会造成刷脏页时磁盘压力较高，导致写入时出现毛刺现象。读写分离能缓解频繁写page cache
的压力，但会增加消息不一致的风险，使得数据一致性降低到最低。**

#### 2.1.5 warmMappedFile文件预热

**mmap**操作减少了传统IO将磁盘文件数据在操作系统内核地址空间的缓冲区和用户应用程序地址空间的缓冲区之间来回进行拷贝的性能开销，这是它的好处。

但是**mmap**
操作对于OS来说只是建立虚拟内存地址至物理地址的映射关系，即将进程使用的虚拟内存地址映射到物理地址上。实际上并不会加载任何MappedFile数据至内存中，也并不会分配指定的大小的内存。当程序要访问数据时，如果发现这部分数据页并没有实际加载到内存中，则处理器自动触发一个缺页异常，进而进入内核空间再分配物理内存，一次分配大小默认4k。一个G大小的CommitLog，如果靠着缺页中断来分配实际内存，那么需要触发26w多次缺页中断，这是一笔不小的开销。

**RocketMQ**避免频繁发生却也异常的做法是采用文件预热，即让操作系统提前分配物理内存空间，防止在写入消息时发生缺页异常才进行分配。

```java
/**
 * MappedFile的方法
 *
 * 建立了进程虚拟地址空间映射之后，并没有分配虚拟内存对应的物理内存，这里进行内存预热
 *
 * @param type  消息刷盘类型，默认 FlushDiskType.ASYNC_FLUSH;
 * @param pages 一页大小，默认4k
 */
public void warmMappedFile(FlushDiskType type, int pages) {
   
     
    long beginTime = System.currentTimeMillis();
    // 创建一个新的字节缓冲区
    ByteBuffer byteBuffer = this.mappedByteBuffer.slice();
    int flush = 0;
    long time = System.currentTimeMillis();
    //每隔4k大小写入一个0
    for (int i = 0, j = 0; i < this.fileSize; i += MappedFile.OS_PAGE_SIZE, j++) {
   
     
        //每隔4k大小写入一个0
        byteBuffer.put(i, (byte) 0);
        // force flush when flush disk type is sync
        //如果是同步刷盘，则每次写入都要强制刷盘
        if (type == FlushDiskType.SYNC_FLUSH) {
   
     
            if ((i / OS_PAGE_SIZE) - (flush / OS_PAGE_SIZE) >= pages) {
   
     
                flush = i;
                mappedByteBuffer.force();
            }
        }

        // prevent gc
        //调用Thread.sleep(0)当前线程主动放弃CPU资源，立即进入就绪状态
        //防止因为多次循环导致该线程一直抢占着CPU资源不释放，
        if (j % 1000 == 0) {
   
     
            log.info("j={}, costTime={}", j, System.currentTimeMillis() - time);
            time = System.currentTimeMillis();
            try {
   
     
                Thread.sleep(0);
            } catch (InterruptedException e) {
   
     
                log.error("Interrupted", e);
            }
        }
    }

    // force flush when prepare load finished
    //把剩余的数据强制刷新到磁盘中
    if (type == FlushDiskType.SYNC_FLUSH) {
   
     
        log.info("mapped file warm-up done, force to disk, mappedFile={}, costTime={}",
                this.getFileName(), System.currentTimeMillis() - beginTime);
        mappedByteBuffer.force();
    }
    log.info("mapped file warm-up done. mappedFile={}, costTime={}", this.getFileName(),
            System.currentTimeMillis() - beginTime);
    //锁定内存
    this.mlock();
}
```

*
*RocketMQ对于MappedFile每隔OS_PAGE_SIZE大小写入一个0，即每4k写入一个0，来让操作系统预先分配1G大小的全额物理内存，通过这种预先分配内存的方式，可以避免在读写消息时引发引发异常而导致的性能损失。因为操作系统加载数据都是以Page
Cache页为单位加载的，而一页大小就是4k，因此每隔4k写入一个0，就能保证分配4k大小的内存。**

#### 2.1.6 mlock锁定内存

**当实现了文件内存预热之后，虽然短时间不会读取数据不会引发缺页异常，但是当内存不足的时候，一部分不常使用的内存还是会被交换到swap空间中，当程序再次读取交换出去的数据的时候会再次产生缺页异常。
**

因此RocketMQ在warmMappedFile方法的最后还调用了**mlock**方法，该方法调用系统mlock函数，锁定该文件的Page
Cache，防止把预热过的文件被操作系统调到swap空间中。另外还会调用系统madvise函数，再次尝试一次性先将一段数据读入到映射内存区域，这样就减少了缺页异常的产生。

```java
/**
 * MappedFile的方法
 * 锁定内存
 */
public void mlock() {
   
     
    final long beginTime = System.currentTimeMillis();
    final long address = ((DirectBuffer) (this.mappedByteBuffer)).address();
    Pointer pointer = new Pointer(address);
    {
   
     
        //mlock调用
        int ret = LibC.INSTANCE.mlock(pointer, new NativeLong(this.fileSize));
        log.info("mlock {} {} {} ret = {} time consuming = {}", address, this.fileName, this.fileSize, ret, System.currentTimeMillis() - beginTime);
    }

    {
   
     
        //madvise调用
        int ret = LibC.INSTANCE.madvise(pointer, new NativeLong(this.fileSize), LibC.MADV_WILLNEED);
        log.info("madvise {} {} {} ret = {} time consuming = {}", address, this.fileName, this.fileSize, ret, System.currentTimeMillis() - beginTime);
    }
}
```

### 2.3 appendMessage追加存储消息

当获取到mappedFile之后，将会调用**mappedFile#appendMessage**方法追加消息。

```java
/**
 * MappedFile的方法
 * <p>
 * 追加消息
 *
 * @param msg               消息
 * @param cb                回调函数
 * @param putMessageContext 存放消息上下文
 */
public AppendMessageResult appendMessage(final MessageExtBrokerInner msg, final AppendMessageCallback cb,
                                         PutMessageContext putMessageContext) {
   
     
    //调用appendMessagesInner方法
    return appendMessagesInner(msg, cb, putMessageContext);
}
```

其内部调用另一个**mappedFile#appendMessagesInner**方法真正的进行消息存储。

**该方法首先获取当前文件的写指针，如果写指针小于文件的大小，那么就对消息进行追加处理。追加处理的是通过回调函数的doAppend方法执行的，分为单条消息，和批量消息的处理。最后会更新写指针的位置，以及存储时间。
**

```java
/**
 * MappedFile的方法
 * <p>
 * 追加消息
 *
 * @param messageExt        消息
 * @param cb                回调函数
 * @param putMessageContext 存放消息上下文
 */
public AppendMessageResult appendMessagesInner(final MessageExt messageExt, final AppendMessageCallback cb,
                                               PutMessageContext putMessageContext) {
   
     
    assert messageExt != null;
    assert cb != null;
    //获取写入指针的位置
    int currentPos = this.wrotePosition.get();
    //如果小于文件大小，那么可以写入
    if (currentPos < this.fileSize) {
   
     
        //如果存在writeBuffer，即支持堆外缓存，那么则使用writeBuffer进行读写分离，否则使用mmap的方式写
        ByteBuffer byteBuffer = writeBuffer != null ? writeBuffer.slice() : this.mappedByteBuffer.slice();
        //设置写入位置
        byteBuffer.position(currentPos);
        AppendMessageResult result;
        /*
         * 通过回调函数执行实际写入
         */
        if (messageExt instanceof MessageExtBrokerInner) {
   
     
            //单条消息
            result = cb.doAppend(this.getFileFromOffset(), byteBuffer, this.fileSize - currentPos,
                    (MessageExtBrokerInner) messageExt, putMessageContext);
        } else if (messageExt instanceof MessageExtBatch) {
   
     
            //批量消息
            result = cb.doAppend(this.getFileFromOffset(), byteBuffer, this.fileSize - currentPos,
                    (MessageExtBatch) messageExt, putMessageContext);
        } else {
   
     
            return new AppendMessageResult(AppendMessageStatus.UNKNOWN_ERROR);
        }
        //更新写指针的位置
        this.wrotePosition.addAndGet(result.getWroteBytes());
        //更新存储实时间
        this.storeTimestamp = result.getStoreTimestamp();
        return result;
    }
    log.error("MappedFile.appendMessage return null, wrotePosition: {} fileSize: {}", currentPos, this.fileSize);
    return new AppendMessageResult(AppendMessageStatus.UNKNOWN_ERROR);
}
```

##### 2.3.1 doAppend执行追加

**真正的追加消息是通过AppendMessageCallback回调函数的doAppend方法执行的。这里回调函数的具体实现是DefaultAppendMessageCallback，它是位于CommitLog里面的一个内部类的实现。
**

源码很多，大概步骤为：

**1、** 获取消息物理偏移量，创建服务端消息Id生成器：4个字节IP+4个字节的端口号+8字节的消息偏移量从topicQueueTable中获取Queue队列的最大相对偏移量；
**2、**
判断如果消息的长度加上文件结束符子节数大于maxBlank，则表示该commitlog剩余大小不足以存储该消息那么返回END_OF_FILE，在asyncPutMessage方法中判断到该code之后将会新建一个MappedFile并尝试再次存储；
**3、** 如果空间足够，则将消息编码，并将编码后的消息写入到byteBuffer中，这里的byteBuffer可能是writeBuffer，即直接缓冲区，也有可能是普通缓冲区mappedByteBuffer；
**4、** 返回AppendMessageResult对象，内部包括消息追加状态、消息写入物理偏移量、消息写入长度、消息ID生成器、消息开始追加的时间戳、消息队列偏移量、消息开始写入的时间戳等属性；

**当该方法执行完毕，表示消息已被写入的byteBuffer中，如果是writeBuffer则表示消息写入了堆外内存中，如果是mappedByteBuffer，则表示消息写入了page
chache中。总之，都是存储在内存之中。**

```java
/**
 * DefaultAppendMessageCallback的方法
 * <p>
 * 追加消息回调
 *
 * @param fileFromOffset    文件起始索引
 * @param byteBuffer        缓冲区
 * @param maxBlank          最大空闲区
 * @param msgInner          消息
 * @param putMessageContext 上下文
 */
public AppendMessageResult doAppend(final long fileFromOffset, final ByteBuffer byteBuffer, final int maxBlank,
                                    final MessageExtBrokerInner msgInner, PutMessageContext putMessageContext) {
   
     
    // STORETIMESTAMP + STOREHOSTADDRESS + OFFSET <br>

    // PHY OFFSET
    //获取物理偏移量索引
    long wroteOffset = fileFromOffset + byteBuffer.position();
    /*
     * 构建msgId,也就是broker端的唯一id,在发送消息的时候,在客户端producer也会生成一个唯一id是的。
     */
    Supplier<String> msgIdSupplier = () -> {
   
     
        //系统标识
        int sysflag = msgInner.getSysFlag();
        //长度16
        int msgIdLen = (sysflag & MessageSysFlag.STOREHOSTADDRESS_V6_FLAG) == 0 ? 4 + 4 + 8 : 16 + 4 + 8;
        //分配16字节的缓冲区
        ByteBuffer msgIdBuffer = ByteBuffer.allocate(msgIdLen);
        //ip4个字节、host4个字节
        MessageExt.socketAddress2ByteBuffer(msgInner.getStoreHost(), msgIdBuffer);
        //清除缓冲区,因为因为socketAddress2ByteBuffer会翻转缓冲区
        msgIdBuffer.clear();//because socketAddress2ByteBuffer flip the buffer
        //8个字节存储commitLog的物理偏移量
        msgIdBuffer.putLong(msgIdLen - 8, wroteOffset);
        return UtilAll.bytes2string(msgIdBuffer.array());
    };

    // Record ConsumeQueue information
    //记录ConsumeQueue信息

    //key = "topic-queueId"
    String key = putMessageContext.getTopicQueueTableKey();
    //获取该队列的最大相对偏移量
    Long queueOffset = CommitLog.this.topicQueueTable.get(key);
    if (null == queueOffset) {
   
     
        //如果为null则设置为0,并且存入topicQueueTable
        queueOffset = 0L;
        CommitLog.this.topicQueueTable.put(key, queueOffset);
    }
    //light message queue(LMQ)支持
    boolean multiDispatchWrapResult = CommitLog.this.multiDispatch.wrapMultiDispatch(msgInner);
    if (!multiDispatchWrapResult) {
   
     
        return new AppendMessageResult(AppendMessageStatus.UNKNOWN_ERROR);
    }

    // Transaction messages that require special handling
    //需要特殊处理的事务消息
    final int tranType = MessageSysFlag.getTransactionValue(msgInner.getSysFlag());
    switch (tranType) {
   
     
        // Prepared and Rollback message is not consumed, will not enter the
        // consumer queuec
        //准备和回滚消息不会被消费，不会进入消费队列
        case MessageSysFlag.TRANSACTION_PREPARED_TYPE:
        case MessageSysFlag.TRANSACTION_ROLLBACK_TYPE:
            queueOffset = 0L;
            break;
        //非事务消息和提交消息会被消费
        case MessageSysFlag.TRANSACTION_NOT_TYPE:
        case MessageSysFlag.TRANSACTION_COMMIT_TYPE:
        default:
            break;
    }
    /*
     * 消息编码序列化
     */
    //获取编码的ByteBuffer
    ByteBuffer preEncodeBuffer = msgInner.getEncodedBuff();
    final int msgLen = preEncodeBuffer.getInt(0);

    // Determines whether there is sufficient free space
    //消息编码
    if ((msgLen + END_FILE_MIN_BLANK_LENGTH) > maxBlank) {
   
     
        this.msgStoreItemMemory.clear();
        // 1 TOTALSIZE
        this.msgStoreItemMemory.putInt(maxBlank);
        // 2 MAGICCODE
        this.msgStoreItemMemory.putInt(CommitLog.BLANK_MAGIC_CODE);
        // 3 The remaining space may be any value
        // Here the length of the specially set maxBlank
        final long beginTimeMills = CommitLog.this.defaultMessageStore.now();
        byteBuffer.put(this.msgStoreItemMemory.array(), 0, 8);
        return new AppendMessageResult(AppendMessageStatus.END_OF_FILE, wroteOffset,
                maxBlank, /* only wrote 8 bytes, but declare wrote maxBlank for compute write position */
                msgIdSupplier, msgInner.getStoreTimestamp(),
                queueOffset, CommitLog.this.defaultMessageStore.now() - beginTimeMills);
    }

    int pos = 4 + 4 + 4 + 4 + 4;
    // 6 QUEUEOFFSET
    preEncodeBuffer.putLong(pos, queueOffset);
    pos += 8;
    // 7 PHYSICALOFFSET
    preEncodeBuffer.putLong(pos, fileFromOffset + byteBuffer.position());
    int ipLen = (msgInner.getSysFlag() & MessageSysFlag.BORNHOST_V6_FLAG) == 0 ? 4 + 4 : 16 + 4;
    // 8 SYSFLAG, 9 BORNTIMESTAMP, 10 BORNHOST, 11 STORETIMESTAMP
    pos += 8 + 4 + 8 + ipLen;
    // refresh store time stamp in lock
    preEncodeBuffer.putLong(pos, msgInner.getStoreTimestamp());

    //存储消息起始时间
    final long beginTimeMills = CommitLog.this.defaultMessageStore.now();
    // Write messages to the queue buffer
    /*
     * 将消息写入到byteBuffer中，这里的byteBuffer可能是writeBuffer，即直接缓冲区，也有可能是普通缓冲区mappedByteBuffer
     */
    byteBuffer.put(preEncodeBuffer);
    msgInner.setEncodedBuff(null);
    //返回AppendMessageResult，包括消息追加状态、消息写入偏移量、消息写入长度、消息ID生成器、消息开始追加的时间戳、消息队列偏移量、消息开始写入的时间戳
    AppendMessageResult result = new AppendMessageResult(AppendMessageStatus.PUT_OK, wroteOffset, msgLen, msgIdSupplier,
            msgInner.getStoreTimestamp(), queueOffset, CommitLog.this.defaultMessageStore.now() - beginTimeMills);

    switch (tranType) {
   
     
        case MessageSysFlag.TRANSACTION_PREPARED_TYPE:
        case MessageSysFlag.TRANSACTION_ROLLBACK_TYPE:
            break;
        case MessageSysFlag.TRANSACTION_NOT_TYPE:
        case MessageSysFlag.TRANSACTION_COMMIT_TYPE:
            // The next update ConsumeQueue information
            CommitLog.this.topicQueueTable.put(key, ++queueOffset);
            CommitLog.this.multiDispatch.updateMultiQueueOffset(msgInner);
            break;
        default:
            break;
    }
    return result;
}
```

#### 2.3.2 消息序列化

**Broker的commitlog只会存储序列化后的消息，其格式为：**

| 字段                          | 字段含义                    | 字段大小             |
|:----------------------------|:------------------------|:-----------------|
| TOTALSIZE                   | 消息条目总长度                 | 4                |
| MAGICCODE                   | 魔数，用来判断消息是正常消息还是空消息     | 4                |
| BODYCRC                     | 消息体CRC校验码               | 4                |
| QUEUEID                     | 消息消费队列id                | 4                |
| FLAG                        | 消息flag                  | 4                |
| QUEUEOFFSET                 | 消息在消息消费队列的偏移量           | 8                |
| PHYSICALOFFSET              | 消息在commitlog中的偏移量       | 8                |
| SYSFLAG                     | 消息系统flag，例如是否压缩、是否是事务消息 | 4                |
| BORNTIMESTAMP               | 消息生产者调用消息发送API的时间戳      | 8                |
| BORNHOST                    | 消息发送者的IP和端口号            | 8                |
| STORETIMESTAMP              | 消息存储时间                  | 8                |
| STOREHOSTADDRESS            | broker的IP和端口号           | 8                |
| RECONSUMETIMES              | 消息重试次数                  | 4                |
| Prepared Transaction Offset | 事务消息物理偏移量               | 8                |
| bodyLength                  | 消息体长度                   | 4                |
| body                        | 消息体内容                   | bodyLength       |
| topicLength                 | Topic名称内容大小             | 1                |
| topicData                   | topic的值                 | topicLength      |
| propertiesLength            | 消息属性大小                  | 2                |
| propertiesData              | 消息属性                    | propertiesLength |

## 3 存储高性能设计总结

**通过对于获取mappedFile部分的学习，我们知道RocketMQ对于commitlog的性能采用了多重优化措施：**

**1、** **commitlog文件预创建或者文件预分配**
：当获取新的commitlog的时候，如果磁盘满了或者没有文件，并且启用了MappedFile（MappedFile类可以看作是commitlog文件在Java中的抽象）预分配服务，那么在创建MappedFile时会同时创建两个MappedFile，一个同步创建并返回用于本次实际使用，一个后台异步创建用于下次取用这样的好处是避免等到当前文件真正用完了才创建下一个文件，提升性能；
**2、** **mmap**：这算作一种零拷贝技术，相比于传统的read和writemmap将一个文件(或者文件的一部分)
映射到进程的地址空间，实现文件磁盘地址和进程虚拟地址空间中一段虚拟地址的一一对映关系实现这样的映射关系后，进程就可以采用指针的方式读写操作这一段内存，而系统会自动回写脏页面到对应的文件磁盘上，简单的说，使用mmap之后，数据无需拷贝到用户空间中，应用程序可以直接操作PageCache中的数据，减少数据拷贝次数[Java两种zero-copy零拷贝技术mmap和sendfile的介绍][Java_zero-copy_mmap_sendfile]；
**3、** **文件预热或者内存预热**
：mmap基于惰性加载策略，单独的mmap操作仅仅是建立映射而不是真实的分配固定大小的内存，只有访问到不存在的数据时才会引发缺页异常才会真正的加载数据RocketMQ对于新建的MappedFile每隔OS_PAGE_SIZE大小写入一个0，即每4k写入一个0，来让操作系统预先分配全额大小的物理内存，通过这种预先分配内存的方式，可以避免在读写消息时引发异常才分配内存而导致的性能损失；
**4、** **内存锁定**
：通过mlock系统调用，将预热后的内存空间锁定，防止因为内存不足导致pageCahce的数据被交换到swap空间中去，因为访问swap空间中的数据同样会引发缺页异常另外还会调用系统madvise函数，给操作系统建议，说这文件在不久的将来要访问的，建议操作系统尝试一次性先将一段数据读入到映射内存区域，这样就减少了缺页异常的产生；
**5、** **读写分离**
：如果启用了堆外内存，那么在创建新的MappedFile的时候，会分配一个writeBuffer，这段内存属于直接内存（堆外内存）Broker将消息写入writeBuffer，即先写入DirectByteBuffer（堆外内存），然后异步转存服务不断地从堆外内存中Commit到PageCache中（将writeBuffer的数据写入到fileChannel中），而消费者始终从mappedByteBuffer（即PageCache）（mappedByteBuffer能获取到写入fileChannel的数据）中读取消息读写分离能缓解pagecache的压力，但会增加消息不一致的风险；

**以上就是RocketMQ高性能存储的一些关键设计，当然后面我们会了解到更多的高性能知识。**