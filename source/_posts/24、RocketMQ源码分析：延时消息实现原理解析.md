---

layout:  24、RocketMQ源码分析：延时消息实现原理解析

title:   24、RocketMQ源码分析：延时消息实现原理解析

tags: RocketMq

categories: Web

top: 56

path: /article/1739713349

abbrlink: 1739713349

date: 2025-02-16 21:42:06


--- 

# 24、RocketMQ源码分析：延时消息实现原理解析

分类：[RocketMQ源码分析（1）](https://cxykk.com/?cat=318)  2024-03-27 阅读(152)

> 基于RocketMQ release-4.9.3，深入的介绍了DefaultMQPushConsumer延迟消息源码。

#### 文章目录

- 1 load加载延迟消息数据
-
    - 1.1 parseDelayLevel解析延迟等级
- 2 start启动调度消息服务
- 3 DeliverDelayedMessageTimerTask投递延迟消息任务
-
    - 3.1 executeOnTimeup执行延迟消息投递
- 3.2 scheduleNextTimerTask下一个调度任务
- 3.3 correctDeliverTimestamp校验投递时间
- 3.4 messageTimeup恢复正常消息
- 3.5 syncDeliver同步投递消息
- 4 延迟消息的总结

*
*并发消息消费失败引发消费重试时，默认情况下重试16次，从延迟等级level3（10s）开始，每次延迟时间递增，时间到了又会发送到重试topic去消费，这其中就涉及到RocketMQ的延迟消息，可以说RocketMQ并发消息消费失败引发消费重试就是基于topic替换和延迟消息这两个技术实现的。
**

此前我们学习了RocketMQ的消费重试，我们知道在判断消息为延迟消息的时候，即DelayTimeLevel大于0，那么替换topic为SCHEDULE_TOPIC_XXXX，替换queueId为延迟队列id，
id = level -
1，如果延迟级别大于最大级别，则设置为最大级别18，，默认延迟2h。这些参数可以在broker端配置类MessageStoreConfig中配置。最后保存真实topic到消息的REAL_TOPIC属性，保存queueId到消息的REAL_QID属性，方便后面恢复。

**实际上普通的延迟消息也会进行topic替换，那么，发送到SCHEDULE_TOPIC_XXXX对应的消息队列里面的延迟消息，到底是做到能够在给定的延迟时间之后取出来重新投递的呢？下面我们来看看RocketMQ延迟消息的源码。
**

*
*实际上RocketMQ通过ScheduleMessageService调度消息服务实现延迟（定时）消息。ScheduleMessageService继承了ConfigManager，在DefaultMessageStore实例化的时候被实例化。
**

## 1 load加载延迟消息数据

在broker启动执行DefaultMessageStore#load方法加载Commit Log、Consume Queue、index
file等文件，将数据加载到内存中，并完成数据的恢复的时候，同样会执行ScheduleMessageService#load方法，加载延迟消息数据，初始化delayLevelTable和offsetTable。

首先调用父类的ConfigManager#load方法（在broker启动部分就讲过源码了），将延迟消息文件`$`
{user.home}/store/config/delayOffset.json加载到内存的offsetTable集合中，delayOffset.json中保存着延迟topic每个队列的消费进度（消费偏移量）。

```java
/**
 * ScheduleMessageService的方法
 * <p>
 * 加载延迟消息数据，初始化delayLevelTable和offsetTable
 */
@Override
public boolean load() {
   
     
    //调用父类ConfigManager#load方法，将延迟消息文件${user.home}/store/config/delayOffset.json加载到内存的offsetTable集合中
    //delayOffset.json中保存着延迟topic每个队列的消费进度（消费偏移量）
    boolean result = super.load();
    //解析延迟级别到delayLevelTable集合中
    result = result && this.parseDelayLevel();
    //矫正每个延迟队列的偏移量
    result = result && this.correctDelayOffset();
    return result;
}
/**
 * ScheduleMessageService的方法
 * <p>
 * 获取延迟消息文件路径${user.home}/store/config/delayOffset.json
 */
@Override
public String configFilePath() {
   
     
    //${user.home}/store/config/delayOffset.json
    return StorePathConfigHelper.getDelayOffsetStorePath(this.defaultMessageStore.getMessageStoreConfig()
            .getStorePathRootDir());
}

/**
 * ScheduleMessageService的方法
 * <p>
 * json字符串转换为offsetTable对象
 */
@Override
public void decode(String jsonString) {
   
     
    if (jsonString != null) {
   
     
        DelayOffsetSerializeWrapper delayOffsetSerializeWrapper =
                DelayOffsetSerializeWrapper.fromJson(jsonString, DelayOffsetSerializeWrapper.class);
        if (delayOffsetSerializeWrapper != null) {
   
     
            this.offsetTable.putAll(delayOffsetSerializeWrapper.getOffsetTable());
        }
    }
}
```

延迟消息文件${user.home}/store/config/delayOffset.json的内容，它保存着延迟队列对应的消费偏移量。

```java
{
   
     
  "offsetTable":{
   
     3:2,4:1
  }
}
```

### 1.1 parseDelayLevel解析延迟等级

**延迟等级字符串存储在MessageStoreConfig的messageDelayLevel属性中，默认值为"1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m
20m 30m 1h 2h"，即18个等级，因此也是可以配置的，但是单位仅支持s、m、h、d，分别表示秒、分、时、天。**

**该方法解析延迟等级以及对应的延迟时间到delayLevelTable中，单位统一转换为毫秒，注意延迟等级从1开始。**

```java
/**
 * ScheduleMessageService的方法
 * 解析延迟等级到delayLevelTable中
 * @return
 */
public boolean parseDelayLevel() {
   
     
    //时间单位表
    HashMap<String, Long> timeUnitTable = new HashMap<String, Long>();
    timeUnitTable.put("s", 1000L);
    timeUnitTable.put("m", 1000L * 60);
    timeUnitTable.put("h", 1000L * 60 * 60);
    timeUnitTable.put("d", 1000L * 60 * 60 * 24);
    //从MessageStoreConfig中获取延迟等级字符串messageDelayLevel
    String levelString = this.defaultMessageStore.getMessageStoreConfig().getMessageDelayLevel();
    try {
   
     
        //通过空格拆分
        String[] levelArray = levelString.split(" ");
        for (int i = 0; i < levelArray.length; i++) {
   
     
            //获取每个等级的延迟时间
            String value = levelArray[i];
            //获取延迟单位
            String ch = value.substring(value.length() - 1);
            //获取对应的延迟单位的时间毫秒
            Long tu = timeUnitTable.get(ch);
            //延迟等级，从1开始
            int level = i + 1;
            //如果当前等级已经大于最大等级，则赋值为最大等级
            if (level > this.maxDelayLevel) {
   
     
                this.maxDelayLevel = level;
            }
            //延迟时间
            long num = Long.parseLong(value.substring(0, value.length() - 1));
            //计算该等级的延迟时间毫秒
            long delayTimeMillis = tu * num;
            //存入delayLevelTable中
            this.delayLevelTable.put(level, delayTimeMillis);
            if (this.enableAsyncDeliver) {
   
     
                this.deliverPendingTable.put(level, new LinkedBlockingQueue<>());
            }
        }
    } catch (Exception e) {
   
     
        log.error("parseDelayLevel exception", e);
        log.info("levelString String = {}", levelString);
        return false;
    }

    return true;
}
```

## 2 start启动调度消息服务

ScheduleMessageService依靠内部的定时任务实现延迟消息，ScheduleMessageService通过start方法完成启动。

在broker的启动过程中，会执行DefaultMessageStore的start方法中，该方法内部通过handleScheduleMessageService方法执行ScheduleMessageService的start方法。

该方法的大概逻辑为：

**1、** 初始化延迟消息投递线程池deliverExecutorService，该线程池是一个调度任务线程池ScheduledThreadPoolExecutor，核心线程数就是最大的延迟等级，默认18；
**2、** 遍历所有的延迟等级，为每一个延迟等级构建一个对应的DeliverDelayedMessageTimerTask调度任务放到deliverExecutorService中，默认延迟1000ms后执行；
**3、** 构建一个延迟队列消费偏移量持久化的定时调度任务，首次延迟1000ms之后执行，后续每次执行间隔flushDelayOffsetInterval时间，默认10s；

```java
/**
 * ScheduleMessageService的方法
 * <p>
 * 启动调度消息服务
 */
public void start() {
   
     
    //将启动标志CAS的从false改为true，该服务只能启动一次
    if (started.compareAndSet(false, true)) {
   
     
        //调用父类的load方法，将延迟消息文件${user.home}/store/config/delayOffset.json加载到内存的offsetTable集合中
        //fix(dledger): reload the delay offset when master changed (#2518)
        super.load();
        /*
         * 1 初始化延迟消息投递线程池，核心线程数就是最大的延迟等级，默认18
         */
        this.deliverExecutorService = new ScheduledThreadPoolExecutor(this.maxDelayLevel, new ThreadFactoryImpl("ScheduleMessageTimerThread_"));
        //异步投递，默认不支持
        if (this.enableAsyncDeliver) {
   
     
            this.handleExecutorService = new ScheduledThreadPoolExecutor(this.maxDelayLevel, new ThreadFactoryImpl("ScheduleMessageExecutorHandleThread_"));
        }
        /*
         * 2 对所有的延迟等级构建一个对应的DeliverDelayedMessageTimerTask调度任务，默认延迟1000ms后执行
         */
        for (Map.Entry<Integer, Long> entry : this.delayLevelTable.entrySet()) {
   
     
            //延迟等级
            Integer level = entry.getKey();
            //延迟时间，毫秒
            Long timeDelay = entry.getValue();
            //根据延迟等级获取对应的延迟队列的消费偏移量，如果没有则设置为0
            Long offset = this.offsetTable.get(level);
            if (null == offset) {
   
     
                offset = 0L;
            }
            //延迟时间不为null，那么为该等级的延迟队列构建一个DeliverDelayedMessageTimerTask调度任务，默认延迟1000ms后执行
            if (timeDelay != null) {
   
     
                if (this.enableAsyncDeliver) {
   
     
                    this.handleExecutorService.schedule(new HandlePutResultTask(level), FIRST_DELAY_TIME, TimeUnit.MILLISECONDS);
                }
                //DeliverDelayedMessageTimerTask构造参数包括对应的延迟等级，以及最新消费偏移量
                this.deliverExecutorService.schedule(new DeliverDelayedMessageTimerTask(level, offset), FIRST_DELAY_TIME, TimeUnit.MILLISECONDS);
            }
        }
        /*
         * 3 构建一个延迟队列消费偏移量持久化的定时调度任务，首次延迟1000ms之后执行，后续每次执行间隔flushDelayOffsetInterval时间，默认10s
         */
        this.deliverExecutorService.scheduleAtFixedRate(new Runnable() {
   
     

            @Override
            public void run() {
   
     
                try {
   
     
                    if (started.get()) {
   
     
                        ScheduleMessageService.this.persist();
                    }
                } catch (Throwable e) {
   
     
                    log.error("scheduleAtFixedRate flush exception", e);
                }
            }
        }, 10000, this.defaultMessageStore.getMessageStoreConfig().getFlushDelayOffsetInterval(), TimeUnit.MILLISECONDS);
    }
}
```

## 3 DeliverDelayedMessageTimerTask投递延迟消息任务

**在start方法中，ScheduleMessageService会为每一个延迟等级创建一个DeliverDelayedMessageTimerTask投递延迟消息任务，不同延迟等级的消息放到不同的延迟队列里面，被不同的Task处理。
**

**采用不同的队列处理同一个延迟等级的消息的方式，不再需要进行消息排序，避免了消息排序的复杂逻辑，能比较简单的实现有限等级的延迟消息，RocketMQ的开源版本不支持任意时间的延迟消息，这也是它的一个限制吧！
**

**DeliverDelayedMessageTimerTask是一个线程任务，下面来看看它的run方法，主要是调用executeOnTimeup执行消息投递。**

```java
@Override
public void run() {
   
     
    try {
   
     
        //如果服务已启动，那么继续执行
        if (isStarted()) {
   
     
            //执行消息投递
            this.executeOnTimeup();
        }
    } catch (Exception e) {
   
     
        // XXX: warn and notify me
        log.error("ScheduleMessageService, executeOnTimeup exception", e);
        //抛出异常，新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，10000ms后执行，本次任务结束
        this.scheduleNextTimerTask(this.offset, DELAY_FOR_A_PERIOD);
    }
}
```

### 3.1 executeOnTimeup执行延迟消息投递

延迟消息的核心逻辑实现，执行延迟消息消息投递。

**1、**
调用findConsumeQueue方法，根据topic和延迟队列id从consumeQueueTable查找需要写入的ConsumeQueue，如果没找到就新建，即ConsumeQueue文件是延迟创建的该方法的源码我们在ReputMessageService异步构建ConsumeQueue和IndexFile部分已经讲过了；
**2、**
如果没找到对应的消息队列，调用scheduleNextTimerTask方法，新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，100ms后执行，本次任务结束；
**3、**
调用getIndexBuffer方法，根据逻辑offset定位到物理偏移量，然后截取该偏移量之后的一段Buffer，其包含要拉取的消息的索引数据及对应consumeQueue文件之后的全部索引数据，即这里截取的Buffer可能包含多条索引数据该方法的源码我们在broker处理拉取消息请求部分已经讲过了；
**4、** 遍历缓存buffer中的消息，根据tagsCode投递时间判断消息是否到期，如果到期则回复真实消息并且投递安到真实topic以及对应的queueId中；

```
1.  获取该条目对应的消息的tagsCode，对于延迟消息，tagsCode被替换为延迟消息的发送时间（在CommitLog\#checkMessageAndReturnSize方法中，源码此前讲过了）。
```

**2、**
如果投递时间小于当前时间，那么可以投递该延迟消息如果投递时间大于当前时间，那么新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，指定新的消费偏移量，100ms后执行，本次任务结束；
**3、**
根据消息物理偏移量从commitLog中找到该条消息，调用messageTimeup方法构建内部消息对象，设置topic为REAL_TOPIC属性值，即原始topic，设置queueId为REAL_QID属性值，即原始queueId即恢复为正常消息；
**4、** 最后调用syncDeliver方法投递该消息，消息将会被投递到原始topic和队列中，这样就可以被消费了；
**5、** 遍历结束，更新下一个offset，新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，指定新的消费偏移量，100ms后执行，本次任务结束保证线程任务的活性；

```java
/**
 * DeliverDelayedMessageTimerTask的方法
 * <p>
 * 执行延迟消息消息投递
 */
public void executeOnTimeup() {
   
     
    /*
     * 1 根据topic和延迟队列id从consumeQueueTable查找需要写入的ConsumeQueue，如果没找到就新建，即ConsumeQueue文件是延迟创建的。
     * 该方法的源码我们在ReputMessageService异步构建ConsumeQueue和IndexFile部分已经讲过了
     */
    ConsumeQueue cq =
            ScheduleMessageService.this.defaultMessageStore.findConsumeQueue(TopicValidator.RMQ_SYS_SCHEDULE_TOPIC,
                    delayLevel2QueueId(delayLevel));
    /*
     * 2 如果没找到对应的消息队列，新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，100ms后执行，本次任务结束
     */
    if (cq == null) {
   
     
        this.scheduleNextTimerTask(this.offset, DELAY_FOR_A_WHILE);
        return;
    }
    /*
     * 3 根据逻辑offset定位到物理偏移量，然后截取该偏移量之后的一段Buffer，其包含要拉取的消息的索引数据及对应consumeQueue文件之后的全部索引数据。
     * 这里截取的Buffer可能包含多条索引数据，因为需要批量拉取多条消息，以及进行消息过滤。
     * 该方法的源码我们在broker处理拉取消息请求部分已经讲过了
     */
    SelectMappedBufferResult bufferCQ = cq.getIndexBuffer(this.offset);
    //没获取到缓存buffer
    if (bufferCQ == null) {
   
     
        long resetOffset;
        //如果当前消息队列的最小偏移量 大于 当前偏移量，那么当前偏移量无效，设置新的offset为最小偏移量
        if ((resetOffset = cq.getMinOffsetInQueue()) > this.offset) {
   
     
            log.error("schedule CQ offset invalid. offset={}, cqMinOffset={}, queueId={}",
                    this.offset, resetOffset, cq.getQueueId());
        }
        //如果当前消息队列的最大偏移量 小于 当前偏移量，那么当前偏移量无效，设置新的offset为最大偏移量
        else if ((resetOffset = cq.getMaxOffsetInQueue()) < this.offset) {
   
     
            log.error("schedule CQ offset invalid. offset={}, cqMaxOffset={}, queueId={}",
                    this.offset, resetOffset, cq.getQueueId());
        } else {
   
     
            resetOffset = this.offset;
        }
        //新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，指定新的消费偏移量，100ms后执行，本次任务结束
        this.scheduleNextTimerTask(resetOffset, DELAY_FOR_A_WHILE);
        return;
    }
    /*
     * 3 遍历缓存buffer中的消息，根据tagsCode投递时间判断消息是否到期，如果到期则回复真实消息并且投递安到真实topic以及对应的queueId中
     */
    //下一个消费的offset
    long nextOffset = this.offset;
    try {
   
     
        //i表示consumeQueue消息索引大小
        int i = 0;
        ConsumeQueueExt.CqExtUnit cqExtUnit = new ConsumeQueueExt.CqExtUnit();
        //遍历截取的Buffer中的consumeQueue消息索引，固定长度20b
        for (; i < bufferCQ.getSize() && isStarted(); i += ConsumeQueue.CQ_STORE_UNIT_SIZE) {
   
     
            //获取该条目对应的消息在commitlog文件中的物理偏移量
            long offsetPy = bufferCQ.getByteBuffer().getLong();
            //获取该条目对应的消息在commitlog文件中的总长度
            int sizePy = bufferCQ.getByteBuffer().getInt();
            //获取该条目对应的消息的tagsCode，对于延迟消息，tagsCode被替换为延迟消息的发送时间（CommitLog#checkMessageAndReturnSize方法中）
            long tagsCode = bufferCQ.getByteBuffer().getLong();
            //如果tagsCode是扩展文件地址
            if (cq.isExtAddr(tagsCode)) {
   
     
                if (cq.getExt(tagsCode, cqExtUnit)) {
   
     
                    tagsCode = cqExtUnit.getTagsCode();
                } else {
   
     
                    //can't find ext content.So re compute tags code.
                    log.error("[BUG] can't find consume queue extend file content!addr={}, offsetPy={}, sizePy={}",
                            tagsCode, offsetPy, sizePy);
                    long msgStoreTime = defaultMessageStore.getCommitLog().pickupStoreTimestamp(offsetPy, sizePy);
                    tagsCode = computeDeliverTimestamp(delayLevel, msgStoreTime);
                }
            }
            //当前时间戳
            long now = System.currentTimeMillis();
            //校验投递时间，必须小于等于当前时间 + 延迟时间
            long deliverTimestamp = this.correctDeliverTimestamp(now, tagsCode);
            //计算下一个offset
            nextOffset = offset + (i / ConsumeQueue.CQ_STORE_UNIT_SIZE);
            //如果投递时间大于当前时间，那么新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，指定新的消费偏移量，100ms后执行，本次任务结束
            long countdown = deliverTimestamp - now;
            if (countdown > 0) {
   
     
                this.scheduleNextTimerTask(nextOffset, DELAY_FOR_A_WHILE);
                return;
            }
            //根据消息物理偏移量从commitLog中找到该条消息。
            MessageExt msgExt = ScheduleMessageService.this.defaultMessageStore.lookMessageByOffset(offsetPy, sizePy);
            if (msgExt == null) {
   
     
                continue;
            }
            //构建内部消息对象，设置topic为REAL_TOPIC属性值，即原始topic，设置queueId为REAL_QID属性值，即原始queueId。即恢复为正常消息
            MessageExtBrokerInner msgInner = ScheduleMessageService.this.messageTimeup(msgExt);
            if (TopicValidator.RMQ_SYS_TRANS_HALF_TOPIC.equals(msgInner.getTopic())) {
   
     
                log.error("[BUG] the real topic of schedule msg is {}, discard the msg. msg={}",
                        msgInner.getTopic(), msgInner);
                continue;
            }

            boolean deliverSuc;
            /*
             * 消息投递
             */
            if (ScheduleMessageService.this.enableAsyncDeliver) {
   
     
                //异步投递，默认不支持
                deliverSuc = this.asyncDeliver(msgInner, msgExt.getMsgId(), offset, offsetPy, sizePy);
            } else {
   
     
                //默认同步投递
                deliverSuc = this.syncDeliver(msgInner, msgExt.getMsgId(), offset, offsetPy, sizePy);
            }
            //如果投递失败，那么新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，指定新的消费偏移量，100ms后执行，本次任务结束
            if (!deliverSuc) {
   
     
                this.scheduleNextTimerTask(nextOffset, DELAY_FOR_A_WHILE);
                return;
            }
        }
        //遍历结束，更新下一个offset
        nextOffset = this.offset + (i / ConsumeQueue.CQ_STORE_UNIT_SIZE);
    } catch (Exception e) {
   
     
        log.error("ScheduleMessageService, messageTimeup execute error, offset = {}", nextOffset, e);
    } finally {
   
     
        //释放内存
        bufferCQ.release();
    }
    /*
     * 4 新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，指定新的消费偏移量，100ms后执行，本次任务结束
     *
     * 保证线程任务的活性
     */
    this.scheduleNextTimerTask(nextOffset, DELAY_FOR_A_WHILE);
}
```

### 3.2 scheduleNextTimerTask下一个调度任务

*
*如果没找到对应的消息队列，或者没找到缓存buffer，或者没有过期的消息，获取投递失败等原因，将会新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，100ms后执行，本次任务结束。
**

```java
/**
 * DeliverDelayedMessageTimerTask的方法
 * <p>
 * 新建一个DeliverDelayedMessageTimerTask任务存入deliverExecutorService，100ms后执行，本次任务结束
 *
 * @param offset 消费偏移量
 * @param delay  延迟时间
 */
public void scheduleNextTimerTask(long offset, long delay) {
   
     
    ScheduleMessageService.this.deliverExecutorService.schedule(new DeliverDelayedMessageTimerTask(
            this.delayLevel, offset), delay, TimeUnit.MILLISECONDS);
}
```

### 3.3 correctDeliverTimestamp校验投递时间

校验投递时间，要求投递时间最晚不大于保证投递时间小于等于当前时间 + 延迟时间。

```java
/**
 * DeliverDelayedMessageTimerTask的方法
 * <p>
 * 校验投递时间
 */
private long correctDeliverTimestamp(final long now, final long deliverTimestamp) {
   
     
    //投递时间戳
    long result = deliverTimestamp;
    //当前时间 + 延迟时间
    long maxTimestamp = now + ScheduleMessageService.this.delayLevelTable.get(this.delayLevel);
    //保证投递时间小于等于当前时间 + 延迟时间
    if (deliverTimestamp > maxTimestamp) {
   
     
        result = now;
    }

    return result;
}
```

### 3.4 messageTimeup恢复正常消息

构建一个MessageExtBrokerInner，恢复为正常消息。设置topic的值为REAL_TOPIC属性值，这是原始topic，可能是重试topic或者真实topic。设置queueId的值为REAL_QID属性值，这是原始queueId，可能是重试queueId或者真实queueId。

```java
/**
 * DeliverDelayedMessageTimerTask的方法
 * <p>
 * 还原原始消息，设置topic为REAL_TOPIC属性值，即原始topic，设置queueId为REAL_QID属性值，即原始queueId。即恢复为正常消息
 *
 * @param msgExt 延迟消息
 * @return 真实消息
 */
private MessageExtBrokerInner messageTimeup(MessageExt msgExt) {
   
     
    //构建MessageExtBrokerInner对象
    MessageExtBrokerInner msgInner = new MessageExtBrokerInner();
    msgInner.setBody(msgExt.getBody());
    msgInner.setFlag(msgExt.getFlag());
    MessageAccessor.setProperties(msgInner, msgExt.getProperties());

    TopicFilterType topicFilterType = MessageExt.parseTopicFilterType(msgInner.getSysFlag());
    //延迟消息的tagsCode为投递时间，现在来计算真正的tagsCodeValue
    long tagsCodeValue =
            MessageExtBrokerInner.tagsString2tagsCode(topicFilterType, msgInner.getTags());
    msgInner.setTagsCode(tagsCodeValue);
    msgInner.setPropertiesString(MessageDecoder.messageProperties2String(msgExt.getProperties()));

    msgInner.setSysFlag(msgExt.getSysFlag());
    msgInner.setBornTimestamp(msgExt.getBornTimestamp());
    msgInner.setBornHost(msgExt.getBornHost());
    msgInner.setStoreHost(msgExt.getStoreHost());
    msgInner.setReconsumeTimes(msgExt.getReconsumeTimes());
    //不需要等待存储完成后才返回
    msgInner.setWaitStoreMsgOK(false);
    MessageAccessor.clearProperty(msgInner, MessageConst.PROPERTY_DELAY_TIME_LEVEL);
    //设置topic的值为REAL_TOPIC属性值，这是原始topic，可能是重试topic或者真实topic
    msgInner.setTopic(msgInner.getProperty(MessageConst.PROPERTY_REAL_TOPIC));
    //设置queueId的值为REAL_QID属性值，这是原始queueId，可能是重试queueId或者真实queueId
    String queueIdStr = msgInner.getProperty(MessageConst.PROPERTY_REAL_QUEUE_ID);
    int queueId = Integer.parseInt(queueIdStr);
    msgInner.setQueueId(queueId);

    return msgInner;
}
```

### 3.5 syncDeliver同步投递消息

**syncDeliver内部调用asyncPutMessage方法同步投递消息，投递完毕之后，更新offsetTable中的对应延迟队列的消费偏移量。**

**这里有个bug，第三个参数应该使用当前偏移量，而不是最开始的偏移量，在4.9.4版本已经修复。**

```java
/**
 * DeliverDelayedMessageTimerTask的方法
 * 同步投递
 * 这里有个bug，第三个参数应该使用当前偏移量，而不是最开始的偏移量，在4.9.4版本已经修复
 *
 * @param msgInner 内部消息对象
 * @param msgId    消息id
 * @param offset   当前消费偏移量
 * @param offsetPy 消息物理偏移量
 * @param sizePy   消息大小
 * @return
 */
private boolean syncDeliver(MessageExtBrokerInner msgInner, String msgId, long offset, long offsetPy,
                            int sizePy) {
   
     
    //投递消息，内部调用asyncPutMessage方法
    PutResultProcess resultProcess = deliverMessage(msgInner, msgId, offset, offsetPy, sizePy, false);
    //投递结果
    PutMessageResult result = resultProcess.get();
    boolean sendStatus = result != null && result.getPutMessageStatus() == PutMessageStatus.PUT_OK;
    if (sendStatus) {
   
     
        //如果发送成功，那么更新offsetTable中的消费偏移量
        ScheduleMessageService.this.updateOffset(this.delayLevel, resultProcess.getNextOffset());
    }
    return sendStatus;
}
```

## 4 延迟消息的总结

投递的消息在broker处理过成功，会判断如果是延迟消息，即DelayTimeLevel大于0，那么替换topic为SCHEDULE_TOPIC_XXXX，替换queueId为延迟队列id，
id = level - 1，如果延迟级别大于最大级别，则设置为最大级别18，默认延迟2h。这些参数可以在broker端配置类MessageStoreConfig中配置。

最后保存真实topic到消息的REAL_TOPIC属性，保存queueId到消息的REAL_QID属性，方便后面恢复。

而在RocketMQ端，通过ScheduleMessageService调度消息服务处理投递到SCHEDULE_TOPIC_XXXX的延迟消息。

从源码中可以看到，每个延迟级别都有一个线程专门处理该级别的延迟消息，这样避免了消息的排序，具体的处理逻辑其被封装为一个DeliverDelayedMessageTimerTask线程任务。

不同延迟级别的处理线程将会从各自对应的延迟队列中获取延迟消息，然后和当前时间比较看消息是否过期，如果消息过期，那么构造一个新的消息，设置topic为REAL_TOPIC属性值，即原始topic，设置queueId为REAL_QID属性值，即原始queueId，即恢复为正常消息然后再次进行投递。

另外，延迟消息的consumeQueue条目中的tagsCode并不是tag的hashCOde，而是该条消息的到期时间。

RocketMQ在内部通过内部topic替换实现延迟消息，非常巧妙，而且并发消息重试也是使用了延迟消息。



