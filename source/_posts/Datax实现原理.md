---

layout: XXL-JOB源码分析

title: XXL-JOB源码分析

tags: redis

categories: Web

top: 21

path: /article/1717108917

abbrlink: 1717108917

date: 2023-05-19 21:21:21


---

# Datax实现原理

DataX 是一个异构数据源离线同步工具，致力于实现包括关系型数据库(MySQL、Oracle等)
、HDFS、Hive、ODPS、HBase、FTP等各种异构数据源之间稳定高效的数据同步功能。

![img](https://img-blog.csdnimg.cn/20201102231833905.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L3FxXzMxOTU3NzQ3,size_16,color_FFFFFF,t_70)

为了解决异构数据源同步问题，DataX将复杂的网状的同步链路变成了星型数据链路，DataX作为中间传输载体负责连接各种数据源。当需要接入一个新的数据源的时候，只需要将此数据源对接到DataX，便能跟已有的数据源做到无缝数据同步。

DataX本身作为离线数据同步框架，采用Framework + plugin架构构建。将数据源读取和写入抽象成为Reader/Writer插件，纳入到整个同步框架中。

- **Reader**：Reader为数据采集模块，负责采集数据源的数据，将数据发送给Framework。
- **Writer**： Writer为数据写入模块，负责不断向Framework取数据，并将数据写入到目的端。
- **Framework**：Framework用于连接reader和writer，作为两者的数据传输通道，并处理缓冲，流控，并发，数据转换等核心技术问题。

![img](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406032035825.png)

核心架构

![img](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406032035071.png)

1. DataX完成单个数据同步的作业，我们称之为Job，DataX接受到一个Job之后，将启动一个进程来完成整个作业同步过程。DataX
   Job模块是单个作业的中枢管理节点，承担了数据清理、子任务切分(将单一作业计算转化为多个子Task)、TaskGroup管理等功能。
2. DataXJob启动后，会根据不同的源端切分策略，将Job切分成多个小的Task(子任务)
   ，以便于并发执行。Task便是DataX作业的最小单元，每一个Task都会负责一部分数据的同步工作。
3. 切分多个Task之后，DataX Job会调用Scheduler模块，根据配置的并发数据量，将拆分成的Task重新组合，组装成TaskGroup(任务组)
   。每一个TaskGroup负责以一定的并发运行完毕分配好的所有Task，默认单个任务组的并发数量为5。
4. 每一个Task都由TaskGroup负责启动，Task启动后，会固定启动Reader—>Channel—>Writer的线程来完成任务同步工作。
5. DataX作业运行起来之后， Job监控并等待多个TaskGroup模块任务完成，等待所有TaskGroup任务完成后Job成功退出。否则，异常退出，进程退出值非0

JobContainer实现了AbstractContainer的start方法。

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406032040859.png)

**- 生成scheduler实例**

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406032040160.png)

这里的scheduler实现类是StandAloneScheduler。

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406032041391.png)

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406032041274.png)

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406032041952.png)

① 首先创建固定数量的线程池
② 遍历任务组配置
③ 创建TaskGroupContainerRunner对象实例

![在这里插入图片描述](https://img-blog.csdnimg.cn/7754226b7f7145c1b1941ac372226741.png)

![在这里插入图片描述](https://img-blog.csdnimg.cn/53c703580ba7459390949a14ea55fb64.png)

从源码可得知，doStart本质上就是启动了writerTread和readerThread线程。writerTread的Runnable是WriterRunner，readThread的Runnable是ReaderRunner。

***Datax给我们提供了一个模板，所有的读取插件都要实现Job、Task两个内部类。而MysqlReader继承Reader并实现了Job和Task两个内部类，如下图：
***

![在这里插入图片描述](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406032043497.png)

本质上，MysqlReader其实是调用了CommonRdbmsReader的方法。它没干啥事，有兴趣的同学可以看下其他的read插件，其实可以发现PostgresReader、OracleReader等关系型数据库都是一样的，都是调用的模板方法。