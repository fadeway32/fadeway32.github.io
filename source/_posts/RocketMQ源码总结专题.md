---

layout:  RocketMQ专题

title:  RocketMQ专题

tags: RocketMq

categories: Web

top: 55

path: /article/1739713310

abbrlink: 1739713310

date: 2025-02-16 21:42:06


--- 

# RocketMQ专题

# 架构设计

---

## 1 技术架构

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005320.png)

RocketMQ架构上主要分为四部分，如上图所示:

- Producer：消息发布的角色，支持分布式集群方式部署。Producer通过MQ的负载均衡模块选择相应的Broker集群队列进行消息投递，投递的过程支持快速失败并且低延迟。

- Consumer：消息消费的角色，支持分布式集群方式部署。支持以push推，pull拉两种模式对消息进行消费。同时也支持集群方式和广播方式的消费，它提供实时消息订阅机制，可以满足大多数用户的需求。

-
NameServer：NameServer是一个非常简单的Topic路由注册中心，其角色类似Dubbo中的zookeeper，支持Broker的动态注册与发现。主要包括两个功能：Broker管理，NameServer接受Broker集群的注册信息并且保存下来作为路由信息的基本数据。然后提供心跳检测机制，检查Broker是否还存活；路由信息管理，每个NameServer将保存关于Broker集群的整个路由信息和用于客户端查询的队列信息。然后Producer和Conumser通过NameServer就可以知道整个Broker集群的路由信息，从而进行消息的投递和消费。NameServer通常也是集群的方式部署，各实例间相互不进行信息通讯。Broker是向每一台NameServer注册自己的路由信息，所以每一个NameServer实例上面都保存一份完整的路由信息。当某个NameServer因某种原因下线了，Broker仍然可以向其它NameServer同步其路由信息，Producer,Consumer仍然可以动态感知Broker的路由的信息。

- BrokerServer：Broker主要负责消息的存储、投递和查询以及服务高可用保证，为了实现这些功能，Broker包含了以下几个重要子模块。
    1. Remoting Module：整个Broker的实体，负责处理来自clients端的请求。
    2. Client Manager：负责管理客户端(Producer/Consumer)和维护Consumer的Topic订阅信息
    3. Store Service：提供方便简单的API接口处理消息存储到物理硬盘和查询功能。
    4. HA Service：高可用服务，提供Master Broker 和 Slave Broker之间的数据同步功能。
    5. Index Service：根据特定的Message key对投递到Broker的消息进行索引服务，以提供消息的快速查询。

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005325.png)

## 2 部署架构

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005327.png)

### RocketMQ 网络部署特点

- NameServer是一个几乎无状态节点，可集群部署，节点之间无任何信息同步。

- Broker部署相对复杂，Broker分为Master与Slave，一个Master可以对应多个Slave，但是一个Slave只能对应一个Master，Master与Slave
  的对应关系通过指定相同的BrokerName，不同的BrokerId
  来定义，BrokerId为0表示Master，非0表示Slave。Master也可以部署多个。每个Broker与NameServer集群中的所有节点建立长连接，定时注册Topic信息到所有NameServer。
  注意：当前RocketMQ版本在部署架构上支持一Master多Slave，但只有BrokerId=1的从服务器才会参与消息的读负载。

- Producer与NameServer集群中的其中一个节点（随机选择）建立长连接，定期从NameServer获取Topic路由信息，并向提供Topic
  服务的Master建立长连接，且定时向Master发送心跳。Producer完全无状态，可集群部署。

-
Consumer与NameServer集群中的其中一个节点（随机选择）建立长连接，定期从NameServer获取Topic路由信息，并向提供Topic服务的Master、Slave建立长连接，且定时向Master、Slave发送心跳。Consumer既可以从Master订阅消息，也可以从Slave订阅消息，消费者在向Master拉取消息时，Master服务器会根据拉取偏移量与最大偏移量的距离（判断是否读老消息，产生读I/O），以及从服务器是否可读等因素建议下一次是从Master还是Slave拉取。

结合部署架构图，描述集群工作流程：

- 启动NameServer，NameServer起来后监听端口，等待Broker、Producer、Consumer连上来，相当于一个路由控制中心。
- Broker启动，跟所有的NameServer保持长连接，定时发送心跳包。心跳包中包含当前Broker信息(IP+端口等)
  以及存储所有Topic信息。注册成功后，NameServer集群中就有Topic跟Broker的映射关系。
- 收发消息前，先创建Topic，创建Topic时需要指定该Topic要存储在哪些Broker上，也可以在发送消息时自动创建Topic。
-
Producer发送消息，启动时先跟NameServer集群中的其中一台建立长连接，并从NameServer中获取当前发送的Topic存在哪些Broker上，轮询从队列列表中选择一个队列，然后与队列所在的Broker建立长连接从而向Broker发消息。
- Consumer跟Producer类似，跟其中一台NameServer建立长连接，获取当前订阅Topic存在哪些Broker上，然后直接跟Broker建立连接通道，开始消费消息。

# 基本概念

----

## 1 消息模型（Message Model）

RocketMQ主要由 Producer、Broker、Consumer 三部分组成，其中Producer 负责生产消息，Consumer 负责消费消息，Broker 负责存储消息。Broker
在实际部署过程中对应一台服务器，每个 Broker 可以存储多个Topic的消息，每个Topic的消息也可以分片存储于不同的 Broker。Message
Queue 用于存储消息的物理地址，每个Topic中的消息地址存储于多个 Message Queue 中。ConsumerGroup 由多个Consumer 实例构成。

## 2 消息生产者（Producer）

负责生产消息，一般由业务系统负责生产消息。一个消息生产者会把业务应用系统里产生的消息发送到broker服务器。RocketMQ提供多种发送方式，同步发送、异步发送、顺序发送、单向发送。同步和异步方式均需要Broker返回确认信息，单向发送不需要。

## 3 消息消费者（Consumer）

负责消费消息，一般是后台系统负责异步消费。一个消息消费者会从Broker服务器拉取消息、并将其提供给应用程序。从用户应用的角度而言提供了两种消费形式：拉取式消费、推动式消费。

## 4 主题（Topic）

表示一类消息的集合，每个主题包含若干条消息，每条消息只能属于一个主题，是RocketMQ进行消息订阅的基本单位。

## 5 代理服务器（Broker Server）

消息中转角色，负责存储消息、转发消息。代理服务器在RocketMQ系统中负责接收从生产者发送来的消息并存储、同时为消费者的拉取请求作准备。代理服务器也存储消息相关的元数据，包括消费者组、消费进度偏移和主题和队列消息等。

## 6 名字服务（Name Server）

名称服务充当路由消息的提供者。生产者或消费者能够通过名字服务查找各主题相应的Broker IP列表。多个Namesrv实例组成集群，但相互独立，没有信息交换。

## 7 拉取式消费（Pull Consumer）

Consumer消费的一种类型，应用通常主动调用Consumer的拉消息方法从Broker服务器拉消息、主动权由应用控制。一旦获取了批量消息，应用就会启动消费过程。

## 8 推动式消费（Push Consumer）

Consumer消费的一种类型，该模式下Broker收到数据后会主动推送给消费端，该消费模式一般实时性较高。

## 9 生产者组（Producer Group）

同一类Producer的集合，这类Producer发送同一类消息且发送逻辑一致。如果发送的是事务消息且原始生产者在发送之后崩溃，则Broker服务器会联系同一生产者组的其他生产者实例以提交或回溯消费。

## 10 消费者组（Consumer Group）

同一类Consumer的集合，这类Consumer通常消费同一类消息且消费逻辑一致。消费者组使得在消息消费方面，实现负载均衡和容错的目标变得非常容易。要注意的是，消费者组的消费者实例必须订阅完全相同的Topic。RocketMQ
支持两种消息模式：集群消费（Clustering）和广播消费（Broadcasting）。

## 11 集群消费（Clustering）

集群消费模式下,相同Consumer Group的每个Consumer实例平均分摊消息。

## 12 广播消费（Broadcasting）

广播消费模式下，相同Consumer Group的每个Consumer实例都接收全量的消息。

## 13 普通顺序消息（Normal Ordered Message）

普通顺序消费模式下，消费者通过同一个消费队列收到的消息是有顺序的，不同消息队列收到的消息则可能是无顺序的。

## 14 严格顺序消息（Strictly Ordered Message）

严格顺序消息模式下，消费者收到的所有消息均是有顺序的。

## 15 消息（Message）

消息系统所传输信息的物理载体，生产和消费数据的最小单位，每条消息必须属于一个主题。RocketMQ中每个消息拥有唯一的Message
ID，且可以携带具有业务标识的Key。系统提供了通过Message ID和Key查询消息的功能。

## 16 标签（Tag）

为消息设置的标志，用于同一主题下区分不同类型的消息。来自同一业务单元的消息，可以根据不同业务目的在同一主题下设置不同标签。标签能够有效地保持代码的清晰度和连贯性，并优化RocketMQ提供的查询系统。消费者可以根据Tag实现对不同子主题的不同消费逻辑，实现更好的扩展性。

### 1 消息存储

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005740.png)

消息存储是RocketMQ中最为复杂和最为重要的一部分，本节将分别从RocketMQ的消息存储整体架构、PageCache与Mmap内存映射以及RocketMQ中两种不同的刷盘方式三方面来分别展开叙述。

#### 1.1 消息存储整体架构

消息存储架构图中主要有下面三个跟消息存储相关的文件构成。

(1) CommitLog：消息主体以及元数据的存储主体，存储Producer端写入的消息主体内容,消息内容不是定长的。单个文件大小默认1G
，文件名长度为20位，左边补零，剩余为起始偏移量，比如00000000000000000000代表了第一个文件，起始偏移量为0，文件大小为1G=1073741824；当第一个文件写满了，第二个文件为00000000001073741824，起始偏移量为1073741824，以此类推。消息主要是顺序写入日志文件，当文件满了，写入下一个文件；

(2)
ConsumeQueue：消息消费队列，引入的目的主要是提高消息消费的性能，由于RocketMQ是基于主题topic的订阅模式，消息消费是针对主题进行的，如果要遍历commitlog文件中根据topic检索消息是非常低效的。Consumer即可根据ConsumeQueue来查找待消费的消息。其中，ConsumeQueue（逻辑消费队列）作为消费消息的索引，保存了指定Topic下的队列消息在CommitLog中的起始物理偏移量offset，消息大小size和消息Tag的HashCode值。consumequeue文件可以看成是基于topic的commitlog索引文件，故consumequeue文件夹的组织方式如下：topic/queue/file三层组织结构，具体存储路径为：$HOME/store/consumequeue/{topic}/{queueId}/{fileName}。同样consumequeue文件采取定长设计，每一个条目共20个字节，分别为8字节的commitlog物理偏移量、4字节的消息长度、8字节tag
hashcode，单个文件由30W个条目组成，可以像数组一样随机访问每一个条目，每个ConsumeQueue文件大小约5.72M；

(3) IndexFile：IndexFile（索引文件）提供了一种可以通过key或时间区间来查询消息的方法。Index文件的存储位置是：$HOME
\store\index\${fileName}，文件名fileName是以创建时的时间戳命名的，固定的单个IndexFile文件大小约为400M，一个IndexFile可以保存
2000W个索引，IndexFile的底层存储设计为在文件系统中实现HashMap结构，故rocketmq的索引文件其底层实现为hash索引。

在上面的RocketMQ的消息存储整体架构图中可以看出，RocketMQ采用的是混合型的存储结构，即为Broker单个实例下所有的队列共用一个日志数据文件（即为CommitLog）来存储。RocketMQ的混合型存储结构(
多个Topic的消息实体内容都存储于一个CommitLog中)
针对Producer和Consumer分别采用了数据和索引部分相分离的存储结构，Producer发送消息至Broker端，然后Broker端使用同步或者异步的方式对消息刷盘持久化，保存至CommitLog中。只要消息被刷盘持久化至磁盘文件CommitLog中，那么Producer发送的消息就不会丢失。正因为如此，Consumer也就肯定有机会去消费这条消息。当无法拉取到消息后，可以等下一次消息拉取，同时服务端也支持长轮询模式，如果一个消息拉取请求未拉取到消息，Broker允许等待30s的时间，只要这段时间内有新消息到达，将直接返回给消费端。这里，RocketMQ的具体做法是，使用Broker端的后台服务线程—ReputMessageService不停地分发请求并异步构建ConsumeQueue（逻辑消费队列）和IndexFile（索引文件）数据。

#### 1.2 页缓存与内存映射

页缓存（PageCache)
是OS对文件的缓存，用于加速对文件的读写。一般来说，程序对文件进行顺序读写的速度几乎接近于内存的读写速度，主要原因就是由于OS使用PageCache机制对读写访问操作进行了性能优化，将一部分的内存用作PageCache。对于数据的写入，OS会先写入至Cache内，随后通过异步的方式由pdflush内核线程将Cache内的数据刷盘至物理磁盘上。对于数据的读取，如果一次读取文件时出现未命中PageCache的情况，OS从物理磁盘上访问读取文件的同时，会顺序对其他相邻块的数据文件进行预读取。

在RocketMQ中，ConsumeQueue逻辑消费队列存储的数据较少，并且是顺序读取，在page cache机制的预读取作用下，Consume
Queue文件的读性能几乎接近读内存，即使在有消息堆积情况下也不会影响性能。而对于CommitLog消息存储的日志数据文件来说，读取消息内容时候会产生较多的随机访问读取，严重影响性能。如果选择合适的系统IO调度算法，比如设置调度算法为“Deadline”（此时块存储采用SSD的话），随机读的性能也会有所提升。

另外，RocketMQ主要通过MappedByteBuffer对文件进行读写操作。其中，利用了NIO中的FileChannel模型将磁盘上的物理文件直接映射到用户态的内存地址中（这种Mmap的方式减少了传统IO将磁盘文件数据在操作系统内核地址空间的缓冲区和用户应用程序地址空间的缓冲区之间来回进行拷贝的性能开销），将对文件的操作转化为直接对内存地址进行操作，从而极大地提高了文件的读写效率（正因为需要使用内存映射机制，故RocketMQ的文件存储都使用定长结构来存储，方便一次将整个文件映射至内存）。

#### 1.3 消息刷盘

![](D:/opt/RocketMQC/docs/cn/image/rocketmq_design_2.png)

(1)
同步刷盘：如上图所示，只有在消息真正持久化至磁盘后RocketMQ的Broker端才会真正返回给Producer端一个成功的ACK响应。同步刷盘对MQ消息可靠性来说是一种不错的保障，但是性能上会有较大影响，一般适用于金融业务应用该模式较多。

(2) 异步刷盘：能够充分利用OS的PageCache的优势，只要消息写入PageCache即可将成功的ACK返回给Producer端。消息刷盘采用后台异步线程提交的方式进行，降低了读写延迟，提高了MQ的性能和吞吐量。

### 2 通信机制

RocketMQ消息队列集群主要包括NameServer、Broker(Master/Slave)、Producer、Consumer4个角色，基本通讯流程如下：

(1) Broker启动后需要完成一次将自己注册至NameServer的操作；随后每隔30s时间定时向NameServer上报Topic路由信息。

(2)
消息生产者Producer作为客户端发送消息时候，需要根据消息的Topic从本地缓存的TopicPublishInfoTable获取路由信息。如果没有则更新路由信息会从NameServer上重新拉取，同时Producer会默认每隔30s向NameServer拉取一次路由信息。

(3) 消息生产者Producer根据2）中获取的路由信息选择一个队列（MessageQueue）进行消息发送；Broker作为消息的接收者接收消息并落盘存储。

(4) 消息消费者Consumer根据2）中获取的路由信息，并再完成客户端的负载均衡后，选择其中的某一个或者某几个消息队列来拉取消息并进行消费。

从上面1）~3）中可以看出在消息生产者,
Broker和NameServer之间都会发生通信（这里只说了MQ的部分通信），因此如何设计一个良好的网络通信模块在MQ中至关重要，它将决定RocketMQ集群整体的消息传输能力与最终的性能。

rocketmq-remoting 模块是
RocketMQ消息队列中负责网络通信的模块，它几乎被其他所有需要网络通信的模块（诸如rocketmq-client、rocketmq-broker、rocketmq-namesrv）所依赖和引用。为了实现客户端与服务器之间高效的数据请求与接收，RocketMQ消息队列自定义了通信协议并在Netty的基础之上扩展了通信模块。

#### 2.1 Remoting通信类结构

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005736.png)

#### 2.2 协议设计与编解码

在Client和Server之间完成一次消息发送时，需要对发送的消息进行一个协议约定，因此就有必要自定义RocketMQ的消息协议。同时，为了高效地在网络中传输消息和对收到的消息读取，就需要对消息进行编解码。在RocketMQ中，RemotingCommand这个类在消息传输过程中对所有数据内容的封装，不但包含了所有的数据结构，还包含了编码解码操作。

| Header字段  | 类型                      | Request说明                               | Response说明             |
|-----------|-------------------------|-----------------------------------------|------------------------|
| code      | int                     | 请求操作码，应答方根据不同的请求码进行不同的业务处理              | 应答响应码。0表示成功，非0则表示各种错误  |
| language  | LanguageCode            | 请求方实现的语言                                | 应答方实现的语言               |
| version   | int                     | 请求方程序的版本                                | 应答方程序的版本               |
| opaque    | int                     | 相当于requestId，在同一个连接上的不同请求标识码，与响应消息中的相对应 | 应答不做修改直接返回             |
| flag      | int                     | 区分是普通RPC还是onewayRPC得标志                  | 区分是普通RPC还是onewayRPC得标志 |
| remark    | String                  | 传输自定义文本信息                               | 传输自定义文本信息              |
| extFields | HashMap<String, String> | 请求自定义扩展信息                               | 响应自定义扩展信息              |

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005729.png)

可见传输内容主要可以分为以下4部分：

(1) 消息长度：总长度，四个字节存储，占用一个int类型；

(2) 序列化类型&消息头长度：同样占用一个int类型，第一个字节表示序列化类型，后面三个字节表示消息头长度；

(3) 消息头数据：经过序列化后的消息头数据；

(4) 消息主体数据：消息主体的二进制字节数据内容；

#### 2.3 消息的通信方式和流程

在RocketMQ消息队列中支持通信的方式主要有同步(sync)、异步(async)、单向(oneway)
三种。其中“单向”通信模式相对简单，一般用在发送心跳包场景下，无需关注其Response。这里，主要介绍RocketMQ的异步通信流程。

![](D:/opt/RocketMQC/docs/cn/image/rocketmq_design_5.png)

#### 2.4 Reactor多线程设计

RocketMQ的RPC通信采用Netty组件作为底层通信库，同样也遵循了Reactor多线程模型，同时又在这之上做了一些扩展和优化。

![](D:/opt/RocketMQC/docs/cn/image/rocketmq_design_6.png)

上面的框图中可以大致了解RocketMQ中NettyRemotingServer的Reactor 多线程模型。一个 Reactor
主线程（eventLoopGroupBoss，即为上面的1）负责监听
TCP网络连接请求，建立好连接，创建SocketChannel，并注册到selector上。RocketMQ的源码中会自动根据OS的类型选择NIO和Epoll，也可以通过参数配置）,然后监听真正的网络数据。拿到网络数据后，再丢给Worker线程池（eventLoopGroupSelector，即为上面的“N”，源码中默认设置为3），在真正执行业务逻辑之前需要进行SSL验证、编解码、空闲检查、网络连接管理，这些工作交给defaultEventExecutorGroup（即为上面的“M1”，源码中默认设置为8）去做。而处理业务操作放在业务线程池中执行，根据
RomotingCommand 的业务请求码code去processorTable这个本地缓存变量中找到对应的
processor，然后封装成task任务后，提交给对应的业务processor处理线程池来执行（sendMessageExecutor，以发送消息为例，即为上面的
“M2”）。从入口到业务逻辑的几个步骤中线程池一直再增加，这跟每一步逻辑复杂性相关，越复杂，需要的并发通道越宽。

| 线程数 | 线程名                            | 线程具体说明           |
|-----|--------------------------------|------------------|
| 1   | NettyBoss_%d                   | Reactor 主线程      |
| N   | NettyServerEPOLLSelector_%d_%d | Reactor 线程池      |
| M1  | NettyServerCodecThread_%d      | Worker线程池        |
| M2  | RemotingExecutorThread_%d      | 业务processor处理线程池 |

### 3 消息过滤

RocketMQ分布式消息队列的消息过滤方式有别于其它MQ中间件，是在Consumer端订阅消息时再做消息过滤的。RocketMQ这么做是在于其Producer端写入消息和Consumer端订阅消息采用分离存储的机制来实现的，Consumer端订阅消息是需要通过ConsumeQueue这个消息消费的逻辑队列拿到一个索引，然后再从CommitLog里面读取真正的消息实体内容，所以说到底也是还绕不开其存储结构。其ConsumeQueue的存储结构如下，可以看到其中有8个字节存储的Message
Tag的哈希值，基于Tag的消息过滤正式基于这个字段值的。

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005446.png)

主要支持如下2种的过滤方式
(1) Tag过滤方式：Consumer端在订阅消息时除了指定Topic还可以指定TAG，如果一个消息有多个TAG，可以用||分隔。其中，Consumer端会将这个订阅请求构建成一个
SubscriptionData，发送一个Pull消息的请求给Broker端。Broker端从RocketMQ的文件存储层—Store读取数据之前，会用这些数据先构建一个MessageFilter，然后传给Store。Store从
ConsumeQueue读取到一条记录后，会用它记录的消息tag
hash值去做过滤，由于在服务端只是根据hashcode进行判断，无法精确对tag原始字符串进行过滤，故在消息消费端拉取到消息后，还需要对消息的原始tag字符串进行比对，如果不同，则丢弃该消息，不进行消息消费。

(2) SQL92的过滤方式：这种方式的大致做法和上面的Tag过滤方式一样，只是在Store层的具体过滤过程不太一样，真正的 SQL expression
的构建和执行由rocketmq-filter模块负责的。每次过滤都去执行SQL表达式会影响效率，所以RocketMQ使用了BloomFilter避免了每次都去执行。SQL92的表达式上下文为消息的属性。

### 4 负载均衡

RocketMQ中的负载均衡都在Client端完成，具体来说的话，主要可以分为Producer端发送消息时候的负载均衡和Consumer端订阅消息的负载均衡。

#### 4.1 Producer的负载均衡

Producer端在发送消息的时候，会先根据Topic找到指定的TopicPublishInfo，在获取了TopicPublishInfo路由信息后，RocketMQ的客户端在默认方式下selectOneMessageQueue()
方法会从TopicPublishInfo中的messageQueueList中选择一个队列（MessageQueue）进行发送消息。具体的容错策略均在MQFaultStrategy这个类中定义。这里有一个sendLatencyFaultEnable开关变量，如果开启，在随机递增取模的基础上，再过滤掉not
available的Broker代理。所谓的"latencyFaultTolerance"
，是指对之前失败的，按一定的时间做退避。例如，如果上次请求的latency超过550Lms，就退避3000Lms；超过1000L，就退避60000L；如果关闭，采用随机递增取模的方式选择一个队列（MessageQueue）来发送消息，latencyFaultTolerance机制是实现消息发送高可用的核心关键所在。

#### 4.2 Consumer的负载均衡

在RocketMQ中，Consumer端的两种消费模式（Push/Pull）都是基于拉模式来获取消息的，而在Push模式只是对pull模式的一种封装，其本质实现为消息拉取线程在从服务器拉取到一批消息后，然后提交到消息消费线程池后，又“马不停蹄”的继续向服务器再次尝试拉取消息。如果未拉取到消息，则延迟一下又继续拉取。在两种基于拉模式的消费方式（Push/Pull）中，均需要Consumer端在知道从Broker端的哪一个消息队列—队列中去获取消息。因此，有必要在Consumer端来做负载均衡，即Broker端中多个MessageQueue分配给同一个ConsumerGroup中的哪些Consumer消费。

1、Consumer端的心跳包发送

在Consumer启动后，它就会通过定时任务不断地向RocketMQ集群中的所有Broker实例发送心跳包（其中包含了，消息消费分组名称、订阅关系集合、消息通信模式和客户端id的值等信息）。Broker端在收到Consumer的心跳消息后，会将它维护在ConsumerManager的本地缓存变量—consumerTable，同时并将封装后的客户端网络通道信息保存在本地缓存变量—channelInfoTable中，为之后做Consumer端的负载均衡提供可以依据的元数据信息。

2、Consumer端实现负载均衡的核心类—RebalanceImpl

在Consumer实例的启动流程中的启动MQClientInstance实例部分，会完成负载均衡服务线程—RebalanceService的启动（每隔20s执行一次）。通过查看源码可以发现，RebalanceService线程的run()
方法最终调用的是RebalanceImpl类的rebalanceByTopic()方法，该方法是实现Consumer端负载均衡的核心。这里，rebalanceByTopic()
方法会根据消费者通信类型为“广播模式”还是“集群模式”做不同的逻辑处理。这里主要来看下集群模式下的主要处理流程：

(1) 从rebalanceImpl实例的本地缓存变量—topicSubscribeInfoTable中，获取该Topic主题下的消息消费队列集合（mqSet）；

(2) 根据topic和consumerGroup为参数调用mQClientFactory.findConsumerIdList()
方法向Broker端发送获取该消费组下消费者Id列表的RPC通信请求（Broker端基于前面Consumer端上报的心跳包数据而构建的consumerTable做出响应返回，业务请求码：GET_CONSUMER_LIST_BY_GROUP）；

(3)
先对Topic下的消息消费队列、消费者Id排序，然后用消息队列分配策略算法（默认为：消息队列的平均分配算法），计算出待拉取的消息队列。这里的平均分配算法，类似于分页的算法，将所有MessageQueue排好序类似于记录，将所有消费端Consumer排好序类似页数，并求出每一页需要包含的平均size和每个页面记录的范围range，最后遍历整个range而计算出当前Consumer端应该分配到的记录（这里即为：MessageQueue）。

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005638.png)

(4) 然后，调用updateProcessQueueTableInRebalance()方法，具体的做法是，先将分配到的消息队列集合（mqSet）与processQueueTable做一个过滤比对。

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005643.png)

-
上图中processQueueTable标注的红色部分，表示与分配到的消息队列集合mqSet互不包含。将这些队列设置Dropped属性为true，然后查看这些队列是否可以移除出processQueueTable缓存变量，这里具体执行removeUnnecessaryMessageQueue()
方法，即每隔1s 查看是否可以获取当前消费处理队列的锁，拿到的话返回true。如果等待1s后，仍然拿不到当前消费处理队列的锁则返回false。如果返回true，则从processQueueTable缓存变量中移除对应的Entry；

-
上图中processQueueTable的绿色部分，表示与分配到的消息队列集合mqSet的交集。判断该ProcessQueue是否已经过期了，在Pull模式的不用管，如果是Push模式的，设置Dropped属性为true，并且调用removeUnnecessaryMessageQueue()
方法，像上面一样尝试移除Entry；

最后，为过滤后的消息队列集合（mqSet）中的每个MessageQueue创建一个ProcessQueue对象并存入RebalanceImpl的processQueueTable队列中（其中调用RebalanceImpl实例的computePullFromWhere(
MessageQueue mq)
方法获取该MessageQueue对象的下一个进度消费值offset，随后填充至接下来要创建的pullRequest对象属性中），并创建拉取请求对象—pullRequest添加到拉取列表—pullRequestList中，最后执行dispatchPullRequest()
方法，将Pull消息的请求对象PullRequest依次放入PullMessageService服务线程的阻塞队列pullRequestQueue中，待该服务线程取出后向Broker端发起Pull消息的请求。其中，可以重点对比下，RebalancePushImpl和RebalancePullImpl两个实现类的dispatchPullRequest()
方法不同，RebalancePullImpl类里面的该方法为空，这样子也就回答了上一篇中最后的那道思考题了。

消息消费队列在同一消费组不同消费者之间的负载均衡，其核心设计理念是在一个消息消费队列在同一时间只允许被同一消费组内的一个消费者消费，一个消息消费者能同时消费多个消息队列。

### 5 事务消息

Apache RocketMQ在4.3.0版中已经支持分布式事务消息，这里RocketMQ采用了2PC的思想来实现了提交事务消息，同时增加一个补偿逻辑来处理二阶段超时或者失败的消息，如下图所示。

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005698.png)

#### 5.1 RocketMQ事务消息流程概要

上图说明了事务消息的大致方案，其中分为两个流程：正常事务消息的发送及提交、事务消息的补偿流程。

1.事务消息发送及提交：

(1) 发送消息（half消息）。

(2) 服务端响应消息写入结果。

(3) 根据发送结果执行本地事务（如果写入失败，此时half消息对业务不可见，本地逻辑不执行）。

(4) 根据本地事务状态执行Commit或者Rollback（Commit操作生成消息索引，消息对消费者可见）

2.补偿流程：

(1) 对没有Commit/Rollback的事务消息（pending状态的消息），从服务端发起一次“回查”

(2) Producer收到回查消息，检查回查消息对应的本地事务的状态

(3) 根据本地事务状态，重新Commit或者Rollback

其中，补偿阶段用于解决消息Commit或者Rollback发生超时或者失败的情况。

#### 5.2 RocketMQ事务消息设计

1.事务消息在一阶段对用户不可见

在RocketMQ事务消息的主要流程中，一阶段的消息如何对用户不可见。其中，事务消息相对普通消息最大的特点就是一阶段发送的消息对用户是不可见的。那么，如何做到写入消息但是对用户不可见呢？RocketMQ事务消息的做法是：如果消息是half消息，将备份原消息的主题与消息消费队列，然后改变主题为RMQ_SYS_TRANS_HALF_TOPIC。由于消费组未订阅该主题，故消费端无法消费half类型的消息，然后RocketMQ会开启一个定时任务，从Topic为RMQ_SYS_TRANS_HALF_TOPIC中拉取消息进行消费，根据生产者组获取一个服务提供者发送回查事务状态请求，根据事务状态来决定是提交或回滚消息。

在RocketMQ中，消息在服务端的存储结构如下，每条消息都会有对应的索引信息，Consumer通过ConsumeQueue这个二级索引来读取消息实体内容，其流程如下：

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005033.png)

RocketMQ的具体实现策略是：写入的如果事务消息，对消息的Topic和Queue等属性进行替换，同时将原来的Topic和Queue信息存储到消息的属性中，正因为消息主题被替换，故消息并不会转发到该原主题的消息消费队列，消费者无法感知消息的存在，不会消费。其实改变消息主题是RocketMQ的常用“套路”，回想一下延时消息的实现机制。

2.Commit和Rollback操作以及Op消息的引入

在完成一阶段写入一条对用户不可见的消息后，二阶段如果是Commit操作，则需要让消息对用户可见；如果是Rollback则需要撤销一阶段的消息。先说Rollback的情况。对于Rollback，本身一阶段的消息对用户是不可见的，其实不需要真正撤销消息（实际上RocketMQ也无法去真正的删除一条消息，因为是顺序写文件的）。但是区别于这条消息没有确定状态（Pending状态，事务悬而未决），需要一个操作来标识这条消息的最终状态。RocketMQ事务消息方案中引入了Op消息的概念，用Op消息标识事务消息已经确定的状态（Commit或者Rollback）。如果一条事务消息没有对应的Op消息，说明这个事务的状态还无法确定（可能是二阶段失败了）。引入Op消息后，事务消息无论是Commit或者Rollback都会记录一个Op操作。Commit相对于Rollback只是在写入Op消息前创建Half消息的索引。

3.Op消息的存储和对应关系

RocketMQ将Op消息写入到全局一个特定的Topic中通过源码中的方法—TransactionalMessageUtil.buildOpTopic()
；这个Topic是一个内部的Topic（像Half消息的Topic一样），不会被用户消费。Op消息的内容为对应的Half消息的存储的Offset，这样通过Op消息能索引到Half消息进行后续的回查操作。

![](D:/opt/RocketMQC/docs/cn/image/rocketmq_design_12.png)

4.Half消息的索引构建

在执行二阶段Commit操作时，需要构建出Half消息的索引。一阶段的Half消息由于是写到一个特殊的Topic，所以二阶段构建索引时需要读取出Half消息，并将Topic和Queue替换成真正的目标的Topic和Queue，之后通过一次普通消息的写入操作来生成一条对用户可见的消息。所以RocketMQ事务消息二阶段其实是利用了一阶段存储的消息的内容，在二阶段时恢复出一条完整的普通消息，然后走一遍消息写入流程。

5.如何处理二阶段失败的消息？

如果在RocketMQ事务消息的二阶段过程中失败了，例如在做Commit操作时，出现网络问题导致Commit失败，那么需要通过一定的策略使这条消息最终被Commit。RocketMQ采用了一种补偿机制，称为“回查”。Broker端对未确定状态的消息发起回查，将消息发送到对应的Producer端（同一个Group的Producer），由Producer根据消息来检查本地事务的状态，进而执行Commit或者Rollback。Broker端通过对比Half消息和Op消息进行事务消息的回查并且推进CheckPoint（记录那些事务消息的状态是确定的）。

值得注意的是，rocketmq并不会无休止的的信息事务状态回查，默认回查15次，如果15次回查还是无法得知事务状态，rocketmq默认回滚该消息。

### 6 消息查询

RocketMQ支持按照下面两种维度（“按照Message Id查询消息”、“按照Message Key查询消息”）进行消息查询。

#### 6.1   按照MessageId查询消息

RocketMQ中的MessageId的长度总共有16字节，其中包含了消息存储主机地址（IP地址和端口），消息Commit Log
offset。“按照MessageId查询消息”在RocketMQ中具体做法是：Client端从MessageId中解析出Broker的地址（IP地址和端口）和Commit
Log的偏移地址后封装成一个RPC请求后通过Remoting通信层发送（业务请求码：VIEW_MESSAGE_BY_ID）。Broker端走的是QueryMessageProcessor，读取消息的过程用其中的
commitLog offset 和 size 去 commitLog 中找到真正的记录并解析成一个完整的消息返回。

#### 6.2  按照Message Key查询消息

“按照Message Key查询消息”，主要是基于RocketMQ的IndexFile索引文件来实现的。RocketMQ的索引文件逻辑结构，类似JDK中HashMap的实现。索引文件的具体结构如下：

![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162005398.png)

IndexFile索引文件为用户提供通过“按照Message
Key查询消息”的消息索引查询服务，IndexFile文件的存储位置是：$HOME\store\index\${fileName}，文件名fileName是以创建时的时间戳命名的，文件大小是固定的，等于40+500W\*4+2000W\*20=
420000040个字节大小。如果消息的properties中设置了UNIQ_KEY这个属性，就用 topic + “#” + UNIQ_KEY的value作为 key
来做写入操作。如果消息设置了KEYS属性（多个KEY以空格分隔），也会用 topic + “#” + KEY 来做索引。

其中的索引数据包含了Key Hash/CommitLog Offset/Timestamp/NextIndex offset 这四个字段，一共20 Byte。NextIndex offset 即前面读出来的
slotValue，如果有 hash冲突，就可以用这个字段将所有冲突的索引用链表的方式串起来了。Timestamp记录的是消息storeTimestamp之间的差，并不是一个绝对的时间。整个Index
File的结构如图，40 Byte 的Header用于保存一些总的统计信息，4\*500W的 Slot Table并不保存真正的索引数据，而是保存每个槽位对应的单向链表的头。20\*2000W
是真正的索引数据，即一个 Index File 可以保存 2000W个索引。

“按照Message
Key查询消息”的方式，RocketMQ的具体做法是，主要通过Broker端的QueryMessageProcessor业务处理器来查询，读取消息的过程就是用topic和key找到IndexFile索引文件中的一条记录，根据其中的commitLog
offset从CommitLog文件中读取消息的实体内容。

# 特性(features)

----

## 1 订阅与发布

消息的发布是指某个生产者向某个topic发送消息；消息的订阅是指某个消费者关注了某个topic中带有某些tag的消息，进而从该topic消费数据。

## 2 消息顺序

消息有序指的是一类消息消费时，能按照发送的顺序来消费。例如：一个订单产生了三条消息分别是订单创建、订单付款、订单完成。消费时要按照这个顺序消费才能有意义，但是同时订单之间是可以并行消费的。RocketMQ可以严格的保证消息有序。

顺序消息分为全局顺序消息与分区顺序消息，全局顺序是指某个Topic下的所有消息都要保证顺序；部分顺序消息只要保证每一组消息被顺序消费即可。

- 全局顺序
  对于指定的一个 Topic，所有消息按照严格的先入先出（FIFO）的顺序进行发布和消费。
  适用场景：性能要求不高，所有的消息严格按照 FIFO 原则进行消息发布和消费的场景
- 分区顺序
  对于指定的一个 Topic，所有消息根据 sharding key 进行区块分区。 同一个分区内的消息按照严格的 FIFO 顺序进行发布和消费。
  Sharding key 是顺序消息中用来区分不同分区的关键字段，和普通消息的 Key 是完全不同的概念。
  适用场景：性能要求高，以 sharding key 作为分区字段，在同一个区块中严格的按照 FIFO 原则进行消息发布和消费的场景。

## 3 消息过滤

RocketMQ的消费者可以根据Tag进行消息过滤，也支持自定义属性过滤。消息过滤目前是在Broker端实现的，优点是减少了对于Consumer无用消息的网络传输，缺点是增加了Broker的负担、而且实现相对复杂。

## 4 消息可靠性

RocketMQ支持消息的高可靠，影响消息可靠性的几种情况：

1) Broker非正常关闭
2) Broker异常Crash
3) OS Crash
4) 机器掉电，但是能立即恢复供电情况
5) 机器无法开机（可能是cpu、主板、内存等关键设备损坏）
6) 磁盘设备损坏

1)、2)、3)、4) 四种情况都属于硬件资源可立即恢复情况，RocketMQ在这四种情况下能保证消息不丢，或者丢失少量数据（依赖刷盘方式是同步还是异步）。

5)、6)
属于单点故障，且无法恢复，一旦发生，在此单点上的消息全部丢失。RocketMQ在这两种情况下，通过异步复制，可保证99%的消息不丢，但是仍然会有极少量的消息可能丢失。通过同步双写技术可以完全避免单点，同步双写势必会影响性能，适合对消息可靠性要求极高的场合，例如与Money相关的应用。注：RocketMQ从3.0版本开始支持同步双写。

## 5 至少一次

至少一次(At least Once)指每个消息必须投递一次。Consumer先Pull消息到本地，消费完成后，才向服务器返回ack，如果没有消费一定不会ack消息，所以RocketMQ可以很好的支持此特性。

## 6 回溯消费

回溯消费是指Consumer已经消费成功的消息，由于业务上需求需要重新消费，要支持此功能，Broker在向Consumer投递成功消息后，消息仍然需要保留。并且重新消费一般是按照时间维度，例如由于Consumer系统故障，恢复后需要重新消费1小时前的数据，那么Broker要提供一种机制，可以按照时间维度来回退消费进度。RocketMQ支持按照时间回溯消费，时间维度精确到毫秒。

## 7 事务消息

RocketMQ事务消息（Transactional Message）是指应用本地事务和发送消息操作可以被定义到全局事务中，要么同时成功，要么同时失败。RocketMQ的事务消息提供类似
X/Open XA 的分布事务功能，通过事务消息能达到分布式事务的最终一致。

## 8 定时消息

定时消息（延迟队列）是指消息发送到broker后，不会立即被消费，等待特定时间投递给真正的topic。
broker有配置项messageDelayLevel，默认值为“1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m 1h
2h”，18个level。可以配置自定义messageDelayLevel。注意，messageDelayLevel是broker的属性，不属于某个topic。发消息时，设置delayLevel等级即可：msg.setDelayLevel(
level)。level有以下三种情况：

- level == 0，消息为非延迟消息
- 1<=level<=maxLevel，消息延迟特定时间，例如level==1，延迟1s
- level > maxLevel，则level== maxLevel，例如level==20，延迟2h

定时消息会暂存在名为SCHEDULE_TOPIC_XXXX的topic中，并根据delayTimeLevel存入特定的queue，queueId = delayTimeLevel –
1，即一个queue只存相同延迟的消息，保证具有相同发送延迟的消息能够顺序消费。broker会调度地消费SCHEDULE_TOPIC_XXXX，将消息写入真实的topic。

需要注意的是，定时消息会在第一次写入和调度写入真实topic时都会计数，因此发送数量、tps都会变高。

## 9 消息重试

Consumer消费消息失败后，要提供一种重试机制，令消息再消费一次。Consumer消费消息失败通常可以认为有以下几种情况：

-
由于消息本身的原因，例如反序列化失败，消息数据本身无法处理（例如话费充值，当前消息的手机号被注销，无法充值）等。这种错误通常需要跳过这条消息，再消费其它消息，而这条失败的消息即使立刻重试消费，99%也不成功，所以最好提供一种定时重试机制，即过10秒后再重试。
- 由于依赖的下游应用服务不可用，例如db连接不可用，外系统网络不可达等。遇到这种错误，即使跳过当前失败的消息，消费其他消息同样也会报错。这种情况建议应用sleep
  30s，再消费下一条消息，这样可以减轻Broker重试消息的压力。

RocketMQ会为每个消费组都设置一个Topic名称为“%RETRY%+consumerGroup”的重试队列（这里需要注意的是，这个Topic的重试队列是针对消费组，而不是针对每个Topic设置的），用于暂时保存因为各种异常而导致Consumer端无法消费的消息。考虑到异常恢复起来需要一些时间，会为重试队列设置多个重试级别，每个重试级别都有与之对应的重新投递延时，重试次数越多投递延时就越大。RocketMQ对于重试消息的处理是先保存至Topic名称为“SCHEDULE_TOPIC_XXXX”的延迟队列中，后台定时任务按照对应的时间进行Delay后重新保存至“%RETRY%+consumerGroup”的重试队列中。

## 10 消息重投

生产者在发送消息时，同步消息失败会重投，异步消息有重试，oneway没有任何保证。消息重投保证消息尽可能发送成功、不丢失，但可能会造成消息重复，消息重复在RocketMQ中是无法避免的问题。消息重复在一般情况下不会发生，当出现消息量大、网络抖动，消息重复就会是大概率事件。另外，生产者主动重发、consumer负载变化也会导致重复消息。如下方法可以设置消息重试策略：

- retryTimesWhenSendFailed:同步发送失败重投次数，默认为2，因此生产者会最多尝试发送retryTimesWhenSendFailed +
  1次。不会选择上次失败的broker，尝试向其他broker发送，最大程度保证消息不丢。超过重投次数，抛出异常，由客户端保证消息不丢。当出现RemotingException、MQClientException和部分MQBrokerException时会重投。
- retryTimesWhenSendAsyncFailed:异步发送失败重试次数，异步重试不会选择其他broker，仅在同一个broker上做重试，不保证消息不丢。
- retryAnotherBrokerWhenNotStoreOK:消息刷盘（主或备）超时或slave不可用（返回状态非SEND_OK），是否尝试发送到其他broker，默认false。十分重要消息可以开启。

## 11 流量控制

生产者流控，因为broker处理能力达到瓶颈；消费者流控，因为消费能力达到瓶颈。

生产者流控：

- commitLog文件被锁时间超过osPageCacheBusyTimeOutMills时，参数默认为1000ms，返回流控。
- 如果开启transientStorePoolEnable == true，且broker为异步刷盘的主机，且transientStorePool中资源不足，拒绝当前send请求，返回流控。
- broker每隔10ms检查send请求队列头部请求的等待时间，如果超过waitTimeMillsInSendQueue，默认200ms，拒绝当前send请求，返回流控。
- broker通过拒绝send 请求方式实现流量控制。

注意，生产者流控，不会尝试消息重投。

消费者流控：

- 消费者本地缓存消息数超过pullThresholdForQueue时，默认1000。
- 消费者本地缓存消息大小超过pullThresholdSizeForQueue时，默认100MB。
- 消费者本地缓存消息跨度超过consumeConcurrentlyMaxSpan时，默认2000。

消费者流控的结果是降低拉取频率。

## 12 死信队列

死信队列用于处理无法被正常消费的消息。当一条消息初次消费失败，消息队列会自动进行消息重试；达到最大重试次数后，若消费依然失败，则表明消费者在正常情况下无法正确地消费该消息，此时，消息队列
不会立刻将消息丢弃，而是将其发送到该消费者对应的特殊队列中。

RocketMQ将这种正常情况下无法被消费的消息称为死信消息（Dead-Letter Message），将存储死信消息的特殊队列称为死信队列（Dead-Letter
Queue）。在RocketMQ中，可以通过使用console控制台对死信队列中的消息进行重发来使得消费者实例再次进行消费。

# 运维管理

---

### 1   集群搭建

#### 1.1 单Master模式

这种方式风险较大，一旦Broker重启或者宕机时，会导致整个服务不可用。不建议线上环境使用,可以用于本地测试。

##### 1）启动 NameServer

```bash
### 首先启动Name Server
$ nohup sh mqnamesrv &
 
### 验证Name Server 是否启动成功
$ tail -f ~/logs/rocketmqlogs/namesrv.log
The Name Server boot success...
```

##### 2）启动 Broker

```bash
### 启动Broker
$ nohup sh bin/mqbroker -n localhost:9876 &

### 验证Name Server 是否启动成功，例如Broker的IP为：192.168.1.2，且名称为broker-a
$ tail -f ~/logs/rocketmqlogs/Broker.log 
The broker[broker-a, 192.169.1.2:10911] boot success...
```

#### 1.2 多Master模式

一个集群无Slave，全是Master，例如2个Master或者3个Master，这种模式的优缺点如下：

- 优点：配置简单，单个Master宕机或重启维护对应用无影响，在磁盘配置为RAID10时，即使机器宕机不可恢复情况下，由于RAID10磁盘非常可靠，消息也不会丢（异步刷盘丢失少量消息，同步刷盘一条不丢），性能最高；

- 缺点：单台机器宕机期间，这台机器上未被消费的消息在机器恢复之前不可订阅，消息实时性会受到影响。

##### 1）启动NameServer

NameServer需要先于Broker启动，且如果在生产环境使用，为了保证高可用，建议一般规模的集群启动3个NameServer，各节点的启动命令相同，如下：

```bash
### 首先启动Name Server
$ nohup sh mqnamesrv &
 
### 验证Name Server 是否启动成功
$ tail -f ~/logs/rocketmqlogs/namesrv.log
The Name Server boot success...
```

##### 2）启动Broker集群

```bash
### 在机器A，启动第一个Master，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-noslave/broker-a.properties &
 
### 在机器B，启动第二个Master，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-noslave/broker-b.properties &

...
```

如上启动命令是在单个NameServer情况下使用的。对于多个NameServer的集群，Broker启动命令中`-n`
后面的地址列表用分号隔开即可，例如 `192.168.1.1:9876;192.161.2:9876`。

#### 1.3 多Master多Slave模式-异步复制

每个Master配置一个Slave，有多对Master-Slave，HA采用异步复制方式，主备有短暂消息延迟（毫秒级），这种模式的优缺点如下：

- 优点：即使磁盘损坏，消息丢失的非常少，且消息实时性不会受影响，同时Master宕机后，消费者仍然可以从Slave消费，而且此过程对应用透明，不需要人工干预，性能同多Master模式几乎一样；

- 缺点：Master宕机，磁盘损坏情况下会丢失少量消息。

##### 1）启动NameServer

```bash
### 首先启动Name Server
$ nohup sh mqnamesrv &
 
### 验证Name Server 是否启动成功
$ tail -f ~/logs/rocketmqlogs/namesrv.log
The Name Server boot success...
```

##### 2）启动Broker集群

```bash
### 在机器A，启动第一个Master，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-2s-async/broker-a.properties &
 
### 在机器B，启动第二个Master，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-2s-async/broker-b.properties &
 
### 在机器C，启动第一个Slave，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-2s-async/broker-a-s.properties &
 
### 在机器D，启动第二个Slave，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-2s-async/broker-b-s.properties &
```

#### 1.4 多Master多Slave模式-同步双写

每个Master配置一个Slave，有多对Master-Slave，HA采用同步双写方式，即只有主备都写成功，才向应用返回成功，这种模式的优缺点如下：

- 优点：数据与服务都无单点故障，Master宕机情况下，消息无延迟，服务可用性与数据可用性都非常高；

- 缺点：性能比异步复制模式略低（大约低10%左右），发送单个消息的RT会略高，且目前版本在主节点宕机后，备机不能自动切换为主机。

##### 1）启动NameServer

```bash
### 首先启动Name Server
$ nohup sh mqnamesrv &
 
### 验证Name Server 是否启动成功
$ tail -f ~/logs/rocketmqlogs/namesrv.log
The Name Server boot success...
```

##### 2）启动Broker集群

```bash
### 在机器A，启动第一个Master，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-2s-sync/broker-a.properties &
 
### 在机器B，启动第二个Master，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-2s-sync/broker-b.properties &
 
### 在机器C，启动第一个Slave，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-2s-sync/broker-a-s.properties &
 
### 在机器D，启动第二个Slave，例如NameServer的IP为：192.168.1.1
$ nohup sh mqbroker -n 192.168.1.1:9876 -c $ROCKETMQ_HOME/conf/2m-2s-sync/broker-b-s.properties &
```

以上Broker与Slave配对是通过指定相同的BrokerName参数来配对，Master的BrokerId必须是0，Slave的BrokerId必须是大于0的数。另外一个Master下面可以挂载多个Slave，同一Master下的多个Slave通过指定不同的BrokerId来区分。$ROCKETMQ_HOME指的RocketMQ安装目录，需要用户自己设置此环境变量。

### 2 mqadmin管理工具

> 注意：
>
> 1. 执行命令方法：`./mqadmin {command} {args}`
> 2. 几乎所有命令都需要配置-n表示NameServer地址，格式为ip:port
> 3. 几乎所有命令都可以通过-h获取帮助
> 4.
如果既有Broker地址（-b）配置项又有clusterName（-c）配置项，则优先以Broker地址执行命令，如果不配置Broker地址，则对集群中所有主机执行命令，只支持一个Broker地址。-b格式为ip:
port，port默认是10911
> 5. 在tools下可以看到很多命令，但并不是所有命令都能使用，只有在MQAdminStartup中初始化的命令才能使用，你也可以修改这个类，增加或自定义命令
> 6. 由于版本更新问题，少部分命令可能未及时更新，遇到错误请直接阅读相关命令源码

#### 2.1 Topic相关

<table border=0 cellpadding=0 cellspacing=0 width=714>
 <col width=177>
 <col width=175>
 <col width=177>
 <col width=185>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl63 width=177 style='height:17.0pt;width:133pt'>名称</td>
  <td class=xl64 width=175 style='width:131pt'>含义</td>
  <td class=xl64 width=177 style='width:133pt'>命令选项</td>
  <td class=xl64 width=185 style='width:139pt'>说明</td>
 </tr>
 <tr height=132 style='height:99.0pt'>
  <td rowspan=8 height=593 class=xl68 width=163 style='border-bottom:1.0pt;
  height:444.0pt;border-top:none;width:122pt'>updateTopic</td>
  <td rowspan=8 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>创建更新Topic配置</td>
  <td class=xl65 width=149 style='width:112pt'>-b</td>
  <td class=xl66 width=159 style='width:119pt'>Broker 地址，表示 topic 所在
  Broker，只支持单台Broker，地址为ip:port</td>
 </tr>
 <tr height=132 style='height:99.0pt'>
  <td height=132 class=xl65 width=149 style='height:99.0pt;width:112pt'>-c</td>
  <td class=xl66 width=159 style='width:119pt'>cluster 名称，表示 topic 所在集群（集群可通过
  clusterList 查询）</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=149 style='height:17.0pt;width:112pt'>-h-</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer服务地址，格式 ip:port</td>
 </tr>
 <tr height=76 style='height:57.0pt'>
  <td height=76 class=xl65 width=149 style='height:57.0pt;width:112pt'>-p</td>
  <td class=xl66 width=159 style='width:119pt'>指定新topic的读写权限( W=2|R=4|WR=6 )</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl65 width=149 style='height:29.0pt;width:112pt'>-r</td>
  <td class=xl66 width=159 style='width:119pt'>可读队列数（默认为 8）</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl65 width=149 style='height:29.0pt;width:112pt'>-w</td>
  <td class=xl66 width=159 style='width:119pt'>可写队列数（默认为 8）</td>
 </tr>
 <tr height=95 style='height:71.0pt'>
  <td height=95 class=xl65 width=149 style='height:71.0pt;width:112pt'>-t</td>
  <td class=xl66 width=159 style='width:119pt'>topic 名称（名称只能使用字符
  ^[a-zA-Z0-9_-]+$ ）</td>
 </tr>
 <tr height=132 style='height:99.0pt'>
  <td rowspan=4 height=307 class=xl68 width=163 style='border-bottom:1.0pt;
  height:230.0pt;border-top:none;width:122pt'>deleteTopic</td>
  <td rowspan=4 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>删除Topic</td>
  <td class=xl65 width=149 style='width:112pt'>-c</td>
  <td class=xl66 width=159 style='width:119pt'>cluster 名称，表示删除某集群下的某个 topic （集群
  可通过 clusterList 查询）</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=149 style='height:17.0pt;width:112pt'>-h</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=95 style='height:71.0pt'>
  <td height=95 class=xl65 width=149 style='height:71.0pt;width:112pt'>-t</td>
  <td class=xl66 width=159 style='width:119pt'>topic 名称（名称只能使用字符
  ^[a-zA-Z0-9_-]+$ ）</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=3 height=287 class=xl68 width=163 style='border-bottom:1.0pt;
  height:215.0pt;border-top:none;width:122pt'>topicList</td>
  <td rowspan=3 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>查看 Topic 列表信息</td>
  <td class=xl65 width=149 style='width:112pt'>-h</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=207 style='height:155.0pt'>
  <td height=207 class=xl65 width=149 style='height:155.0pt;width:112pt'>-c</td>
  <td class=xl66 width=159 style='width:119pt'>不配置-c只返回topic列表，增加-c返回clusterName,
  topic, consumerGroup信息，即topic的所属集群和订阅关系，没有参数</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=3 height=103 class=xl68 width=163 style='border-bottom:1.0pt;
  height:77.0pt;border-top:none;width:122pt'>topicRoute</td>
  <td rowspan=3 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>查看 Topic 路由信息</td>
  <td class=xl65 width=149 style='width:112pt'>-t</td>
  <td class=xl66 width=159 style='width:119pt'>topic 名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=149 style='height:17.0pt;width:112pt'>-h</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=3 height=103 class=xl68 width=163 style='border-bottom:1.0pt;
  height:77.0pt;border-top:none;width:122pt'>topicStatus</td>
  <td rowspan=3 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>查看 Topic 消息队列offset</td>
  <td class=xl65 width=149 style='width:112pt'>-t</td>
  <td class=xl66 width=159 style='width:119pt'>topic 名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=149 style='height:17.0pt;width:112pt'>-h</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=3 height=103 class=xl68 width=163 style='border-bottom:1.0pt;
  height:77.0pt;border-top:none;width:122pt'>topicClusterList</td>
  <td rowspan=3 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>查看 Topic 所在集群列表</td>
  <td class=xl65 width=149 style='width:112pt'>-t</td>
  <td class=xl66 width=159 style='width:119pt'>topic 名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=149 style='height:17.0pt;width:112pt'>-h</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=6 height=518 class=xl68 width=163 style='border-bottom:1.0pt;
  height:380pt;border-top:none;width:122pt'>updateTopicPerm</td>
  <td rowspan=6 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>更新 Topic 读写权限</td>
  <td class=xl65 width=149 style='width:112pt'>-t</td>
  <td class=xl66 width=159 style='width:119pt'>topic 名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=149 style='height:17.0pt;width:112pt'>-h</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=132 style='height:99.0pt'>
  <td height=132 class=xl65 width=149 style='height:99.0pt;width:112pt'>-b</td>
  <td class=xl66 width=159 style='width:119pt'>Broker 地址，表示 topic 所在
  Broker，只支持单台Broker，地址为ip:port</td>
 </tr>
 <tr height=76 style='height:57.0pt'>
  <td height=76 class=xl65 width=149 style='height:57.0pt;width:112pt'>-p</td>
  <td class=xl66 width=159 style='width:119pt'>指定新 topic 的读写权限( W=2|R=4|WR=6 )</td>
 </tr>
 <tr height=207 style='height:155.0pt'>
  <td height=207 class=xl65 width=149 style='height:155.0pt;width:112pt'>-c</td>
  <td class=xl66 width=159 style='width:119pt'>cluster 名称，表示 topic 所在集群（集群可通过
  clusterList 查询），-b优先，如果没有-b，则对集群中所有Broker执行命令</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=5 height=199 class=xl68 width=163 style='border-bottom:1.0pt;
  height:149.0pt;border-top:none;width:122pt'>updateOrderConf</td>
  <td rowspan=5 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>从NameServer上创建、删除、获取特定命名空间的kv配置，目前还未启用</td>
  <td class=xl65 width=149 style='width:112pt'>-h</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=149 style='height:17.0pt;width:112pt'>-t</td>
  <td class=xl66 width=159 style='width:119pt'>topic，键</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl65 width=149 style='height:29.0pt;width:112pt'>-v</td>
  <td class=xl66 width=159 style='width:119pt'>orderConf，值</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-m</td>
  <td class=xl66 width=159 style='width:119pt'>method，可选get、put、delete</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=4 height=198 class=xl68 width=163 style='border-bottom:1.0pt;
  height:140pt;border-top:none;width:122pt'>allocateMQ</td>
  <td rowspan=4 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>以平均负载算法计算消费者列表负载消息队列的负载结果</td>
  <td class=xl65 width=149 style='width:112pt'>-t</td>
  <td class=xl66 width=159 style='width:119pt'>topic 名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=149 style='height:17.0pt;width:112pt'>-h</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=95 style='height:71.0pt'>
  <td height=95 class=xl65 width=149 style='height:71.0pt;width:112pt'>-i</td>
  <td class=xl66 width=159 style='width:119pt'>ipList，用逗号分隔，计算这些ip去负载Topic的消息队列</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=4 height=142 class=xl68 width=163 style='border-bottom:1.0pt solid black;
  height:106.0pt;border-top:1.0pt;width:122pt'>statsAll</td>
  <td rowspan=4 class=xl70 width=135 style='border-bottom:1.0pt;
  border-top:none;width:101pt'>打印Topic订阅关系、TPS、积累量、24h读写总量等信息</td>
  <td class=xl65 width=149 style='width:112pt'>-h</td>
  <td class=xl66 width=159 style='width:119pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=149 style='height:43.0pt;width:112pt'>-n</td>
  <td class=xl66 width=159 style='width:119pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl65 width=149 style='height:29.0pt;width:112pt'>-a</td>
  <td class=xl66 width=159 style='width:119pt'>是否只打印活跃topic</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=149 style='height:17.0pt;width:112pt'>-t</td>
  <td class=xl66 width=159 style='width:119pt'>指定topic</td>
 </tr>
</table>

#### 2.2 集群相关

<table border=0 cellpadding=0 cellspacing=0 width=714>
 <col width=177>
 <col width=175>
 <col width=177>
 <col width=185>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl63 width=177 style='height:17.0pt;width:133pt'>名称</td>
  <td class=xl64 width=175 style='width:131pt'>含义</td>
  <td class=xl64 width=177 style='width:133pt'>命令选项</td>
  <td class=xl64 width=185 style='width:139pt'>说明</td>
 </tr>
 <tr height=207 style='height:155.0pt'>
  <td rowspan=4 height=326 class=xl67 width=177 style='border-bottom:1.0pt;
  height:244.0pt;border-top:none;width:133pt'><span
  style='mso-spacerun:yes'> </span>clusterList</td>
  <td rowspan=4 class=xl70 width=175 style='border-bottom:1.0pt;
  border-top:none;width:131pt'>查看集群信息，集群、BrokerName、BrokerId、TPS等信息</td>
  <td class=xl65 width=177 style='width:133pt'>-m</td>
  <td class=xl66 width=185 style='width:139pt'>打印更多信息 (增加打印出如下信息 #InTotalYest,
  #OutTotalYest, #InTotalToday ,#OutTotalToday)</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=177 style='height:17.0pt;width:133pt'>-h</td>
  <td class=xl66 width=185 style='width:139pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=177 style='height:43.0pt;width:133pt'>-n</td>
  <td class=xl66 width=185 style='width:139pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl65 width=177 style='height:29.0pt;width:133pt'>-i</td>
  <td class=xl66 width=185 style='width:139pt'>打印间隔，单位秒</td>
 </tr>
 <tr height=95 style='height:71.0pt'>
  <td rowspan=8 height=391 class=xl67 width=177 style='border-bottom:1.0pt;
  height:292.0pt;border-top:none;width:133pt'>clusterRT</td>
  <td rowspan=8 class=xl70 width=175 style='border-bottom:1.0pt;
  border-top:none;width:131pt'>发送消息检测集群各Broker RT。消息发往${BrokerName} Topic。</td>
  <td class=xl65 width=177 style='width:133pt'>-a</td>
  <td class=xl66 width=185 style='width:139pt'>amount，每次探测的总数，RT = 总时间 /
  amount</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl65 width=177 style='height:29.0pt;width:133pt'>-s</td>
  <td class=xl66 width=185 style='width:139pt'>消息大小，单位B</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=177 style='height:17.0pt;width:133pt'>-c</td>
  <td class=xl66 width=185 style='width:139pt'>探测哪个集群</td>
 </tr>
 <tr height=76 style='height:57.0pt'>
  <td height=76 class=xl65 width=177 style='height:57.0pt;width:133pt'>-p</td>
  <td class=xl66 width=185 style='width:139pt'>是否打印格式化日志，以|分割，默认不打印</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl65 width=177 style='height:17.0pt;width:133pt'>-h</td>
  <td class=xl66 width=185 style='width:139pt'>打印帮助</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl65 width=177 style='height:29.0pt;width:133pt'>-m</td>
  <td class=xl66 width=185 style='width:139pt'>所属机房，打印使用</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl65 width=177 style='height:29.0pt;width:133pt'>-i</td>
  <td class=xl66 width=185 style='width:139pt'>发送间隔，单位秒</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl65 width=177 style='height:43.0pt;width:133pt'>-n</td>
  <td class=xl66 width=185 style='width:139pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
</table>

#### 2.3 Broker相关

<table border=0 cellpadding=0 cellspacing=0 width=714>
 <col width=177>
 <col width=175>
 <col width=177>
 <col width=185>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl63 width=177 style='height:17.0pt;width:133pt'>名称</td>
  <td class=xl64 width=175 style='width:131pt'>含义</td>
  <td class=xl64 width=177 style='width:133pt'>命令选项</td>
  <td class=xl64 width=185 style='width:139pt'>说明</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=6 height=206 class=xl69 width=191 style='border-bottom:1.0pt;
  height:154.0pt;border-top:none;width:143pt'>updateBrokerConfig</td>
  <td rowspan=6 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>更新 Broker 配置文件，会修改Broker.conf</td>
  <td class=xl67 width=87 style='width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>Broker 地址，格式为ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>cluster 名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-k</td>
  <td class=xl68 width=87 style='width:65pt'>key 值</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-v</td>
  <td class=xl68 width=87 style='width:65pt'>value 值</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=3 height=137 class=xl69 width=191 style='border-bottom:1.0pt;
  height:103.0pt;border-top:none;width:143pt'>brokerStatus</td>
  <td rowspan=3 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>查看 Broker 统计信息、运行状态（你想要的信息几乎都在里面）</td>
  <td class=xl67 width=87 style='width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>Broker 地址，地址为ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=6 height=256 class=xl69 width=191 style='border-bottom:1.0pt;
  height:192.0pt;border-top:none;width:143pt'>brokerConsumeStats</td>
  <td rowspan=6 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>Broker中各个消费者的消费情况，按Message Queue维度返回Consume
  Offset，Broker Offset，Diff，TImestamp等信息</td>
  <td class=xl67 width=87 style='width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>Broker 地址，地址为ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>请求超时时间</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-l</td>
  <td class=xl68 width=87 style='width:65pt'>diff阈值，超过阈值才打印</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-o</td>
  <td class=xl68 width=87 style='width:65pt'>是否为顺序topic，一般为false</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=2 height=114 class=xl69 width=191 style='border-bottom:1.0pt;
  height:86.0pt;border-top:none;width:143pt'>getBrokerConfig</td>
  <td rowspan=2 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>获取Broker配置</td>
  <td class=xl67 width=87 style='width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>Broker 地址，地址为ip:port</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=3 height=137 class=xl69 width=191 style='border-bottom:1.0pt;
  height:103.0pt;border-top:none;width:143pt'>wipeWritePerm</td>
  <td rowspan=3 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>从NameServer上清除 Broker写权限</td>
  <td class=xl67 width=87 style='width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>BrokerName</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=4 height=160 class=xl69 width=191 style='border-bottom:1.0pt;
  height:120.0pt;border-top:none;width:143pt'>cleanExpiredCQ</td>
  <td rowspan=4 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>清理Broker上过期的Consume Queue，如果手动减少对列数可能产生过期队列</td>
  <td class=xl67 width=87 style='width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>Broker 地址，地址为ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>集群名称</td>
 </tr>
 <tr height=88 style='mso-height-source:userset;height:66.0pt'>
  <td rowspan=4 height=191 class=xl69 width=191 style='border-bottom:1.0pt;
  height:143.0pt;border-top:none;width:143pt'>cleanUnusedTopic</td>
  <td rowspan=4 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>清理Broker上不使用的Topic，从内存中释放Topic的Consume
  Queue，如果手动删除Topic会产生不使用的Topic</td>
  <td class=xl67 width=87 style='width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>Broker 地址，地址为ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>集群名称</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=5 height=199 class=xl69 width=191 style='border-bottom:1.0pt;
  height:149.0pt;border-top:none;width:143pt'>sendMsgStatus</td>
  <td rowspan=5 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>向Broker发消息，返回发送状态和RT</td>
  <td class=xl67 width=87 style='width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>BrokerName，注意不同于Broker地址</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>消息大小，单位B</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>发送次数</td>
 </tr>
</table>

#### 2.4 消息相关

<table border=0 cellpadding=0 cellspacing=0 width=714>
 <col width=177>
 <col width=175>
 <col width=177>
 <col width=185>
<tr height=23 style='height:17.0pt'>
  <td height=23 class=xl63 width=177 style='height:17.0pt;width:133pt'>名称</td>
  <td class=xl64 width=175 style='width:131pt'>含义</td>
  <td class=xl64 width=177 style='width:133pt'>命令选项</td>
  <td class=xl64 width=185 style='width:139pt'>说明</td>
 </tr>
 <tr height=128 style='height:96.0pt'>
  <td rowspan=3 height=208 class=xl69 width=87 style='border-bottom:1.0pt;
  height:156.0pt;border-top:none;width:65pt'>queryMsgById</td>
  <td rowspan=3 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>根据offsetMsgId查询msg，如果使用开源控制台，应使用offsetMsgId，此命令还有其他参数，具体作用请阅读QueryMsgByIdSubCommand。</td>
  <td class=xl67 width=87 style='width:65pt'>-i</td>
  <td class=xl67 width=87 style='width:65pt'>msgId</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=4 height=126 class=xl69 width=87 style='border-bottom:1.0pt;
  height:94.0pt;border-top:none;width:65pt'>queryMsgByKey</td>
  <td rowspan=4 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>根据消息 Key 查询消息</td>
  <td class=xl67 width=87 style='width:65pt'>-k</td>
  <td class=xl67 width=87 style='width:65pt'>msgKey</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>Topic 名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=225 style='height:169.0pt'>
  <td rowspan=6 height=390 class=xl69 width=87 style='border-bottom:1.0pt;
  height:292.0pt;border-top:none;width:65pt'>queryMsgByOffset</td>
  <td rowspan=6 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>根据 Offset 查询消息</td>
  <td class=xl67 width=87 style='width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>Broker 名称，（这里需要注意
  填写的是 Broker 的名称，不是 Broker 的地址，Broker 名称可以在 clusterList 查到）</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-i</td>
  <td class=xl68 width=87 style='width:65pt'>query 队列 id</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-o</td>
  <td class=xl68 width=87 style='width:65pt'>offset 值</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>topic 名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=47>
  <td rowspan=6 height=209 class=xl69 width=87 style='border-bottom:1.0pt;
  height:156.0pt;border-top:none;width:65pt'>queryMsgByUniqueKey</td>
  <td rowspan=6 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>根据msgId查询，msgId不同于offsetMsgId，区别详见常见运维问题。-g，-d配合使用，查到消息后尝试让特定的消费者消费消息并返回消费结果</td>
  <td class=xl67 width=87 style='width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-i</td>
  <td class=xl67 width=87 style='width:65pt'>uniqe msg id</td>
 </tr>
 <tr height=36 style='height:27.0pt'>
  <td height=36 class=xl67 width=87 style='height:27.0pt;width:65pt'>-g</td>
  <td class=xl67 width=87 style='width:65pt'>consumerGroup</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-d</td>
  <td class=xl67 width=87 style='width:65pt'>clientId</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>topic名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=5 height=149 class=xl69 width=87 style='border-bottom:1.0pt
  height:111.0pt;border-top:none;width:65pt'>checkMsgSendRT</td>
  <td rowspan=5 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>检测向topic发消息的RT，功能类似clusterRT</td>
  <td class=xl67 width=87 style='width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>topic名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-a</td>
  <td class=xl68 width=87 style='width:65pt'>探测次数</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>消息大小</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=8 height=218 class=xl69 width=87 style='border-bottom:1.0pt;
  height:162.0pt;border-top:none;width:65pt'>sendMessage</td>
  <td rowspan=8 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>发送一条消息，可以根据配置发往特定Message Queue，或普通发送。</td>
  <td class=xl67 width=87 style='width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>topic名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-p</td>
  <td class=xl68 width=87 style='width:65pt'>body，消息体</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-k</td>
  <td class=xl67 width=87 style='width:65pt'>keys</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-c</td>
  <td class=xl67 width=87 style='width:65pt'>tags</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-b</td>
  <td class=xl67 width=87 style='width:65pt'>BrokerName</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-i</td>
  <td class=xl67 width=87 style='width:65pt'>queueId</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=10 height=312 class=xl69 width=87 style='border-bottom:1.0pt;
  height:232.0pt;border-top:none;width:65pt'>consumeMessage</td>
  <td rowspan=10 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>消费消息。可以根据offset、开始&amp;结束时间戳、消息队列消费消息，配置不同执行不同消费逻辑，详见ConsumeMessageCommand。</td>
  <td class=xl67 width=87 style='width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>topic名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-b</td>
  <td class=xl67 width=87 style='width:65pt'>BrokerName</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-o</td>
  <td class=xl68 width=87 style='width:65pt'>从offset开始消费</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-i</td>
  <td class=xl67 width=87 style='width:65pt'>queueId</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-g</td>
  <td class=xl68 width=87 style='width:65pt'>消费者分组</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>开始时间戳，格式详见-h</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-d</td>
  <td class=xl68 width=87 style='width:65pt'>结束时间戳</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>消费多少条消息</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=8 height=282 class=xl69 width=87 style='border-bottom:1.0pt;
  height:210.0pt;border-top:none;width:65pt'>printMsg</td>
  <td rowspan=8 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>从Broker消费消息并打印，可选时间段</td>
  <td class=xl67 width=87 style='width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>topic名称</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>字符集，例如UTF-8</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>subExpress，过滤表达式</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>开始时间戳，格式参见-h</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-e</td>
  <td class=xl68 width=87 style='width:65pt'>结束时间戳</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-d</td>
  <td class=xl68 width=87 style='width:65pt'>是否打印消息体</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=12 height=390 class=xl69 width=87 style='border-bottom:1.0pt;
  height:290.0pt;border-top:none;width:65pt'>printMsgByQueue</td>
  <td rowspan=12 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>类似printMsg，但指定Message Queue</td>
  <td class=xl67 width=87 style='width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>topic名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-i</td>
  <td class=xl67 width=87 style='width:65pt'>queueId</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-a</td>
  <td class=xl67 width=87 style='width:65pt'>BrokerName</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>字符集，例如UTF-8</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>subExpress，过滤表达式</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>开始时间戳，格式参见-h</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-e</td>
  <td class=xl68 width=87 style='width:65pt'>结束时间戳</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-p</td>
  <td class=xl68 width=87 style='width:65pt'>是否打印消息</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-d</td>
  <td class=xl68 width=87 style='width:65pt'>是否打印消息体</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-f</td>
  <td class=xl68 width=87 style='width:65pt'>是否统计tag数量并打印</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=7 height=410 class=xl69 width=87 style='border-bottom:1.0pt;
  height:307.0pt;border-top:none;width:65pt'>resetOffsetByTime</td>
  <td rowspan=7 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>按时间戳重置offset，Broker和consumer都会重置</td>
  <td class=xl67 width=87 style='width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-g</td>
  <td class=xl68 width=87 style='width:65pt'>消费者分组</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>topic名称</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>重置为此时间戳对应的offset</td>
 </tr>
 <tr height=188 style='height:141.0pt'>
  <td height=188 class=xl67 width=87 style='height:141.0pt;width:65pt'>-f</td>
  <td class=xl68 width=87 style='width:65pt'>是否强制重置，如果false，只支持回溯offset，如果true，不管时间戳对应offset与consumeOffset关系</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>是否重置c++客户端offset</td>
 </tr>
</table>

#### 2.5 消费者、消费组相关

<table border=0 cellpadding=0 cellspacing=0 width=714>
 <col width=177>
 <col width=175>
 <col width=177>
 <col width=185>
<tr height=23 style='height:17.0pt'>
  <td height=23 class=xl63 width=177 style='height:17.0pt;width:133pt'>名称</td>
  <td class=xl64 width=175 style='width:131pt'>含义</td>
  <td class=xl64 width=177 style='width:133pt'>命令选项</td>
  <td class=xl64 width=185 style='width:139pt'>说明</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td rowspan=4 height=158 class=xl69 width=87 style='border-bottom:1.0pt;
  height:110pt;border-top:none;width:65pt'>consumerProgress</td>
  <td rowspan=4 class=xl72 width=87 style='border-bottom:1.0pt;
  border-top:none;width:65pt'>查看订阅组消费状态，可以查看具体的client IP的消息积累量</td>
  <td class=xl67 width=87 style='width:65pt'>-g</td>
  <td class=xl68 width=87 style='width:65pt'>消费者所属组名</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>是否打印client IP</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=105 style='mso-height-source:userset;height:79.0pt'>
  <td rowspan=5 height=260 class=xl69 width=87 style='border-bottom:1.0pt;
  height:195.0pt;border-top:none;width:65pt'>consumerStatus</td>
  <td rowspan=5 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>查看消费者状态，包括同一个分组中是否都是相同的订阅，分析Process
  Queue是否堆积，返回消费者jstack结果，内容较多，使用者参见ConsumerStatusSubCommand</td>
  <td class=xl67 width=87 style='width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=36 style='height:27.0pt'>
  <td height=36 class=xl67 width=87 style='height:27.0pt;width:65pt'>-g</td>
  <td class=xl67 width=87 style='width:65pt'>consumer group</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-i</td>
  <td class=xl67 width=87 style='width:65pt'>clientId</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>是否执行jstack</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=13 height=761 class=xl69 width=87 style='border-bottom:1.0pt
  height:569.0pt;border-top:none;width:65pt'>updateSubGroup</td>
  <td rowspan=13 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>更新或创建订阅关系</td>
  <td class=xl67 width=87 style='width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>Broker地址</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>集群名称</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-g</td>
  <td class=xl68 width=87 style='width:65pt'>消费者分组名称</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>分组是否允许消费</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-m</td>
  <td class=xl68 width=87 style='width:65pt'>是否从最小offset开始消费</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-d</td>
  <td class=xl68 width=87 style='width:65pt'>是否是广播模式</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-q</td>
  <td class=xl68 width=87 style='width:65pt'>重试队列数量</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-r</td>
  <td class=xl68 width=87 style='width:65pt'>最大重试次数</td>
 </tr>
 <tr height=207 style='height:155.0pt'>
  <td height=207 class=xl67 width=87 style='height:155.0pt;width:65pt'>-i</td>
  <td class=xl68 width=87 style='width:65pt'>当slaveReadEnable开启时有效，且还未达到从slave消费时建议从哪个BrokerId消费，可以配置备机id，主动从备机消费</td>
 </tr>
 <tr height=132 style='height:99.0pt'>
  <td height=132 class=xl67 width=87 style='height:99.0pt;width:65pt'>-w</td>
  <td class=xl68 width=87 style='width:65pt'>如果Broker建议从slave消费，配置决定从哪个slave消费，配置BrokerId，例如1</td>
 </tr>
 <tr height=76 style='height:57.0pt'>
  <td height=76 class=xl67 width=87 style='height:57.0pt;width:65pt'>-a</td>
  <td class=xl68 width=87 style='width:65pt'>当消费者数量变化时是否通知其他消费者负载均衡</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=5 height=165 class=xl69 width=87 style='border-bottom:1.0pt
  height:123.0pt;border-top:none;width:65pt'>deleteSubGroup</td>
  <td rowspan=5 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>从Broker删除订阅关系</td>
  <td class=xl67 width=87 style='width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-b</td>
  <td class=xl68 width=87 style='width:65pt'>Broker地址</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-c</td>
  <td class=xl68 width=87 style='width:65pt'>集群名称</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td height=39 class=xl67 width=87 style='height:29.0pt;width:65pt'>-g</td>
  <td class=xl68 width=87 style='width:65pt'>消费者分组名称</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=6 height=172 class=xl69 width=87 style='border-bottom:1.0pt
  height:120pt;border-top:none;width:65pt'>cloneGroupOffset</td>
  <td rowspan=6 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>在目标群组中使用源群组的offset</td>
  <td class=xl67 width=87 style='width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>源消费者组</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-d</td>
  <td class=xl68 width=87 style='width:65pt'>目标消费者组</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>topic名称</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-o</td>
  <td class=xl68 width=87 style='width:65pt'>暂未使用</td>
 </tr>
</table>

#### 2.6 连接相关

<table border=0 cellpadding=0 cellspacing=0 width=714>
 <col width=177>
 <col width=175>
 <col width=177>
 <col width=185>
<tr height=23 style='height:17.0pt'>
  <td height=23 class=xl63 width=177 style='height:17.0pt;width:133pt'>名称</td>
  <td class=xl64 width=175 style='width:131pt'>含义</td>
  <td class=xl64 width=177 style='width:133pt'>命令选项</td>
  <td class=xl64 width=185 style='width:139pt'>说明</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td rowspan=3 height=119 class=xl69 width=87 style='border-bottom:1.0pt
  height:89.0pt;border-top:none;width:65pt'>consumerConnection</td>
  <td rowspan=3 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>查询 Consumer 的网络连接</td>
  <td class=xl67 width=87 style='width:65pt'>-g</td>
  <td class=xl68 width=87 style='width:65pt'>消费者所属组名</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=39 style='height:29.0pt'>
  <td rowspan=4 height=142 class=xl69 width=87 style='border-bottom:1.0pt
  height:106.0pt;border-top:none;width:65pt'>producerConnection</td>
  <td rowspan=4 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>查询 Producer 的网络连接</td>
  <td class=xl67 width=87 style='width:65pt'>-g</td>
  <td class=xl68 width=87 style='width:65pt'>生产者所属组名</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-t</td>
  <td class=xl68 width=87 style='width:65pt'>主题名称</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
</table>

#### 2.7 NameServer相关

<table border=0 cellpadding=0 cellspacing=0 width=714>
 <col width=177>
 <col width=175>
 <col width=177>
 <col width=185>
<tr height=23 style='height:17.0pt'>
  <td height=23 class=xl63 width=177 style='height:17.0pt;width:133pt'>名称</td>
  <td class=xl64 width=175 style='width:131pt'>含义</td>
  <td class=xl64 width=177 style='width:133pt'>命令选项</td>
  <td class=xl64 width=185 style='width:139pt'>说明</td>
 </tr>
 <tr height=21 style='height:16.0pt'>
  <td rowspan=5 height=143 class=xl69 width=87 style='border-bottom:1.0pt
  height:100pt;border-top:none;width:65pt'>updateKvConfig</td>
  <td rowspan=5 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>更新NameServer的kv配置，目前还未使用</td>
  <td class=xl75 width=87 style='width:65pt'>-s</td>
  <td class=xl76 width=87 style='width:65pt'>命名空间</td>
 </tr>
 <tr height=21 style='height:16.0pt'>
  <td height=21 class=xl75 width=87 style='height:16.0pt;width:65pt'>-k</td>
  <td class=xl75 width=87 style='width:65pt'>key</td>
 </tr>
 <tr height=21 style='height:16.0pt'>
  <td height=21 class=xl75 width=87 style='height:16.0pt;width:65pt'>-v</td>
  <td class=xl75 width=87 style='width:65pt'>value</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td rowspan=4 height=126 class=xl69 width=87 style='border-bottom:1.0pt
  height:94.0pt;border-top:none;width:65pt'>deleteKvConfig</td>
  <td rowspan=4 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>删除NameServer的kv配置</td>
  <td class=xl67 width=87 style='width:65pt'>-s</td>
  <td class=xl68 width=87 style='width:65pt'>命名空间</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-k</td>
  <td class=xl67 width=87 style='width:65pt'>key</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td height=57 class=xl67 width=87 style='height:43.0pt;width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=2 height=80 class=xl69 width=87 style='border-bottom:1.0pt
  height:60.0pt;border-top:none;width:65pt'>getNamesrvConfig</td>
  <td rowspan=2 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>获取NameServer配置</td>
  <td class=xl67 width=87 style='width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=4 height=126 class=xl69 width=87 style='border-bottom:1.0pt
  height:94.0pt;border-top:none;width:65pt'>updateNamesrvConfig</td>
  <td rowspan=4 class=xl72 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>修改NameServer配置</td>
  <td class=xl67 width=87 style='width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-k</td>
  <td class=xl67 width=87 style='width:65pt'>key</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-v</td>
  <td class=xl67 width=87 style='width:65pt'>value</td>
 </tr>
</table>

#### 2.8 其他

<table border=0 cellpadding=0 cellspacing=0 width=714>
 <col width=177>
 <col width=175>
 <col width=177>
 <col width=185>
<tr height=23 style='height:17.0pt'>
  <td height=23 class=xl63 width=177 style='height:17.0pt;width:133pt'>名称</td>
  <td class=xl64 width=175 style='width:131pt'>含义</td>
  <td class=xl64 width=177 style='width:133pt'>命令选项</td>
  <td class=xl64 width=185 style='width:139pt'>说明</td>
 </tr>
 <tr height=57 style='height:43.0pt'>
  <td rowspan=2 height=80 class=xl69 width=87 style='border-bottom:1.0pt
  height:60.0pt;border-top:none;width:65pt'>startMonitoring</td>
  <td rowspan=2 class=xl71 width=87 style='border-bottom:1.0pt
  border-top:none;width:65pt'>开启监控进程，监控消息误删、重试队列消息数等</td>
  <td class=xl67 width=87 style='width:65pt'>-n</td>
  <td class=xl68 width=87 style='width:65pt'>NameServer 服务地址，格式 ip:port</td>
 </tr>
 <tr height=23 style='height:17.0pt'>
  <td height=23 class=xl67 width=87 style='height:17.0pt;width:65pt'>-h</td>
  <td class=xl68 width=87 style='width:65pt'>打印帮助</td>
 </tr>
</table>

### 3   运维常见问题

#### 3.1 RocketMQ的mqadmin命令报错问题

> 问题描述：有时候在部署完RocketMQ集群后，尝试执行“mqadmin”一些运维命令，会出现下面的异常信息：
>
>  ```java
>  org.apache.rocketmq.remoting.exception.RemotingConnectException: connect to <null> failed
>  ```

解决方法：可以在部署RocketMQ集群的虚拟机上执行`export NAMESRV_ADDR=ip:9876`
（ip指的是集群中部署NameServer组件的机器ip地址）命令之后再使用“mqadmin”的相关命令进行查询，即可得到结果。

#### 3.2 RocketMQ生产端和消费端版本不一致导致不能正常消费的问题

> 问题描述：同一个生产端发出消息，A消费端可消费，B消费端却无法消费，rocketMQ Console中出现：
>
> ```java
> Not found the consumer group consume stats, because return offset table is empty, maybe the consumer not consume any message的异常消息。
> ```

解决方案：RocketMQ 的jar包：rocketmq-client等包应该保持生产端，消费端使用相同的version。

#### 3.3  新增一个topic的消费组时，无法消费历史消息的问题

> 问题描述：当同一个topic的新增消费组启动时，消费的消息是当前的offset的消息，并未获取历史消息。

解决方案：rocketmq默认策略是从消息队列尾部，即跳过历史消息。如果想消费历史消息，则需要设置：`org.apache.rocketmq.client.consumer.DefaultMQPushConsumer#setConsumeFromWhere`
。常用的有以下三种配置：

- 默认配置,一个新的订阅组第一次启动从队列的最后位置开始消费，后续再启动接着上次消费的进度开始消费,即跳过历史消息；

```java
consumer.setConsumeFromWhere(ConsumeFromWhere.CONSUME_FROM_LAST_OFFSET);
```

- 一个新的订阅组第一次启动从队列的最前位置开始消费，后续再启动接着上次消费的进度开始消费,即消费Broker未过期的历史消息；

```java
consumer.setConsumeFromWhere(ConsumeFromWhere.CONSUME_FROM_FIRST_OFFSET);
```

- 一个新的订阅组第一次启动从指定时间点开始消费，后续再启动接着上次消费的进度开始消费，和consumer.setConsumeTimestamp()
  配合使用，默认是半个小时以前；

```java
consumer.setConsumeFromWhere(ConsumeFromWhere.CONSUME_FROM_TIMESTAMP);
```

#### 3.4 如何开启从Slave读数据功能

在某些情况下，Consumer需要将消费位点重置到1-2天前，这时在内存有限的Master
Broker上，CommitLog会承载比较重的IO压力，影响到该Broker的其它消息的读与写。可以开启`slaveReadEnable=true`，当Master
Broker发现Consumer的消费位点与CommitLog的最新值的差值的容量超过该机器内存的百分比（`accessMessageInMemoryMaxRatio=40%`
），会推荐Consumer从Slave Broker中去读取数据，降低Master Broker的IO。

#### 3.5 性能调优问题

异步刷盘建议使用自旋锁，同步刷盘建议使用重入锁，调整Broker配置项`useReentrantLockWhenPutMessage`
，默认为false；异步刷盘建议开启`TransientStorePoolEnable`
；建议关闭transferMsgByHeap，提高拉消息效率；同步刷盘建议适当增大`sendMessageThreadPoolNums`，具体配置需要经过压测。

#### 3.6 在RocketMQ中msgId和offsetMsgId的含义与区别

使用RocketMQ完成生产者客户端消息发送后，通常会看到如下日志打印信息：

```java
SendResult [sendStatus=SEND_OK, msgId=0A42333A0DC818B4AAC246C290FD0000, offsetMsgId=0A42333A00002A9F000000000134F1F5, messageQueue=MessageQueue [topic=topicTest1, BrokerName=mac.local, queueId=3], queueOffset=4]
```

- msgId，对于客户端来说msgId是由客户端producer实例端生成的，具体来说，调用方法`MessageClientIDSetter.createUniqIDBuffer()`
  生成唯一的Id；
-
offsetMsgId，offsetMsgId是由Broker服务端在写入消息时生成的（采用”IP地址+Port端口”与“CommitLog的物理偏移量地址”做了一个字符串拼接），其中offsetMsgId就是在RocketMQ控制台直接输入查询的那个messageId。

# 样例

-----

* [目录](#样例)
    * [1 基本样例](#1-基本样例)
        * [1.1 加入依赖：](#11-加入依赖)
        * [1.2 消息发送](#12-消息发送)
            * [1、Producer端发送同步消息](#1producer端发送同步消息)
            * [2、发送异步消息](#2发送异步消息)
            * [3、单向发送消息](#3单向发送消息)
        * [1.3 消费消息](#13-消费消息)
    * [2 顺序消息样例](#2-顺序消息样例)
        * [2.1 顺序消息生产](#21-顺序消息生产)
        * [2.2 顺序消费消息](#22-顺序消费消息)
    * [3 延时消息样例](#3-延时消息样例)
        * [3.1 启动消费者等待传入订阅消息](#31-启动消费者等待传入订阅消息)
        * [3.2 发送延时消息](#32-发送延时消息)
        * [3.3 验证](#33-验证)
        * [3.4 延时消息的使用场景](#34-延时消息的使用场景)
        * [3.5 延时消息的使用限制](#35-延时消息的使用限制)
    * [4 批量消息样例](#4-批量消息样例)
        * [4.1 发送批量消息](#41-发送批量消息)
        * [4.2 消息列表分割](#42-消息列表分割)
    * [5 过滤消息样例](#5-过滤消息样例)
        * [5.1 基本语法](#51-基本语法)
        * [5.2 使用样例](#52-使用样例)
            * [1、生产者样例](#1生产者样例)
            * [2、消费者样例](#2消费者样例)
    * [6 消息事务样例](#6-消息事务样例)
        * [6.1 发送事务消息样例](#61-发送事务消息样例)
            * [1、创建事务性生产者](#1创建事务性生产者)
            * [2、实现事务的监听接口](#2实现事务的监听接口)
        * [6.2 事务消息使用上的限制](#62-事务消息使用上的限制)
    * [7 Logappender样例](#7-logappender样例)
        * [7.1 log4j样例](#71-log4j样例)
        * [7.2 log4j2样例](#72-log4j2样例)
        * [7.3 logback样例](#73-logback样例)
    * [8 OpenMessaging样例](#8-openmessaging样例)
        * [8.1 OMSProducer样例](#81-omsproducer样例)
        * [8.2 OMSPullConsumer](#82-omspullconsumer)
        * [8.3 OMSPushConsumer](#83-omspushconsumer)

-----

## 1 基本样例

在基本样例中我们提供如下的功能场景：

* 使用RocketMQ发送三种类型的消息：同步消息、异步消息和单向消息。其中前两种消息是可靠的，因为会有发送是否成功的应答。
* 使用RocketMQ来消费接收到的消息。

### 1.1 加入依赖：

`maven:`

```
<dependency>
    <groupId>org.apache.rocketmq</groupId>
    <artifactId>rocketmq-client</artifactId>
    <version>4.3.0</version>
</dependency>
```

`gradle`

```
compile 'org.apache.rocketmq:rocketmq-client:4.3.0'
```

### 1.2 消息发送

#### 1、Producer端发送同步消息

这种可靠性同步地发送方式使用的比较广泛，比如：重要的消息通知，短信通知。

```java
public class SyncProducer {
	public static void main(String[] args) throws Exception {
    	// 实例化消息生产者Producer
        DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");
    	// 设置NameServer的地址
    	producer.setNamesrvAddr("localhost:9876");
    	// 启动Producer实例
        producer.start();
    	for (int i = 0; i < 100; i++) {
    	    // 创建消息，并指定Topic，Tag和消息体
    	    Message msg = new Message("TopicTest" /* Topic */,
        	"TagA" /* Tag */,
        	("Hello RocketMQ " + i).getBytes(RemotingHelper.DEFAULT_CHARSET) /* Message body */
        	);
        	// 发送消息到一个Broker
            SendResult sendResult = producer.send(msg);
            // 通过sendResult返回消息是否成功送达
            System.out.printf("%s%n", sendResult);
    	}
    	// 如果不再发送消息，关闭Producer实例。
    	producer.shutdown();
    }
}
```

#### 2、发送异步消息

异步消息通常用在对响应时间敏感的业务场景，即发送端不能容忍长时间地等待Broker的响应。

```java
public class AsyncProducer {
	public static void main(String[] args) throws Exception {
    	// 实例化消息生产者Producer
        DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");
    	// 设置NameServer的地址
        producer.setNamesrvAddr("localhost:9876");
    	// 启动Producer实例
        producer.start();
        producer.setRetryTimesWhenSendAsyncFailed(0);
	
	int messageCount = 100;
        // 根据消息数量实例化倒计时计算器
	final CountDownLatch2 countDownLatch = new CountDownLatch2(messageCount);
    	for (int i = 0; i < messageCount; i++) {
                final int index = i;
            	// 创建消息，并指定Topic，Tag和消息体
                Message msg = new Message("TopicTest",
                    "TagA",
                    "OrderID188",
                    "Hello world".getBytes(RemotingHelper.DEFAULT_CHARSET));
                // SendCallback接收异步返回结果的回调
                producer.send(msg, new SendCallback() {
                    @Override
                    public void onSuccess(SendResult sendResult) {
                        System.out.printf("%-10d OK %s %n", index,
                            sendResult.getMsgId());
                    }
                    @Override
                    public void onException(Throwable e) {
      	              System.out.printf("%-10d Exception %s %n", index, e);
      	              e.printStackTrace();
                    }
            	});
    	}
	// 等待5s
	countDownLatch.await(5, TimeUnit.SECONDS);
    	// 如果不再发送消息，关闭Producer实例。
    	producer.shutdown();
    }
}
```

#### 3、单向发送消息

这种方式主要用在不特别关心发送结果的场景，例如日志发送。

```java
public class OnewayProducer {
	public static void main(String[] args) throws Exception{
    	// 实例化消息生产者Producer
        DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");
    	// 设置NameServer的地址
        producer.setNamesrvAddr("localhost:9876");
    	// 启动Producer实例
        producer.start();
    	for (int i = 0; i < 100; i++) {
        	// 创建消息，并指定Topic，Tag和消息体
        	Message msg = new Message("TopicTest" /* Topic */,
                "TagA" /* Tag */,
                ("Hello RocketMQ " + i).getBytes(RemotingHelper.DEFAULT_CHARSET) /* Message body */
        	);
        	// 发送单向消息，没有任何返回结果
        	producer.sendOneway(msg);

    	}
    	// 如果不再发送消息，关闭Producer实例。
    	producer.shutdown();
    }
}
```

### 1.3 消费消息

```java
public class Consumer {

	public static void main(String[] args) throws InterruptedException, MQClientException {

    	// 实例化消费者
        DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("please_rename_unique_group_name");

    	// 设置NameServer的地址
        consumer.setNamesrvAddr("localhost:9876");

    	// 订阅一个或者多个Topic，以及Tag来过滤需要消费的消息
        consumer.subscribe("TopicTest", "*");
    	// 注册回调实现类来处理从broker拉取回来的消息
        consumer.registerMessageListener(new MessageListenerConcurrently() {
            @Override
            public ConsumeConcurrentlyStatus consumeMessage(List<MessageExt> msgs, ConsumeConcurrentlyContext context) {
                System.out.printf("%s Receive New Messages: %s %n", Thread.currentThread().getName(), msgs);
                // 标记该消息已经被成功消费
                return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
            }
        });
        // 启动消费者实例
        consumer.start();
        System.out.printf("Consumer Started.%n");
	}
}
```

2 顺序消息样例
----------

消息有序指的是可以按照消息的发送顺序来消费(FIFO)。RocketMQ可以严格的保证消息有序，可以分为分区有序或者全局有序。

顺序消费的原理解析，在默认的情况下消息发送会采取Round Robin轮询方式把消息发送到不同的queue(分区队列)
；而消费消息的时候从多个queue上拉取消息，这种情况发送和消费是不能保证顺序。但是如果控制发送的顺序消息只依次发送到同一个queue中，消费的时候只从这个queue上依次拉取，则就保证了顺序。当发送和消费参与的queue只有一个，则是全局有序；如果多个queue参与，则为分区有序，即相对每个queue，消息都是有序的。

下面用订单进行分区有序的示例。一个订单的顺序流程是：创建、付款、推送、完成。订单号相同的消息会被先后发送到同一个队列中，消费时，同一个OrderId获取到的肯定是同一个队列。

### 2.1 顺序消息生产

```java
package org.apache.rocketmq.example.order2;

import org.apache.rocketmq.client.producer.DefaultMQProducer;
import org.apache.rocketmq.client.producer.MessageQueueSelector;
import org.apache.rocketmq.client.producer.SendResult;
import org.apache.rocketmq.common.message.Message;
import org.apache.rocketmq.common.message.MessageQueue;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
* Producer，发送顺序消息
*/
public class Producer {

   public static void main(String[] args) throws Exception {
       DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");

       producer.setNamesrvAddr("127.0.0.1:9876");

       producer.start();

       String[] tags = new String[]{"TagA", "TagC", "TagD"};

       // 订单列表
       List<OrderStep> orderList = new Producer().buildOrders();

       Date date = new Date();
       SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
       String dateStr = sdf.format(date);
       for (int i = 0; i < 10; i++) {
           // 加个时间前缀
           String body = dateStr + " Hello RocketMQ " + orderList.get(i);
           Message msg = new Message("TopicTest", tags[i % tags.length], "KEY" + i, body.getBytes());

           SendResult sendResult = producer.send(msg, new MessageQueueSelector() {
               @Override
               public MessageQueue select(List<MessageQueue> mqs, Message msg, Object arg) {
                   Long id = (Long) arg;  //根据订单id选择发送queue
                   long index = id % mqs.size();
                   return mqs.get((int) index);
               }
           }, orderList.get(i).getOrderId());//订单id

           System.out.println(String.format("SendResult status:%s, queueId:%d, body:%s",
               sendResult.getSendStatus(),
               sendResult.getMessageQueue().getQueueId(),
               body));
       }

       producer.shutdown();
   }

   /**
    * 订单的步骤
    */
   private static class OrderStep {
       private long orderId;
       private String desc;

       public long getOrderId() {
           return orderId;
       }

       public void setOrderId(long orderId) {
           this.orderId = orderId;
       }

       public String getDesc() {
           return desc;
       }

       public void setDesc(String desc) {
           this.desc = desc;
       }

       @Override
       public String toString() {
           return "OrderStep{" +
               "orderId=" + orderId +
               ", desc='" + desc + '\'' +
               '}';
       }
   }

   /**
    * 生成模拟订单数据
    */
   private List<OrderStep> buildOrders() {
       List<OrderStep> orderList = new ArrayList<OrderStep>();

       OrderStep orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111039L);
       orderDemo.setDesc("创建");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111065L);
       orderDemo.setDesc("创建");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111039L);
       orderDemo.setDesc("付款");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103117235L);
       orderDemo.setDesc("创建");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111065L);
       orderDemo.setDesc("付款");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103117235L);
       orderDemo.setDesc("付款");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111065L);
       orderDemo.setDesc("完成");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111039L);
       orderDemo.setDesc("推送");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103117235L);
       orderDemo.setDesc("完成");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111039L);
       orderDemo.setDesc("完成");
       orderList.add(orderDemo);

       return orderList;
   }
}
```

### 2.2 顺序消费消息

```java
package org.apache.rocketmq.example.order2;

import org.apache.rocketmq.client.consumer.DefaultMQPushConsumer;
import org.apache.rocketmq.client.consumer.listener.ConsumeOrderlyContext;
import org.apache.rocketmq.client.consumer.listener.ConsumeOrderlyStatus;
import org.apache.rocketmq.client.consumer.listener.MessageListenerOrderly;
import org.apache.rocketmq.common.consumer.ConsumeFromWhere;
import org.apache.rocketmq.common.message.MessageExt;

import java.util.List;
import java.util.Random;
import java.util.concurrent.TimeUnit;

/**
* 顺序消息消费，带事务方式（应用可控制Offset什么时候提交）
*/
public class ConsumerInOrder {

   public static void main(String[] args) throws Exception {
       DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("please_rename_unique_group_name_3");
       consumer.setNamesrvAddr("127.0.0.1:9876");
       /**
        * 设置Consumer第一次启动是从队列头部开始消费还是队列尾部开始消费<br>
        * 如果非第一次启动，那么按照上次消费的位置继续消费
        */
       consumer.setConsumeFromWhere(ConsumeFromWhere.CONSUME_FROM_FIRST_OFFSET);

       consumer.subscribe("TopicTest", "TagA || TagC || TagD");

       consumer.registerMessageListener(new MessageListenerOrderly() {

           Random random = new Random();

           @Override
           public ConsumeOrderlyStatus consumeMessage(List<MessageExt> msgs, ConsumeOrderlyContext context) {
               context.setAutoCommit(true);
               for (MessageExt msg : msgs) {
                   // 可以看到每个queue有唯一的consume线程来消费, 订单对每个queue(分区)有序
                   System.out.println("consumeThread=" + Thread.currentThread().getName() + "queueId=" + msg.getQueueId() + ", content:" + new String(msg.getBody()));
               }

               try {
                   //模拟业务逻辑处理中...
                   TimeUnit.SECONDS.sleep(random.nextInt(10));
               } catch (Exception e) {
                   e.printStackTrace();
               }
               return ConsumeOrderlyStatus.SUCCESS;
           }
       });

       consumer.start();

       System.out.println("Consumer Started.");
   }
}
```

3 延时消息样例
----------

### 3.1 启动消费者等待传入订阅消息

```java
import org.apache.rocketmq.client.consumer.DefaultMQPushConsumer;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyContext;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyStatus;
import org.apache.rocketmq.client.consumer.listener.MessageListenerConcurrently;
import org.apache.rocketmq.common.message.MessageExt;
import java.util.List;

public class ScheduledMessageConsumer {
   public static void main(String[] args) throws Exception {
      // 实例化消费者
      DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("ExampleConsumer");
      // 订阅Topics
      consumer.subscribe("TestTopic", "*");
      // 注册消息监听者
      consumer.registerMessageListener(new MessageListenerConcurrently() {
          @Override
          public ConsumeConcurrentlyStatus consumeMessage(List<MessageExt> messages, ConsumeConcurrentlyContext context) {
              for (MessageExt message : messages) {
                  // Print approximate delay time period
                  System.out.println("Receive message[msgId=" + message.getMsgId() + "] " + (System.currentTimeMillis() - message.getStoreTimestamp()) + "ms later");
              }
              return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
          }
      });
      // 启动消费者
      consumer.start();
  }
}

```

### 3.2 发送延时消息

```java
import org.apache.rocketmq.client.producer.DefaultMQProducer;
import org.apache.rocketmq.common.message.Message;

public class ScheduledMessageProducer {
   public static void main(String[] args) throws Exception {
      // 实例化一个生产者来产生延时消息
      DefaultMQProducer producer = new DefaultMQProducer("ExampleProducerGroup");
      // 启动生产者
      producer.start();
      int totalMessagesToSend = 100;
      for (int i = 0; i < totalMessagesToSend; i++) {
          Message message = new Message("TestTopic", ("Hello scheduled message " + i).getBytes());
          // 设置延时等级3,这个消息将在10s之后发送(现在只支持固定的几个时间,详看delayTimeLevel)
          message.setDelayTimeLevel(3);
          // 发送消息
          producer.send(message);
      }
       // 关闭生产者
      producer.shutdown();
  }
}
```

### 3.3 验证

您将会看到消息的消费比存储时间晚10秒。

### 3.4 延时消息的使用场景

比如电商里，提交了一个订单就可以发送一个延时消息，1h后去检查这个订单的状态，如果还是未付款就取消订单释放库存。

### 3.5 延时消息的使用限制

```java
// org/apache/rocketmq/store/config/MessageStoreConfig.java

private String messageDelayLevel = "1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m 1h 2h";
```

现在RocketMq并不支持任意时间的延时，需要设置几个固定的延时等级，从1s到2h分别对应着等级1到18
消息消费失败会进入延时消息队列，消息发送时间与设置的延时等级和重试次数有关，详见代码`SendMessageProcessor.java`


4 批量消息样例
----------

批量发送消息能显著提高传递小消息的性能。限制是这些批量消息应该有相同的topic，相同的waitStoreMsgOK，而且不能是延时消息。此外，这一批消息的总大小不应超过4MB。

### 4.1 发送批量消息

如果您每次只发送不超过4MB的消息，则很容易使用批处理，样例如下：

```java
String topic = "BatchTest";
List<Message> messages = new ArrayList<>();
messages.add(new Message(topic, "TagA", "OrderID001", "Hello world 0".getBytes()));
messages.add(new Message(topic, "TagA", "OrderID002", "Hello world 1".getBytes()));
messages.add(new Message(topic, "TagA", "OrderID003", "Hello world 2".getBytes()));
try {
   producer.send(messages);
} catch (Exception e) {
   e.printStackTrace();
   //处理error
}

```

### 4.2 消息列表分割

复杂度只有当你发送大批量时才会增长，你可能不确定它是否超过了大小限制（4MB）。这时候你最好把你的消息列表分割一下：

```java
public class ListSplitter implements Iterator<List<Message>> { 
    private final int SIZE_LIMIT = 1024 * 1024 * 4;
    private final List<Message> messages;
    private int currIndex;
    public ListSplitter(List<Message> messages) { 
        this.messages = messages;
    }
    @Override public boolean hasNext() {
        return currIndex < messages.size(); 
    }
    @Override public List<Message> next() { 
        int startIndex = getStartIndex();
        int nextIndex = startIndex;
        int totalSize = 0;
        for (; nextIndex < messages.size(); nextIndex++) {
            Message message = messages.get(nextIndex); 
            int tmpSize = calcMessageSize(message);
            if (tmpSize + totalSize > SIZE_LIMIT) {
                break; 
            } else {
                totalSize += tmpSize; 
            }
        }
        List<Message> subList = messages.subList(startIndex, nextIndex); 
        currIndex = nextIndex;
        return subList;
    }
    private int getStartIndex() {
        Message currMessage = messages.get(currIndex); 
        int tmpSize = calcMessageSize(currMessage); 
        while(tmpSize > SIZE_LIMIT) {
            currIndex += 1;
            Message message = messages.get(curIndex); 
            tmpSize = calcMessageSize(message);
        }
        return currIndex; 
    }
    private int calcMessageSize(Message message) {
        int tmpSize = message.getTopic().length() + message.getBody().length(); 
        Map<String, String> properties = message.getProperties();
        for (Map.Entry<String, String> entry : properties.entrySet()) {
            tmpSize += entry.getKey().length() + entry.getValue().length(); 
        }
        tmpSize = tmpSize + 20; // 增加⽇日志的开销20字节
        return tmpSize; 
    }
}
//把大的消息分裂成若干个小的消息
ListSplitter splitter = new ListSplitter(messages);
while (splitter.hasNext()) {
  try {
      List<Message>  listItem = splitter.next();
      producer.send(listItem);
  } catch (Exception e) {
      e.printStackTrace();
      //处理error
  }
}
```

5 过滤消息样例
----------

在大多数情况下，TAG是一个简单而有用的设计，其可以来选择您想要的消息。例如：

```java
DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("CID_EXAMPLE");
consumer.subscribe("TOPIC", "TAGA || TAGB || TAGC");
```

消费者将接收包含TAGA或TAGB或TAGC的消息。但是限制是一个消息只能有一个标签，这对于复杂的场景可能不起作用。在这种情况下，可以使用SQL表达式筛选消息。SQL特性可以通过发送消息时的属性来进行计算。在RocketMQ定义的语法下，可以实现一些简单的逻辑。下面是一个例子：

```
------------
| message  |
|----------|  a > 5 AND b = 'abc'
| a = 10   |  --------------------> Gotten
| b = 'abc'|
| c = true |
------------
------------
| message  |
|----------|   a > 5 AND b = 'abc'
| a = 1    |  --------------------> Missed
| b = 'abc'|
| c = true |
------------
```

### 5.1 基本语法

RocketMQ只定义了一些基本语法来支持这个特性。你也可以很容易地扩展它。

- 数值比较，比如：**>，>=，<，<=，BETWEEN，=；**
- 字符比较，比如：**=，<>，IN；**
- **IS NULL** 或者 **IS NOT NULL；**
- 逻辑符号 **AND，OR，NOT；**

常量支持类型为：

- 数值，比如：**123，3.1415；**
- 字符，比如：**'abc'，必须用单引号包裹起来；**
- **NULL**，特殊的常量
- 布尔值，**TRUE** 或 **FALSE**

只有使用push模式的消费者才能用使用SQL92标准的sql语句，接口如下：

```
public void subscribe(finalString topic, final MessageSelector messageSelector)
```

### 5.2 使用样例

#### 1、生产者样例

发送消息时，你能通过`putUserProperty`来设置消息的属性

```java
DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");
producer.start();
Message msg = new Message("TopicTest",
   tag,
   ("Hello RocketMQ " + i).getBytes(RemotingHelper.DEFAULT_CHARSET)
);
// 设置一些属性
msg.putUserProperty("a", String.valueOf(i));
SendResult sendResult = producer.send(msg);

producer.shutdown();
```

#### 2、消费者样例

用MessageSelector.bySql来使用sql筛选消息

```java
DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("please_rename_unique_group_name_4");
// 只有订阅的消息有这个属性a, a >=0 and a <= 3
consumer.subscribe("TopicTest", MessageSelector.bySql("a between 0 and 3");
consumer.registerMessageListener(new MessageListenerConcurrently() {
   @Override
   public ConsumeConcurrentlyStatus consumeMessage(List<MessageExt> msgs, ConsumeConcurrentlyContext context) {
       return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
   }
});
consumer.start();

```

6 消息事务样例
----------

事务消息共有三种状态，提交状态、回滚状态、中间状态：

- TransactionStatus.CommitTransaction: 提交事务，它允许消费者消费此消息。
- TransactionStatus.RollbackTransaction: 回滚事务，它代表该消息将被删除，不允许被消费。
- TransactionStatus.Unknown: 中间状态，它代表需要检查消息队列来确定状态。

### 6.1 发送事务消息样例

#### 1、创建事务性生产者

使用 `TransactionMQProducer`类创建生产者，并指定唯一的 `ProducerGroup`
，就可以设置自定义线程池来处理这些检查请求。执行本地事务后、需要根据执行结果对消息队列进行回复。回传的事务状态在请参考前一节。

```java
import org.apache.rocketmq.client.consumer.DefaultMQPushConsumer;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyContext;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyStatus;
import org.apache.rocketmq.client.consumer.listener.MessageListenerConcurrently;
import org.apache.rocketmq.common.message.MessageExt;
import java.util.List;
public class TransactionProducer {
   public static void main(String[] args) throws MQClientException, InterruptedException {
       TransactionListener transactionListener = new TransactionListenerImpl();
       TransactionMQProducer producer = new TransactionMQProducer("please_rename_unique_group_name");
       ExecutorService executorService = new ThreadPoolExecutor(2, 5, 100, TimeUnit.SECONDS, new ArrayBlockingQueue<Runnable>(2000), new ThreadFactory() {
           @Override
           public Thread newThread(Runnable r) {
               Thread thread = new Thread(r);
               thread.setName("client-transaction-msg-check-thread");
               return thread;
           }
       });
       producer.setExecutorService(executorService);
       producer.setTransactionListener(transactionListener);
       producer.start();
       String[] tags = new String[] {"TagA", "TagB", "TagC", "TagD", "TagE"};
       for (int i = 0; i < 10; i++) {
           try {
               Message msg =
                   new Message("TopicTest1234", tags[i % tags.length], "KEY" + i,
                       ("Hello RocketMQ " + i).getBytes(RemotingHelper.DEFAULT_CHARSET));
               SendResult sendResult = producer.sendMessageInTransaction(msg, null);
               System.out.printf("%s%n", sendResult);
               Thread.sleep(10);
           } catch (MQClientException | UnsupportedEncodingException e) {
               e.printStackTrace();
           }
       }
       for (int i = 0; i < 100000; i++) {
           Thread.sleep(1000);
       }
       producer.shutdown();
   }
}

```

#### 2、实现事务的监听接口

当发送半消息成功时，我们使用 `executeLocalTransaction`
方法来执行本地事务。它返回前一节中提到的三个事务状态之一。`checkLocalTransaction`
方法用于检查本地事务状态，并回应消息队列的检查请求。它也是返回前一节中提到的三个事务状态之一。

```java
public class TransactionListenerImpl implements TransactionListener {
  private AtomicInteger transactionIndex = new AtomicInteger(0);
  private ConcurrentHashMap<String, Integer> localTrans = new ConcurrentHashMap<>();
  @Override
  public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
      int value = transactionIndex.getAndIncrement();
      int status = value % 3;
      localTrans.put(msg.getTransactionId(), status);
      return LocalTransactionState.UNKNOW;
  }
  @Override
  public LocalTransactionState checkLocalTransaction(MessageExt msg) {
      Integer status = localTrans.get(msg.getTransactionId());
      if (null != status) {
          switch (status) {
              case 0:
                  return LocalTransactionState.UNKNOW;
              case 1:
                  return LocalTransactionState.COMMIT_MESSAGE;
              case 2:
                  return LocalTransactionState.ROLLBACK_MESSAGE;
          }
      }
      return LocalTransactionState.COMMIT_MESSAGE;
  }
}

```

### 6.2 事务消息使用上的限制

1. 事务消息不支持延时消息和批量消息。
2. 为了避免单个消息被检查太多次而导致半队列消息累积，我们默认将单个消息的检查次数限制为 15 次，但是用户可以通过 Broker
   配置文件的 `transactionCheckMax`参数来修改此限制。如果已经检查某条消息超过 N 次的话（ N = `transactionCheckMax` ） 则
   Broker 将丢弃此消息，并在默认情况下同时打印错误日志。用户可以通过重写 `AbstractTransactionalMessageCheckListener`
   类来修改这个行为。
3. 事务消息将在 Broker 配置文件中的参数 transactionTimeout 这样的特定时间长度之后被检查。当发送事务消息时，用户还可以通过设置用户属性
   CHECK_IMMUNITY_TIME_IN_SECONDS 来改变这个限制，该参数优先于 `transactionTimeout` 参数。
4. 事务性消息可能不止一次被检查或消费。
5. 提交给用户的目标主题消息可能会失败，目前这依日志的记录而定。它的高可用性通过 RocketMQ
   本身的高可用性机制来保证，如果希望确保事务消息不丢失、并且事务完整性得到保证，建议使用同步的双重写入机制。
6. 事务消息的生产者 ID 不能与其他类型消息的生产者 ID 共享。与其他类型的消息不同，事务消息允许反向查询、MQ服务器能通过它们的生产者
   ID 查询到消费者。

7 Logappender样例
-----------------

RocketMQ日志提供log4j、log4j2和logback日志框架作为业务应用，下面是配置样例

### 7.1 log4j样例

按下面样例使用log4j属性配置

```
log4j.appender.mq=org.apache.rocketmq.logappender.log4j.RocketmqLog4jAppender
log4j.appender.mq.Tag=yourTag
log4j.appender.mq.Topic=yourLogTopic
log4j.appender.mq.ProducerGroup=yourLogGroup
log4j.appender.mq.NameServerAddress=yourRocketmqNameserverAddress
log4j.appender.mq.layout=org.apache.log4j.PatternLayout
log4j.appender.mq.layout.ConversionPattern=%d{yyyy-MM-dd HH:mm:ss} %-4r [%t] (%F:%L) %-5p - %m%n
```

按下面样例使用log4j xml配置来使用异步添加日志

```
<appender name="mqAppender1"class="org.apache.rocketmq.logappender.log4j.RocketmqLog4jAppender">
  <param name="Tag" value="yourTag" />
  <param name="Topic" value="yourLogTopic" />
  <param name="ProducerGroup" value="yourLogGroup" />
  <param name="NameServerAddress" value="yourRocketmqNameserverAddress"/>
  <layout class="org.apache.log4j.PatternLayout">
      <param name="ConversionPattern" value="%d{yyyy-MM-dd HH:mm:ss}-%p %t %c - %m%n" />
  </layout>
</appender>
<appender name="mqAsyncAppender1"class="org.apache.log4j.AsyncAppender">
  <param name="BufferSize" value="1024" />
  <param name="Blocking" value="false" />
  <appender-ref ref="mqAppender1"/>
</appender>
```

### 7.2 log4j2样例

用log4j2时，配置如下，如果想要非阻塞，只需要使用异步添加引用即可

```
<RocketMQ name="rocketmqAppender" producerGroup="yourLogGroup" nameServerAddress="yourRocketmqNameserverAddress"
   topic="yourLogTopic" tag="yourTag">
  <PatternLayout pattern="%d [%p] hahahah %c %m%n"/>
</RocketMQ>
```

### 7.3 logback样例

```
<appender name="mqAppender1"class="org.apache.rocketmq.logappender.logback.RocketmqLogbackAppender">
  <tag>yourTag</tag>
  <topic>yourLogTopic</topic>
  <producerGroup>yourLogGroup</producerGroup>
  <nameServerAddress>yourRocketmqNameserverAddress</nameServerAddress>
  <layout>
      <pattern>%date %p %t - %m%n</pattern>
  </layout>
</appender>
<appender name="mqAsyncAppender1"class="ch.qos.logback.classic.AsyncAppender">
  <queueSize>1024</queueSize>
  <discardingThreshold>80</discardingThreshold>
  <maxFlushTime>2000</maxFlushTime>
  <neverBlock>true</neverBlock>
  <appender-ref ref="mqAppender1"/>
</appender>
```

8 OpenMessaging样例
---------------

[OpenMessaging](https://www.google.com/url?q=http://openmessaging.cloud/&sa=D&ust=1546524111089000)
旨在建立消息和流处理规范，以为金融、电子商务、物联网和大数据领域提供通用框架及工业级指导方案。在分布式异构环境中，设计原则是面向云、简单、灵活和独立于语言。符合这些规范将帮助企业方便的开发跨平台和操作系统的异构消息传递应用程序。提供了openmessaging-api
0.3.0-alpha的部分实现，下面的示例演示如何基于OpenMessaging访问RocketMQ。

### 8.1 OMSProducer样例

下面的示例演示如何在同步、异步或单向传输中向RocketMQ代理发送消息。

```java
import io.openmessaging.Future;
import io.openmessaging.FutureListener;
import io.openmessaging.Message;
import io.openmessaging.MessagingAccessPoint;
import io.openmessaging.OMS;
import io.openmessaging.producer.Producer;
import io.openmessaging.producer.SendResult;
import java.nio.charset.Charset;
import java.util.concurrent.CountDownLatch;

public class SimpleProducer {
    public static void main(String[] args) {
       final MessagingAccessPoint messagingAccessPoint =
           OMS.getMessagingAccessPoint("oms:rocketmq://localhost:9876/default:default");
       final Producer producer = messagingAccessPoint.createProducer();
       messagingAccessPoint.startup();
       System.out.printf("MessagingAccessPoint startup OK%n");
       producer.startup();
       System.out.printf("Producer startup OK%n");
       {
           Message message = producer.createBytesMessage("OMS_HELLO_TOPIC", "OMS_HELLO_BODY".getBytes(Charset.forName("UTF-8")));
           SendResult sendResult = producer.send(message);
           //final Void aVoid = result.get(3000L);
           System.out.printf("Send async message OK, msgId: %s%n", sendResult.messageId());
       }
       final CountDownLatch countDownLatch = new CountDownLatch(1);
       {
           final Future<SendResult> result = producer.sendAsync(producer.createBytesMessage("OMS_HELLO_TOPIC", "OMS_HELLO_BODY".getBytes(Charset.forName("UTF-8"))));
           result.addListener(new FutureListener<SendResult>() {
               @Override
               public void operationComplete(Future<SendResult> future) {
                   if (future.getThrowable() != null) {
                       System.out.printf("Send async message Failed, error: %s%n", future.getThrowable().getMessage());
                   } else {
                       System.out.printf("Send async message OK, msgId: %s%n", future.get().messageId());
                   }
                   countDownLatch.countDown();
               }
           });
       }
       {
           producer.sendOneway(producer.createBytesMessage("OMS_HELLO_TOPIC", "OMS_HELLO_BODY".getBytes(Charset.forName("UTF-8"))));
           System.out.printf("Send oneway message OK%n");
       }
       try {
           countDownLatch.await();
           Thread.sleep(500); // 等一些时间来发送消息
       } catch (InterruptedException ignore) {
       }
       producer.shutdown();
   }
}
```

### 8.2 OMSPullConsumer

用OMS PullConsumer 来从指定的队列中拉取消息

```java
import io.openmessaging.Message;
import io.openmessaging.MessagingAccessPoint;
import io.openmessaging.OMS;
import io.openmessaging.OMSBuiltinKeys;
import io.openmessaging.consumer.PullConsumer;
import io.openmessaging.producer.Producer;
import io.openmessaging.producer.SendResult;

public class SimplePullConsumer {
    public static void main(String[] args) {
       final MessagingAccessPoint messagingAccessPoint =
           OMS.getMessagingAccessPoint("oms:rocketmq://localhost:9876/default:default");
       messagingAccessPoint.startup();
       final Producer producer = messagingAccessPoint.createProducer();
       final PullConsumer consumer = messagingAccessPoint.createPullConsumer(
           OMS.newKeyValue().put(OMSBuiltinKeys.CONSUMER_ID, "OMS_CONSUMER"));
       messagingAccessPoint.startup();
       System.out.printf("MessagingAccessPoint startup OK%n");
       final String queueName = "TopicTest";
       producer.startup();
       Message msg = producer.createBytesMessage(queueName, "Hello Open Messaging".getBytes());
       SendResult sendResult = producer.send(msg);
       System.out.printf("Send Message OK. MsgId: %s%n", sendResult.messageId());
       producer.shutdown();
       consumer.attachQueue(queueName);
       consumer.startup();
       System.out.printf("Consumer startup OK%n");
       // 运行直到发现一个消息被发送了
       boolean stop = false;
       while (!stop) {
           Message message = consumer.receive();
           if (message != null) {
               String msgId = message.sysHeaders().getString(Message.BuiltinKeys.MESSAGE_ID);
               System.out.printf("Received one message: %s%n", msgId);
               consumer.ack(msgId);
               if (!stop) {
                   stop = msgId.equalsIgnoreCase(sendResult.messageId());
               }
           } else {
               System.out.printf("Return without any message%n");
           }
       }
       consumer.shutdown();
       messagingAccessPoint.shutdown();
   }
}
```

### 8.3 OMSPushConsumer

以下示范如何将 OMS PushConsumer 添加到指定的队列，并通过 MessageListener 消费

# 样例

-----

* [目录](#样例)
    * [1 基本样例](#1-基本样例)
        * [1.1 加入依赖：](#11-加入依赖)
        * [1.2 消息发送](#12-消息发送)
            * [1、Producer端发送同步消息](#1producer端发送同步消息)
            * [2、发送异步消息](#2发送异步消息)
            * [3、单向发送消息](#3单向发送消息)
        * [1.3 消费消息](#13-消费消息)
    * [2 顺序消息样例](#2-顺序消息样例)
        * [2.1 顺序消息生产](#21-顺序消息生产)
        * [2.2 顺序消费消息](#22-顺序消费消息)
    * [3 延时消息样例](#3-延时消息样例)
        * [3.1 启动消费者等待传入订阅消息](#31-启动消费者等待传入订阅消息)
        * [3.2 发送延时消息](#32-发送延时消息)
        * [3.3 验证](#33-验证)
        * [3.4 延时消息的使用场景](#34-延时消息的使用场景)
        * [3.5 延时消息的使用限制](#35-延时消息的使用限制)
    * [4 批量消息样例](#4-批量消息样例)
        * [4.1 发送批量消息](#41-发送批量消息)
        * [4.2 消息列表分割](#42-消息列表分割)
    * [5 过滤消息样例](#5-过滤消息样例)
        * [5.1 基本语法](#51-基本语法)
        * [5.2 使用样例](#52-使用样例)
            * [1、生产者样例](#1生产者样例)
            * [2、消费者样例](#2消费者样例)
    * [6 消息事务样例](#6-消息事务样例)
        * [6.1 发送事务消息样例](#61-发送事务消息样例)
            * [1、创建事务性生产者](#1创建事务性生产者)
            * [2、实现事务的监听接口](#2实现事务的监听接口)
        * [6.2 事务消息使用上的限制](#62-事务消息使用上的限制)
    * [7 Logappender样例](#7-logappender样例)
        * [7.1 log4j样例](#71-log4j样例)
        * [7.2 log4j2样例](#72-log4j2样例)
        * [7.3 logback样例](#73-logback样例)
    * [8 OpenMessaging样例](#8-openmessaging样例)
        * [8.1 OMSProducer样例](#81-omsproducer样例)
        * [8.2 OMSPullConsumer](#82-omspullconsumer)
        * [8.3 OMSPushConsumer](#83-omspushconsumer)

-----

## 1 基本样例

在基本样例中我们提供如下的功能场景：

* 使用RocketMQ发送三种类型的消息：同步消息、异步消息和单向消息。其中前两种消息是可靠的，因为会有发送是否成功的应答。
* 使用RocketMQ来消费接收到的消息。

### 1.1 加入依赖：

`maven:`

```
<dependency>
    <groupId>org.apache.rocketmq</groupId>
    <artifactId>rocketmq-client</artifactId>
    <version>4.3.0</version>
</dependency>
```

`gradle`

```
compile 'org.apache.rocketmq:rocketmq-client:4.3.0'
```

### 1.2 消息发送

#### 1、Producer端发送同步消息

这种可靠性同步地发送方式使用的比较广泛，比如：重要的消息通知，短信通知。

```java
public class SyncProducer {
	public static void main(String[] args) throws Exception {
    	// 实例化消息生产者Producer
        DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");
    	// 设置NameServer的地址
    	producer.setNamesrvAddr("localhost:9876");
    	// 启动Producer实例
        producer.start();
    	for (int i = 0; i < 100; i++) {
    	    // 创建消息，并指定Topic，Tag和消息体
    	    Message msg = new Message("TopicTest" /* Topic */,
        	"TagA" /* Tag */,
        	("Hello RocketMQ " + i).getBytes(RemotingHelper.DEFAULT_CHARSET) /* Message body */
        	);
        	// 发送消息到一个Broker
            SendResult sendResult = producer.send(msg);
            // 通过sendResult返回消息是否成功送达
            System.out.printf("%s%n", sendResult);
    	}
    	// 如果不再发送消息，关闭Producer实例。
    	producer.shutdown();
    }
}
```

#### 2、发送异步消息

异步消息通常用在对响应时间敏感的业务场景，即发送端不能容忍长时间地等待Broker的响应。

```java
public class AsyncProducer {
	public static void main(String[] args) throws Exception {
    	// 实例化消息生产者Producer
        DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");
    	// 设置NameServer的地址
        producer.setNamesrvAddr("localhost:9876");
    	// 启动Producer实例
        producer.start();
        producer.setRetryTimesWhenSendAsyncFailed(0);
	
	int messageCount = 100;
        // 根据消息数量实例化倒计时计算器
	final CountDownLatch2 countDownLatch = new CountDownLatch2(messageCount);
    	for (int i = 0; i < messageCount; i++) {
                final int index = i;
            	// 创建消息，并指定Topic，Tag和消息体
                Message msg = new Message("TopicTest",
                    "TagA",
                    "OrderID188",
                    "Hello world".getBytes(RemotingHelper.DEFAULT_CHARSET));
                // SendCallback接收异步返回结果的回调
                producer.send(msg, new SendCallback() {
                    @Override
                    public void onSuccess(SendResult sendResult) {
                        System.out.printf("%-10d OK %s %n", index,
                            sendResult.getMsgId());
                    }
                    @Override
                    public void onException(Throwable e) {
      	              System.out.printf("%-10d Exception %s %n", index, e);
      	              e.printStackTrace();
                    }
            	});
    	}
	// 等待5s
	countDownLatch.await(5, TimeUnit.SECONDS);
    	// 如果不再发送消息，关闭Producer实例。
    	producer.shutdown();
    }
}
```

#### 3、单向发送消息

这种方式主要用在不特别关心发送结果的场景，例如日志发送。

```java
public class OnewayProducer {
	public static void main(String[] args) throws Exception{
    	// 实例化消息生产者Producer
        DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");
    	// 设置NameServer的地址
        producer.setNamesrvAddr("localhost:9876");
    	// 启动Producer实例
        producer.start();
    	for (int i = 0; i < 100; i++) {
        	// 创建消息，并指定Topic，Tag和消息体
        	Message msg = new Message("TopicTest" /* Topic */,
                "TagA" /* Tag */,
                ("Hello RocketMQ " + i).getBytes(RemotingHelper.DEFAULT_CHARSET) /* Message body */
        	);
        	// 发送单向消息，没有任何返回结果
        	producer.sendOneway(msg);

    	}
    	// 如果不再发送消息，关闭Producer实例。
    	producer.shutdown();
    }
}
```

### 1.3 消费消息

```java
public class Consumer {

	public static void main(String[] args) throws InterruptedException, MQClientException {

    	// 实例化消费者
        DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("please_rename_unique_group_name");

    	// 设置NameServer的地址
        consumer.setNamesrvAddr("localhost:9876");

    	// 订阅一个或者多个Topic，以及Tag来过滤需要消费的消息
        consumer.subscribe("TopicTest", "*");
    	// 注册回调实现类来处理从broker拉取回来的消息
        consumer.registerMessageListener(new MessageListenerConcurrently() {
            @Override
            public ConsumeConcurrentlyStatus consumeMessage(List<MessageExt> msgs, ConsumeConcurrentlyContext context) {
                System.out.printf("%s Receive New Messages: %s %n", Thread.currentThread().getName(), msgs);
                // 标记该消息已经被成功消费
                return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
            }
        });
        // 启动消费者实例
        consumer.start();
        System.out.printf("Consumer Started.%n");
	}
}
```

2 顺序消息样例
----------

消息有序指的是可以按照消息的发送顺序来消费(FIFO)。RocketMQ可以严格的保证消息有序，可以分为分区有序或者全局有序。

顺序消费的原理解析，在默认的情况下消息发送会采取Round Robin轮询方式把消息发送到不同的queue(分区队列)
；而消费消息的时候从多个queue上拉取消息，这种情况发送和消费是不能保证顺序。但是如果控制发送的顺序消息只依次发送到同一个queue中，消费的时候只从这个queue上依次拉取，则就保证了顺序。当发送和消费参与的queue只有一个，则是全局有序；如果多个queue参与，则为分区有序，即相对每个queue，消息都是有序的。

下面用订单进行分区有序的示例。一个订单的顺序流程是：创建、付款、推送、完成。订单号相同的消息会被先后发送到同一个队列中，消费时，同一个OrderId获取到的肯定是同一个队列。

### 2.1 顺序消息生产

```java
package org.apache.rocketmq.example.order2;

import org.apache.rocketmq.client.producer.DefaultMQProducer;
import org.apache.rocketmq.client.producer.MessageQueueSelector;
import org.apache.rocketmq.client.producer.SendResult;
import org.apache.rocketmq.common.message.Message;
import org.apache.rocketmq.common.message.MessageQueue;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
* Producer，发送顺序消息
*/
public class Producer {

   public static void main(String[] args) throws Exception {
       DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");

       producer.setNamesrvAddr("127.0.0.1:9876");

       producer.start();

       String[] tags = new String[]{"TagA", "TagC", "TagD"};

       // 订单列表
       List<OrderStep> orderList = new Producer().buildOrders();

       Date date = new Date();
       SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
       String dateStr = sdf.format(date);
       for (int i = 0; i < 10; i++) {
           // 加个时间前缀
           String body = dateStr + " Hello RocketMQ " + orderList.get(i);
           Message msg = new Message("TopicTest", tags[i % tags.length], "KEY" + i, body.getBytes());

           SendResult sendResult = producer.send(msg, new MessageQueueSelector() {
               @Override
               public MessageQueue select(List<MessageQueue> mqs, Message msg, Object arg) {
                   Long id = (Long) arg;  //根据订单id选择发送queue
                   long index = id % mqs.size();
                   return mqs.get((int) index);
               }
           }, orderList.get(i).getOrderId());//订单id

           System.out.println(String.format("SendResult status:%s, queueId:%d, body:%s",
               sendResult.getSendStatus(),
               sendResult.getMessageQueue().getQueueId(),
               body));
       }

       producer.shutdown();
   }

   /**
    * 订单的步骤
    */
   private static class OrderStep {
       private long orderId;
       private String desc;

       public long getOrderId() {
           return orderId;
       }

       public void setOrderId(long orderId) {
           this.orderId = orderId;
       }

       public String getDesc() {
           return desc;
       }

       public void setDesc(String desc) {
           this.desc = desc;
       }

       @Override
       public String toString() {
           return "OrderStep{" +
               "orderId=" + orderId +
               ", desc='" + desc + '\'' +
               '}';
       }
   }

   /**
    * 生成模拟订单数据
    */
   private List<OrderStep> buildOrders() {
       List<OrderStep> orderList = new ArrayList<OrderStep>();

       OrderStep orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111039L);
       orderDemo.setDesc("创建");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111065L);
       orderDemo.setDesc("创建");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111039L);
       orderDemo.setDesc("付款");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103117235L);
       orderDemo.setDesc("创建");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111065L);
       orderDemo.setDesc("付款");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103117235L);
       orderDemo.setDesc("付款");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111065L);
       orderDemo.setDesc("完成");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111039L);
       orderDemo.setDesc("推送");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103117235L);
       orderDemo.setDesc("完成");
       orderList.add(orderDemo);

       orderDemo = new OrderStep();
       orderDemo.setOrderId(15103111039L);
       orderDemo.setDesc("完成");
       orderList.add(orderDemo);

       return orderList;
   }
}
```

### 2.2 顺序消费消息

```java
package org.apache.rocketmq.example.order2;

import org.apache.rocketmq.client.consumer.DefaultMQPushConsumer;
import org.apache.rocketmq.client.consumer.listener.ConsumeOrderlyContext;
import org.apache.rocketmq.client.consumer.listener.ConsumeOrderlyStatus;
import org.apache.rocketmq.client.consumer.listener.MessageListenerOrderly;
import org.apache.rocketmq.common.consumer.ConsumeFromWhere;
import org.apache.rocketmq.common.message.MessageExt;

import java.util.List;
import java.util.Random;
import java.util.concurrent.TimeUnit;

/**
* 顺序消息消费，带事务方式（应用可控制Offset什么时候提交）
*/
public class ConsumerInOrder {

   public static void main(String[] args) throws Exception {
       DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("please_rename_unique_group_name_3");
       consumer.setNamesrvAddr("127.0.0.1:9876");
       /**
        * 设置Consumer第一次启动是从队列头部开始消费还是队列尾部开始消费<br>
        * 如果非第一次启动，那么按照上次消费的位置继续消费
        */
       consumer.setConsumeFromWhere(ConsumeFromWhere.CONSUME_FROM_FIRST_OFFSET);

       consumer.subscribe("TopicTest", "TagA || TagC || TagD");

       consumer.registerMessageListener(new MessageListenerOrderly() {

           Random random = new Random();

           @Override
           public ConsumeOrderlyStatus consumeMessage(List<MessageExt> msgs, ConsumeOrderlyContext context) {
               context.setAutoCommit(true);
               for (MessageExt msg : msgs) {
                   // 可以看到每个queue有唯一的consume线程来消费, 订单对每个queue(分区)有序
                   System.out.println("consumeThread=" + Thread.currentThread().getName() + "queueId=" + msg.getQueueId() + ", content:" + new String(msg.getBody()));
               }

               try {
                   //模拟业务逻辑处理中...
                   TimeUnit.SECONDS.sleep(random.nextInt(10));
               } catch (Exception e) {
                   e.printStackTrace();
               }
               return ConsumeOrderlyStatus.SUCCESS;
           }
       });

       consumer.start();

       System.out.println("Consumer Started.");
   }
}
```

3 延时消息样例
----------

### 3.1 启动消费者等待传入订阅消息

```java
import org.apache.rocketmq.client.consumer.DefaultMQPushConsumer;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyContext;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyStatus;
import org.apache.rocketmq.client.consumer.listener.MessageListenerConcurrently;
import org.apache.rocketmq.common.message.MessageExt;
import java.util.List;

public class ScheduledMessageConsumer {
   public static void main(String[] args) throws Exception {
      // 实例化消费者
      DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("ExampleConsumer");
      // 订阅Topics
      consumer.subscribe("TestTopic", "*");
      // 注册消息监听者
      consumer.registerMessageListener(new MessageListenerConcurrently() {
          @Override
          public ConsumeConcurrentlyStatus consumeMessage(List<MessageExt> messages, ConsumeConcurrentlyContext context) {
              for (MessageExt message : messages) {
                  // Print approximate delay time period
                  System.out.println("Receive message[msgId=" + message.getMsgId() + "] " + (System.currentTimeMillis() - message.getStoreTimestamp()) + "ms later");
              }
              return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
          }
      });
      // 启动消费者
      consumer.start();
  }
}

```

### 3.2 发送延时消息

```java
import org.apache.rocketmq.client.producer.DefaultMQProducer;
import org.apache.rocketmq.common.message.Message;

public class ScheduledMessageProducer {
   public static void main(String[] args) throws Exception {
      // 实例化一个生产者来产生延时消息
      DefaultMQProducer producer = new DefaultMQProducer("ExampleProducerGroup");
      // 启动生产者
      producer.start();
      int totalMessagesToSend = 100;
      for (int i = 0; i < totalMessagesToSend; i++) {
          Message message = new Message("TestTopic", ("Hello scheduled message " + i).getBytes());
          // 设置延时等级3,这个消息将在10s之后发送(现在只支持固定的几个时间,详看delayTimeLevel)
          message.setDelayTimeLevel(3);
          // 发送消息
          producer.send(message);
      }
       // 关闭生产者
      producer.shutdown();
  }
}
```

### 3.3 验证

您将会看到消息的消费比存储时间晚10秒。

### 3.4 延时消息的使用场景

比如电商里，提交了一个订单就可以发送一个延时消息，1h后去检查这个订单的状态，如果还是未付款就取消订单释放库存。

### 3.5 延时消息的使用限制

```java
// org/apache/rocketmq/store/config/MessageStoreConfig.java

private String messageDelayLevel = "1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m 1h 2h";
```

现在RocketMq并不支持任意时间的延时，需要设置几个固定的延时等级，从1s到2h分别对应着等级1到18
消息消费失败会进入延时消息队列，消息发送时间与设置的延时等级和重试次数有关，详见代码`SendMessageProcessor.java`


4 批量消息样例
----------

批量发送消息能显著提高传递小消息的性能。限制是这些批量消息应该有相同的topic，相同的waitStoreMsgOK，而且不能是延时消息。此外，这一批消息的总大小不应超过4MB。

### 4.1 发送批量消息

如果您每次只发送不超过4MB的消息，则很容易使用批处理，样例如下：

```java
String topic = "BatchTest";
List<Message> messages = new ArrayList<>();
messages.add(new Message(topic, "TagA", "OrderID001", "Hello world 0".getBytes()));
messages.add(new Message(topic, "TagA", "OrderID002", "Hello world 1".getBytes()));
messages.add(new Message(topic, "TagA", "OrderID003", "Hello world 2".getBytes()));
try {
   producer.send(messages);
} catch (Exception e) {
   e.printStackTrace();
   //处理error
}

```

### 4.2 消息列表分割

复杂度只有当你发送大批量时才会增长，你可能不确定它是否超过了大小限制（4MB）。这时候你最好把你的消息列表分割一下：

```java
public class ListSplitter implements Iterator<List<Message>> { 
    private final int SIZE_LIMIT = 1024 * 1024 * 4;
    private final List<Message> messages;
    private int currIndex;
    public ListSplitter(List<Message> messages) { 
        this.messages = messages;
    }
    @Override public boolean hasNext() {
        return currIndex < messages.size(); 
    }
    @Override public List<Message> next() { 
        int startIndex = getStartIndex();
        int nextIndex = startIndex;
        int totalSize = 0;
        for (; nextIndex < messages.size(); nextIndex++) {
            Message message = messages.get(nextIndex); 
            int tmpSize = calcMessageSize(message);
            if (tmpSize + totalSize > SIZE_LIMIT) {
                break; 
            } else {
                totalSize += tmpSize; 
            }
        }
        List<Message> subList = messages.subList(startIndex, nextIndex); 
        currIndex = nextIndex;
        return subList;
    }
    private int getStartIndex() {
        Message currMessage = messages.get(currIndex); 
        int tmpSize = calcMessageSize(currMessage); 
        while(tmpSize > SIZE_LIMIT) {
            currIndex += 1;
            Message message = messages.get(curIndex); 
            tmpSize = calcMessageSize(message);
        }
        return currIndex; 
    }
    private int calcMessageSize(Message message) {
        int tmpSize = message.getTopic().length() + message.getBody().length(); 
        Map<String, String> properties = message.getProperties();
        for (Map.Entry<String, String> entry : properties.entrySet()) {
            tmpSize += entry.getKey().length() + entry.getValue().length(); 
        }
        tmpSize = tmpSize + 20; // 增加⽇日志的开销20字节
        return tmpSize; 
    }
}
//把大的消息分裂成若干个小的消息
ListSplitter splitter = new ListSplitter(messages);
while (splitter.hasNext()) {
  try {
      List<Message>  listItem = splitter.next();
      producer.send(listItem);
  } catch (Exception e) {
      e.printStackTrace();
      //处理error
  }
}
```

5 过滤消息样例
----------

在大多数情况下，TAG是一个简单而有用的设计，其可以来选择您想要的消息。例如：

```java
DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("CID_EXAMPLE");
consumer.subscribe("TOPIC", "TAGA || TAGB || TAGC");
```

消费者将接收包含TAGA或TAGB或TAGC的消息。但是限制是一个消息只能有一个标签，这对于复杂的场景可能不起作用。在这种情况下，可以使用SQL表达式筛选消息。SQL特性可以通过发送消息时的属性来进行计算。在RocketMQ定义的语法下，可以实现一些简单的逻辑。下面是一个例子：

```
------------
| message  |
|----------|  a > 5 AND b = 'abc'
| a = 10   |  --------------------> Gotten
| b = 'abc'|
| c = true |
------------
------------
| message  |
|----------|   a > 5 AND b = 'abc'
| a = 1    |  --------------------> Missed
| b = 'abc'|
| c = true |
------------
```

### 5.1 基本语法

RocketMQ只定义了一些基本语法来支持这个特性。你也可以很容易地扩展它。

- 数值比较，比如：**>，>=，<，<=，BETWEEN，=；**
- 字符比较，比如：**=，<>，IN；**
- **IS NULL** 或者 **IS NOT NULL；**
- 逻辑符号 **AND，OR，NOT；**

常量支持类型为：

- 数值，比如：**123，3.1415；**
- 字符，比如：**'abc'，必须用单引号包裹起来；**
- **NULL**，特殊的常量
- 布尔值，**TRUE** 或 **FALSE**

只有使用push模式的消费者才能用使用SQL92标准的sql语句，接口如下：

```
public void subscribe(finalString topic, final MessageSelector messageSelector)
```

### 5.2 使用样例

#### 1、生产者样例

发送消息时，你能通过`putUserProperty`来设置消息的属性

```java
DefaultMQProducer producer = new DefaultMQProducer("please_rename_unique_group_name");
producer.start();
Message msg = new Message("TopicTest",
   tag,
   ("Hello RocketMQ " + i).getBytes(RemotingHelper.DEFAULT_CHARSET)
);
// 设置一些属性
msg.putUserProperty("a", String.valueOf(i));
SendResult sendResult = producer.send(msg);

producer.shutdown();
```

#### 2、消费者样例

用MessageSelector.bySql来使用sql筛选消息

```java
DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("please_rename_unique_group_name_4");
// 只有订阅的消息有这个属性a, a >=0 and a <= 3
consumer.subscribe("TopicTest", MessageSelector.bySql("a between 0 and 3");
consumer.registerMessageListener(new MessageListenerConcurrently() {
   @Override
   public ConsumeConcurrentlyStatus consumeMessage(List<MessageExt> msgs, ConsumeConcurrentlyContext context) {
       return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
   }
});
consumer.start();

```

6 消息事务样例
----------

事务消息共有三种状态，提交状态、回滚状态、中间状态：

- TransactionStatus.CommitTransaction: 提交事务，它允许消费者消费此消息。
- TransactionStatus.RollbackTransaction: 回滚事务，它代表该消息将被删除，不允许被消费。
- TransactionStatus.Unknown: 中间状态，它代表需要检查消息队列来确定状态。

### 6.1 发送事务消息样例

#### 1、创建事务性生产者

使用 `TransactionMQProducer`类创建生产者，并指定唯一的 `ProducerGroup`
，就可以设置自定义线程池来处理这些检查请求。执行本地事务后、需要根据执行结果对消息队列进行回复。回传的事务状态在请参考前一节。

```java
import org.apache.rocketmq.client.consumer.DefaultMQPushConsumer;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyContext;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyStatus;
import org.apache.rocketmq.client.consumer.listener.MessageListenerConcurrently;
import org.apache.rocketmq.common.message.MessageExt;
import java.util.List;
public class TransactionProducer {
   public static void main(String[] args) throws MQClientException, InterruptedException {
       TransactionListener transactionListener = new TransactionListenerImpl();
       TransactionMQProducer producer = new TransactionMQProducer("please_rename_unique_group_name");
       ExecutorService executorService = new ThreadPoolExecutor(2, 5, 100, TimeUnit.SECONDS, new ArrayBlockingQueue<Runnable>(2000), new ThreadFactory() {
           @Override
           public Thread newThread(Runnable r) {
               Thread thread = new Thread(r);
               thread.setName("client-transaction-msg-check-thread");
               return thread;
           }
       });
       producer.setExecutorService(executorService);
       producer.setTransactionListener(transactionListener);
       producer.start();
       String[] tags = new String[] {"TagA", "TagB", "TagC", "TagD", "TagE"};
       for (int i = 0; i < 10; i++) {
           try {
               Message msg =
                   new Message("TopicTest1234", tags[i % tags.length], "KEY" + i,
                       ("Hello RocketMQ " + i).getBytes(RemotingHelper.DEFAULT_CHARSET));
               SendResult sendResult = producer.sendMessageInTransaction(msg, null);
               System.out.printf("%s%n", sendResult);
               Thread.sleep(10);
           } catch (MQClientException | UnsupportedEncodingException e) {
               e.printStackTrace();
           }
       }
       for (int i = 0; i < 100000; i++) {
           Thread.sleep(1000);
       }
       producer.shutdown();
   }
}

```

#### 2、实现事务的监听接口

当发送半消息成功时，我们使用 `executeLocalTransaction`
方法来执行本地事务。它返回前一节中提到的三个事务状态之一。`checkLocalTransaction`
方法用于检查本地事务状态，并回应消息队列的检查请求。它也是返回前一节中提到的三个事务状态之一。

```java
public class TransactionListenerImpl implements TransactionListener {
  private AtomicInteger transactionIndex = new AtomicInteger(0);
  private ConcurrentHashMap<String, Integer> localTrans = new ConcurrentHashMap<>();
  @Override
  public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
      int value = transactionIndex.getAndIncrement();
      int status = value % 3;
      localTrans.put(msg.getTransactionId(), status);
      return LocalTransactionState.UNKNOW;
  }
  @Override
  public LocalTransactionState checkLocalTransaction(MessageExt msg) {
      Integer status = localTrans.get(msg.getTransactionId());
      if (null != status) {
          switch (status) {
              case 0:
                  return LocalTransactionState.UNKNOW;
              case 1:
                  return LocalTransactionState.COMMIT_MESSAGE;
              case 2:
                  return LocalTransactionState.ROLLBACK_MESSAGE;
          }
      }
      return LocalTransactionState.COMMIT_MESSAGE;
  }
}

```

### 6.2 事务消息使用上的限制

1. 事务消息不支持延时消息和批量消息。
2. 为了避免单个消息被检查太多次而导致半队列消息累积，我们默认将单个消息的检查次数限制为 15 次，但是用户可以通过 Broker
   配置文件的 `transactionCheckMax`参数来修改此限制。如果已经检查某条消息超过 N 次的话（ N = `transactionCheckMax` ） 则
   Broker 将丢弃此消息，并在默认情况下同时打印错误日志。用户可以通过重写 `AbstractTransactionalMessageCheckListener`
   类来修改这个行为。
3. 事务消息将在 Broker 配置文件中的参数 transactionTimeout 这样的特定时间长度之后被检查。当发送事务消息时，用户还可以通过设置用户属性
   CHECK_IMMUNITY_TIME_IN_SECONDS 来改变这个限制，该参数优先于 `transactionTimeout` 参数。
4. 事务性消息可能不止一次被检查或消费。
5. 提交给用户的目标主题消息可能会失败，目前这依日志的记录而定。它的高可用性通过 RocketMQ
   本身的高可用性机制来保证，如果希望确保事务消息不丢失、并且事务完整性得到保证，建议使用同步的双重写入机制。
6. 事务消息的生产者 ID 不能与其他类型消息的生产者 ID 共享。与其他类型的消息不同，事务消息允许反向查询、MQ服务器能通过它们的生产者
   ID 查询到消费者。

7 Logappender样例
-----------------

RocketMQ日志提供log4j、log4j2和logback日志框架作为业务应用，下面是配置样例

### 7.1 log4j样例

按下面样例使用log4j属性配置

```
log4j.appender.mq=org.apache.rocketmq.logappender.log4j.RocketmqLog4jAppender
log4j.appender.mq.Tag=yourTag
log4j.appender.mq.Topic=yourLogTopic
log4j.appender.mq.ProducerGroup=yourLogGroup
log4j.appender.mq.NameServerAddress=yourRocketmqNameserverAddress
log4j.appender.mq.layout=org.apache.log4j.PatternLayout
log4j.appender.mq.layout.ConversionPattern=%d{yyyy-MM-dd HH:mm:ss} %-4r [%t] (%F:%L) %-5p - %m%n
```

按下面样例使用log4j xml配置来使用异步添加日志

```
<appender name="mqAppender1"class="org.apache.rocketmq.logappender.log4j.RocketmqLog4jAppender">
  <param name="Tag" value="yourTag" />
  <param name="Topic" value="yourLogTopic" />
  <param name="ProducerGroup" value="yourLogGroup" />
  <param name="NameServerAddress" value="yourRocketmqNameserverAddress"/>
  <layout class="org.apache.log4j.PatternLayout">
      <param name="ConversionPattern" value="%d{yyyy-MM-dd HH:mm:ss}-%p %t %c - %m%n" />
  </layout>
</appender>
<appender name="mqAsyncAppender1"class="org.apache.log4j.AsyncAppender">
  <param name="BufferSize" value="1024" />
  <param name="Blocking" value="false" />
  <appender-ref ref="mqAppender1"/>
</appender>
```

### 7.2 log4j2样例

用log4j2时，配置如下，如果想要非阻塞，只需要使用异步添加引用即可

```
<RocketMQ name="rocketmqAppender" producerGroup="yourLogGroup" nameServerAddress="yourRocketmqNameserverAddress"
   topic="yourLogTopic" tag="yourTag">
  <PatternLayout pattern="%d [%p] hahahah %c %m%n"/>
</RocketMQ>
```

### 7.3 logback样例

```
<appender name="mqAppender1"class="org.apache.rocketmq.logappender.logback.RocketmqLogbackAppender">
  <tag>yourTag</tag>
  <topic>yourLogTopic</topic>
  <producerGroup>yourLogGroup</producerGroup>
  <nameServerAddress>yourRocketmqNameserverAddress</nameServerAddress>
  <layout>
      <pattern>%date %p %t - %m%n</pattern>
  </layout>
</appender>
<appender name="mqAsyncAppender1"class="ch.qos.logback.classic.AsyncAppender">
  <queueSize>1024</queueSize>
  <discardingThreshold>80</discardingThreshold>
  <maxFlushTime>2000</maxFlushTime>
  <neverBlock>true</neverBlock>
  <appender-ref ref="mqAppender1"/>
</appender>
```

8 OpenMessaging样例
---------------

[OpenMessaging](https://www.google.com/url?q=http://openmessaging.cloud/&sa=D&ust=1546524111089000)
旨在建立消息和流处理规范，以为金融、电子商务、物联网和大数据领域提供通用框架及工业级指导方案。在分布式异构环境中，设计原则是面向云、简单、灵活和独立于语言。符合这些规范将帮助企业方便的开发跨平台和操作系统的异构消息传递应用程序。提供了openmessaging-api
0.3.0-alpha的部分实现，下面的示例演示如何基于OpenMessaging访问RocketMQ。

### 8.1 OMSProducer样例

下面的示例演示如何在同步、异步或单向传输中向RocketMQ代理发送消息。

```java
import io.openmessaging.Future;
import io.openmessaging.FutureListener;
import io.openmessaging.Message;
import io.openmessaging.MessagingAccessPoint;
import io.openmessaging.OMS;
import io.openmessaging.producer.Producer;
import io.openmessaging.producer.SendResult;
import java.nio.charset.Charset;
import java.util.concurrent.CountDownLatch;

public class SimpleProducer {
    public static void main(String[] args) {
       final MessagingAccessPoint messagingAccessPoint =
           OMS.getMessagingAccessPoint("oms:rocketmq://localhost:9876/default:default");
       final Producer producer = messagingAccessPoint.createProducer();
       messagingAccessPoint.startup();
       System.out.printf("MessagingAccessPoint startup OK%n");
       producer.startup();
       System.out.printf("Producer startup OK%n");
       {
           Message message = producer.createBytesMessage("OMS_HELLO_TOPIC", "OMS_HELLO_BODY".getBytes(Charset.forName("UTF-8")));
           SendResult sendResult = producer.send(message);
           //final Void aVoid = result.get(3000L);
           System.out.printf("Send async message OK, msgId: %s%n", sendResult.messageId());
       }
       final CountDownLatch countDownLatch = new CountDownLatch(1);
       {
           final Future<SendResult> result = producer.sendAsync(producer.createBytesMessage("OMS_HELLO_TOPIC", "OMS_HELLO_BODY".getBytes(Charset.forName("UTF-8"))));
           result.addListener(new FutureListener<SendResult>() {
               @Override
               public void operationComplete(Future<SendResult> future) {
                   if (future.getThrowable() != null) {
                       System.out.printf("Send async message Failed, error: %s%n", future.getThrowable().getMessage());
                   } else {
                       System.out.printf("Send async message OK, msgId: %s%n", future.get().messageId());
                   }
                   countDownLatch.countDown();
               }
           });
       }
       {
           producer.sendOneway(producer.createBytesMessage("OMS_HELLO_TOPIC", "OMS_HELLO_BODY".getBytes(Charset.forName("UTF-8"))));
           System.out.printf("Send oneway message OK%n");
       }
       try {
           countDownLatch.await();
           Thread.sleep(500); // 等一些时间来发送消息
       } catch (InterruptedException ignore) {
       }
       producer.shutdown();
   }
}
```

### 8.2 OMSPullConsumer

用OMS PullConsumer 来从指定的队列中拉取消息

```java
import io.openmessaging.Message;
import io.openmessaging.MessagingAccessPoint;
import io.openmessaging.OMS;
import io.openmessaging.OMSBuiltinKeys;
import io.openmessaging.consumer.PullConsumer;
import io.openmessaging.producer.Producer;
import io.openmessaging.producer.SendResult;

public class SimplePullConsumer {
    public static void main(String[] args) {
       final MessagingAccessPoint messagingAccessPoint =
           OMS.getMessagingAccessPoint("oms:rocketmq://localhost:9876/default:default");
       messagingAccessPoint.startup();
       final Producer producer = messagingAccessPoint.createProducer();
       final PullConsumer consumer = messagingAccessPoint.createPullConsumer(
           OMS.newKeyValue().put(OMSBuiltinKeys.CONSUMER_ID, "OMS_CONSUMER"));
       messagingAccessPoint.startup();
       System.out.printf("MessagingAccessPoint startup OK%n");
       final String queueName = "TopicTest";
       producer.startup();
       Message msg = producer.createBytesMessage(queueName, "Hello Open Messaging".getBytes());
       SendResult sendResult = producer.send(msg);
       System.out.printf("Send Message OK. MsgId: %s%n", sendResult.messageId());
       producer.shutdown();
       consumer.attachQueue(queueName);
       consumer.startup();
       System.out.printf("Consumer startup OK%n");
       // 运行直到发现一个消息被发送了
       boolean stop = false;
       while (!stop) {
           Message message = consumer.receive();
           if (message != null) {
               String msgId = message.sysHeaders().getString(Message.BuiltinKeys.MESSAGE_ID);
               System.out.printf("Received one message: %s%n", msgId);
               consumer.ack(msgId);
               if (!stop) {
                   stop = msgId.equalsIgnoreCase(sendResult.messageId());
               }
           } else {
               System.out.printf("Return without any message%n");
           }
       }
       consumer.shutdown();
       messagingAccessPoint.shutdown();
   }
}
```

### 8.3 OMSPushConsumer

以下示范如何将 OMS PushConsumer 添加到指定的队列，并通过 MessageListener 消费

~~~java
import io.openmessaging.Message;
import io.openmessaging.MessagingAccessPoint;
import io.openmessaging.OMS;
import io.openmessaging.OMSBuiltinKeys;
import io.openmessaging.consumer.MessageListener;
import io.openmessaging.consumer.PushConsumer;

public class SimplePushConsumer {
    public static void main(String[] args) {
       final MessagingAccessPoint messagingAccessPoint = OMS
           .getMessagingAccessPoint("oms:rocketmq://localhost:9876/default:default");
       final PushConsumer consumer = messagingAccessPoint.
           createPushConsumer(OMS.newKeyValue().put(OMSBuiltinKeys.CONSUMER_ID, "OMS_CONSUMER"));
       messagingAccessPoint.startup();
       System.out.printf("MessagingAccessPoint startup OK%n");
       Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
           @Override
           public void run() {
               consumer.shutdown();
               messagingAccessPoint.shutdown();
           }
       }));
       consumer.attachQueue("OMS_HELLO_TOPIC", new MessageListener() {
           @Override
           public void onReceived(Message message, Context context) {
               System.out.printf("Received one message: %s%n", message.sysHeaders().getString(Message.BuiltinKeys.MESSAGE_ID));
               context.ack();
           }
       });
       consumer.startup();
       System.out.printf("Consumer startup OK%n");
   }
}
~~~

# “Request-Reply”特性

---

## 1 使用场景

随着服务规模的扩大，单机服务无法满足性能和容量的要求，此时需要将服务拆分为更小粒度的服务或者部署多个服务实例构成集群来提供服务。在分布式场景下，RPC是最常用的联机调用的方式。

在构建分布式应用时，有些领域，例如金融服务领域，常常使用消息队列来构建服务总线，实现联机调用的目的。消息队列的主要场景是解耦、削峰填谷，在联机调用的场景下，需要将服务的调用抽象成基于消息的交互，并增强同步调用的这种交互逻辑。为了更好地支持消息队列在联机调用场景下的应用，rocketmq-4.7.0推出了“Request-Reply”特性来支持RPC调用。

## 2 设计思路

在rocketmq中，整个同步调用主要包括两个过程：

（1）请求方生成消息，发送给响应方，并等待响应方回包；

（2）响应方收到请求消息后，消费这条消息，并发出一条响应消息给请求方。

整个过程实质上是两个消息收发过程的组合。所以这里最关键的问题是如何将异步的消息收发过程构建成一个同步的过程。其中主要有两个问题需要解决：

### 2.1 请求方如何同步等待回包

这个问题的解决方案中，一个关键的数据结构是RequestResponseFuture。

```
public class RequestResponseFuture {
    private final String correlationId;
    private final RequestCallback requestCallback;
    private final long beginTimestamp = System.currentTimeMillis();
    private final Message requestMsg = null;
    private long timeoutMillis;
    private CountDownLatch countDownLatch = new CountDownLatch(1);
    private volatile Message responseMsg = null;
    private volatile boolean sendRequestOk = true;
    private volatile Throwable cause = null;
}
```

RequestResponseFuture中，利用correlationId来标识一个请求。如下图所示，Producer发送request时创建一个RequestResponseFuture，以correlationId为key，RequestResponseFuture为value存入map，同时请求中带上RequestResponseFuture中的correlationId，收到回包后根据correlationId拿到对应的RequestResponseFuture，并设置回包内容。
![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162007163.png)

### 2.2 consumer消费消息后，如何准确回包

（1）producer在发送消息的时候，会给每条消息生成唯一的标识符，同时还带上了producer的clientId。当consumer收到并消费消息后，从消息中取出消息的标识符correlationId和producer的标识符clientId，放入响应消息，用来确定此响应消息是哪条请求消息的回包，以及此响应消息应该发给哪个producer。同时响应消息中设置了消息的类型以及响应消息的topic，然后consumer将消息发给broker，如下图所示。
![](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502162007167.png)

（2）broker收到响应消息后，需要将消息发回给指定的producer。Broker如何知道发回给哪个producer？因为消息中包含了producer的标识符clientId，在ProducerManager中，维护了标识符和channel信息的对应关系，通过这个对应关系，就能把回包发给对应的producer。

响应消息发送和一般的消息发送流程区别在于，响应消息不需要producer拉取，而是由broker直接推给producer。同时选择broker的策略也有变化：请求消息从哪个broker发过来，响应消息也发到对应的broker上。

Producer收到响应消息后，根据消息中的唯一标识符，从RequestResponseFuture的map中找到对应的RequestResponseFuture结构，设置响应消息，同时计数器减一，解除等待状态，使请求方收到响应消息。

## 3 使用方法

同步调用的示例在example文件夹的rpc目录下。

### 3.1 Producer

```
Message msg = new Message(topic,
                "",
                "Hello world".getBytes(RemotingHelper.DEFAULT_CHARSET));

            long begin = System.currentTimeMillis();
            Message retMsg = producer.request(msg, ttl);
            long cost = System.currentTimeMillis() - begin;
            System.out.printf("request to <%s> cost: %d replyMessage: %s %n", topic, cost, retMsg);
```

调用接口替换为request即可。

### 3.2 Consumer

需要启动一个producer，同时在覆写consumeMessage方法的时候，自定义响应消息并发送。

```
            @Override
            public ConsumeConcurrentlyStatus consumeMessage(List<MessageExt> msgs, ConsumeConcurrentlyContext context) {
                System.out.printf("%s Receive New Messages: %s %n", Thread.currentThread().getName(), msgs);
                for (MessageExt msg : msgs) {
                    try {
                        System.out.printf("handle message: %s", msg.toString());
                        String replyTo = MessageUtil.getReplyToClient(msg);
                        byte[] replyContent = "reply message contents.".getBytes();
                        // create reply message with given util, do not create reply message by yourself
                        Message replyMessage = MessageUtil.createReplyMessage(msg, replyContent);

                        // send reply message with producer
                        SendResult replyResult = replyProducer.send(replyMessage, 3000);
                        System.out.printf("reply to %s , %s %n", replyTo, replyResult.toString());
                    } catch (MQClientException | RemotingException | MQBrokerException | InterruptedException e) {
                        e.printStackTrace();
                    }
                }
                return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
            }
```

## 4 接口参数

4.1 public Message request(Message msg,long timeout)

msg：待发送的消息

timeout：同步调用超时时间

4.2 public void request(Message msg, final RequestCallback requestCallback, long timeout)

msg：待发送的消息

requestCallback：回调函数

timeout：同步调用超时时间

4.3 public Message request(final Message msg, final MessageQueueSelector selector, final Object arg,final long timeout)

msg：待发送的消息

selector：消息队列选择器

arg：消息队列选择器需要的参数

timeout：同步调用超时时间

4.4 public void request(final Message msg, final MessageQueueSelector selector, final Object arg,final RequestCallback
requestCallback, final long timeout)

msg：待发送的消息

selector：消息队列选择器

arg：消息队列选择器需要的参数

requestCallback：回调函数

timeout：同步调用超时时间

4.5 public Message request(final Message msg, final MessageQueue mq, final long timeout)

msg：待发送的消息

mq：目标消息队列

timeout：同步调用超时时间

4.6 public void request(final Message msg, final MessageQueue mq, final RequestCallback requestCallback, long timeout)

msg：待发送的消息

mq：目标消息队列

requestCallback：回调函数

timeout：同步调用超时时间

## DefaultMQProducer

---

### 类简介

`public class DefaultMQProducer
extends ClientConfig
implements MQProducer`

> `DefaultMQProducer`
> 类是应用用来投递消息的入口，开箱即用，可通过无参构造方法快速创建一个生产者。主要负责消息的发送，支持同步/异步/oneway的发送方式，这些发送方式均支持批量发送。可以通过该类提供的getter/setter方法，调整发送者的参数。`DefaultMQProducer`
> 提供了多个send方法，每个send方法略有不同，在使用前务必详细了解其意图。下面给出一个生产者示例代码，[点击查看更多示例代码](https://github.com/apache/rocketmq/blob/master/example/src/main/java/org/apache/rocketmq/example/)。

``` java 
public class Producer {
    public static void main(String[] args) throws MQClientException {
        // 创建指定分组名的生产者
        DefaultMQProducer producer = new DefaultMQProducer("ProducerGroupName");

        // 启动生产者
        producer.start();

        for (int i = 0; i < 128; i++)
            try {
            	// 构建消息
                Message msg = new Message("TopicTest",
                        "TagA",
                        "OrderID188",
                        "Hello world".getBytes(RemotingHelper.DEFAULT_CHARSET));

                // 同步发送
                SendResult sendResult = producer.send(msg);

                // 打印发送结果
                System.out.printf("%s%n", sendResult);
            } catch (Exception e) {
                e.printStackTrace();
            }

        producer.shutdown();
    }
}
```

**注意**：该类是线程安全的。在配置并启动完成后可在多个线程间安全共享。

### 字段摘要

| 类型                    | 字段名称                             | 描述                      |
|-----------------------|----------------------------------|-------------------------|
| DefaultMQProducerImpl | defaultMQProducerImpl            | 生产者的内部默认实现              |
| String                | producerGroup                    | 生产者分组                   |
| String                | createTopicKey                   | 在发送消息时，自动创建服务器不存在的topic |
| int                   | defaultTopicQueueNums            | 创建topic时默认的队列数量         |
| int                   | sendMsgTimeout                   | 发送消息的超时时间               |
| int                   | compressMsgBodyOverHowmuch       | 压缩消息体的阈值                |
| int                   | retryTimesWhenSendFailed         | 同步模式下内部尝试发送消息的最大次数      |
| int                   | retryTimesWhenSendAsyncFailed    | 异步模式下内部尝试发送消息的最大次数      |
| boolean               | retryAnotherBrokerWhenNotStoreOK | 是否在内部发送失败时重试另一个broker   |
| int                   | maxMessageSize                   | 消息的最大长度                 |
| TraceDispatcher       | traceDispatcher                  | 消息追踪器。使用rcpHook来追踪消息    |

### 构造方法摘要

| 方法名称                                                                                                                     | 方法描述                                           |
|--------------------------------------------------------------------------------------------------------------------------|------------------------------------------------|
| DefaultMQProducer()                                                                                                      | 由默认参数值创建一个生产者                                  |
| DefaultMQProducer(final String producerGroup)                                                                            | 使用指定的分组名创建一个生产者                                |
| DefaultMQProducer(final String producerGroup, boolean enableMsgTrace)                                                    | 使用指定的分组名创建一个生产者，并设置是否开启消息追踪                    |
| DefaultMQProducer(final String producerGroup, boolean enableMsgTrace, final String customizedTraceTopic)                 | 使用指定的分组名创建一个生产者，并设置是否开启消息追踪及追踪topic的名称         |
| DefaultMQProducer(RPCHook rpcHook)                                                                                       | 使用指定的hook创建一个生产者                               |
| DefaultMQProducer(final String producerGroup, RPCHook rpcHook)                                                           | 使用指定的分组名及自定义hook创建一个生产者                        |
| DefaultMQProducer(final String producerGroup, RPCHook rpcHook, boolean enableMsgTrace,final String customizedTraceTopic) | 使用指定的分组名及自定义hook创建一个生产者，并设置是否开启消息追踪及追踪topic的名称 |

### 使用方法摘要

| 返回值                   | 方法名称                                                                                                  | 方法描述                           |
|-----------------------|-------------------------------------------------------------------------------------------------------|--------------------------------|
| void                  | createTopic(String key, String newTopic, int queueNum)                                                | 在broker上创建指定的topic             |
| void                  | createTopic(String key, String newTopic, int queueNum, int topicSysFlag)                              | 在broker上创建指定的topic             |
| long                  | earliestMsgStoreTime(MessageQueue mq)                                                                 | 查询最早的消息存储时间                    |
| List<MessageQueue>    | fetchPublishMessageQueues(String topic)                                                               | 获取topic的消息队列                   |
| long                  | maxOffset(MessageQueue mq)                                                                            | 查询给定消息队列的最大offset              |
| long                  | minOffset(MessageQueue mq)                                                                            | 查询给定消息队列的最小offset              |
| QueryResult           | queryMessage(String topic, String key, int maxNum, long begin, long end)                              | 按关键字查询消息                       |
| long                  | searchOffset(MessageQueue mq, long timestamp)                                                         | 查找指定时间的消息队列的物理offset           |
| SendResult            | send(Collection<Message> msgs)                                                                        | 同步批量发送消息                       |
| SendResult            | send(Collection<Message> msgs, long timeout)                                                          | 同步批量发送消息                       |
| SendResult            | send(Collection<Message> msgs, MessageQueue messageQueue)                                             | 向指定的消息队列同步批量发送消息               |
| SendResult            | send(Collection<Message> msgs, MessageQueue messageQueue, long timeout)                               | 向指定的消息队列同步批量发送消息，并指定超时时间       |
| SendResult            | send(Message msg)                                                                                     | 同步单条发送消息                       |
| SendResult            | send(Message msg, long timeout)                                                                       | 同步发送单条消息，并指定超时时间               |
| SendResult            | send(Message msg, MessageQueue mq)                                                                    | 向指定的消息队列同步发送单条消息               |
| SendResult            | send(Message msg, MessageQueue mq, long timeout)                                                      | 向指定的消息队列同步单条发送消息，并指定超时时间       |
| void                  | send(Message msg, MessageQueue mq, SendCallback sendCallback)                                         | 向指定的消息队列异步单条发送消息，并指定回调方法       |
| void                  | send(Message msg, MessageQueue mq, SendCallback sendCallback, long timeout)                           | 向指定的消息队列异步单条发送消息，并指定回调方法和超时时间  |
| SendResult            | send(Message msg, MessageQueueSelector selector, Object arg)                                          | 向消息队列同步单条发送消息，并指定发送队列选择器       |
| SendResult            | send(Message msg, MessageQueueSelector selector, Object arg, long timeout)                            | 向消息队列同步单条发送消息，并指定发送队列选择器与超时时间  |
| void                  | send(Message msg, MessageQueueSelector selector, Object arg, SendCallback sendCallback)               | 向指定的消息队列异步单条发送消息               |
| void                  | send(Message msg, MessageQueueSelector selector, Object arg, SendCallback sendCallback, long timeout) | 向指定的消息队列异步单条发送消息，并指定超时时间       |
| void                  | send(Message msg, SendCallback sendCallback)                                                          | 异步发送消息                         |
| void                  | send(Message msg, SendCallback sendCallback, long timeout)                                            | 异步发送消息，并指定回调方法和超时时间            |
| TransactionSendResult | sendMessageInTransaction(Message msg, LocalTransactionExecuter tranExecuter, final Object arg)        | 发送事务消息，并指定本地执行事务实例             |
| TransactionSendResult | sendMessageInTransaction(Message msg, Object arg)                                                     | 发送事务消息                         |
| void                  | sendOneway(Message msg)                                                                               | 单向发送消息，不等待broker响应             |
| void                  | sendOneway(Message msg, MessageQueue mq)                                                              | 单向发送消息到指定队列，不等待broker响应        |
| void                  | sendOneway(Message msg, MessageQueueSelector selector, Object arg)                                    | 单向发送消息到队列选择器的选中的队列，不等待broker响应 |
| void                  | shutdown()                                                                                            | 关闭当前生产者实例并释放相关资源               |
| void                  | start()                                                                                               | 启动生产者                          |
| MessageExt            | viewMessage(String offsetMsgId)                                                                       | 根据给定的msgId查询消息                 |
| MessageExt            | public MessageExt viewMessage(String topic, String msgId)                                             | 根据给定的msgId查询消息，并指定topic        |

### 字段详细信息

- [producerGroup](http://rocketmq.apache.org/docs/core-concept/)

  `private String producerGroup`

  生产者的分组名称。相同的分组名称表明生产者实例在概念上归属于同一分组。这对事务消息十分重要，如果原始生产者在事务之后崩溃，那么broker可以联系同一生产者分组的不同生产者实例来提交或回滚事务。

  默认值：DEFAULT_PRODUCER

  注意： 由数字、字母、下划线、横杠（-）、竖线（|）或百分号组成；不能为空；长度不能超过255。

- defaultMQProducerImpl

  `protected final transient DefaultMQProducerImpl defaultMQProducerImpl`

  生产者的内部默认实现，在构造生产者时内部自动初始化，提供了大部分方法的内部实现。

- createTopicKey

  `private String createTopicKey = MixAll.AUTO_CREATE_TOPIC_KEY_TOPIC`

  在发送消息时，自动创建服务器不存在的topic，需要指定Key，该Key可用于配置发送消息所在topic的默认路由。

  默认值：TBW102

  建议：测试或者demo使用，生产环境下不建议打开自动创建配置。

- defaultTopicQueueNums

  `private volatile int defaultTopicQueueNums = 4`

  创建topic时默认的队列数量。

  默认值：4

- sendMsgTimeout

  `private int sendMsgTimeout = 3000`

  发送消息时的超时时间。

  默认值：3000，单位：毫秒

  建议：不建议修改该值，该值应该与broker配置中的sendTimeout一致，发送超时，可临时修改该值，建议解决超时问题，提高broker集群的Tps。

- compressMsgBodyOverHowmuch

  `private int compressMsgBodyOverHowmuch = 1024 * 4`

  压缩消息体阈值。大于4K的消息体将默认进行压缩。

  默认值：1024 * 4，单位：字节

  建议：可通过DefaultMQProducerImpl.setZipCompressLevel方法设置压缩率（默认为5，可选范围[0,9]
  ）；可通过DefaultMQProducerImpl.tryToCompressMessage方法测试出compressLevel与compressMsgBodyOverHowmuch最佳值。

- retryTimesWhenSendFailed

  `private int retryTimesWhenSendFailed = 2`

  同步模式下，在返回发送失败之前，内部尝试重新发送消息的最大次数。

  默认值：2，即：默认情况下一条消息最多会被投递3次。

  注意：在极端情况下，这可能会导致消息的重复。

- retryTimesWhenSendAsyncFailed

  `private int retryTimesWhenSendAsyncFailed = 2`

  异步模式下，在发送失败之前，内部尝试重新发送消息的最大次数。

  默认值：2，即：默认情况下一条消息最多会被投递3次。

  注意：在极端情况下，这可能会导致消息的重复。

- retryAnotherBrokerWhenNotStoreOK

  `private boolean retryAnotherBrokerWhenNotStoreOK = false`

  同步模式下，消息保存失败时是否重试其他broker。

  默认值：false

  注意：此配置关闭时，非投递时产生异常情况下，会忽略retryTimesWhenSendFailed配置。

- maxMessageSize

  `private int maxMessageSize = 1024 * 1024 * 4`

  消息的最大大小。当消息题的字节数超过maxMessageSize就发送失败。

  默认值：1024 * 1024 * 4，单位：字节

- [traceDispatcher](https://github.com/apache/rocketmq/wiki/RIP-6-Message-Trace)

  `private TraceDispatcher traceDispatcher = null`

  在开启消息追踪后，该类通过hook的方式把消息生产者，消息存储的broker和消费者消费消息的信息像链路一样记录下来。在构造生产者时根据构造入参enableMsgTrace来决定是否创建该对象。

### 构造方法详细信息

1. DefaultMQProducer

   `public DefaultMQProducer()`

   创建一个新的生产者。

2. DefaultMQProducer

   `DefaultMQProducer(final String producerGroup)`

   使用指定的分组名创建一个生产者。

    - 入参描述：

      | 参数名        | 类型   | 是否必须 | 缺省值           | 描述             |
           | ------------- | ------ | -------- | ---------------- | ---------------- |
      | producerGroup | String | 是       | DEFAULT_PRODUCER | 生产者的分组名称 |

3. DefaultMQProducer

   `DefaultMQProducer(final String producerGroup, boolean enableMsgTrace)`

   使用指定的分组名创建一个生产者，并设置是否开启消息追踪。

    - 入参描述：

      | 参数名         | 类型    | 是否必须 | 缺省值           | 描述             |
           | -------------- | ------- | -------- | ---------------- | ---------------- |
      | producerGroup  | String  | 是       | DEFAULT_PRODUCER | 生产者的分组名称 |
      | enableMsgTrace | boolean | 是       | false            | 是否开启消息追踪 |

4. DefaultMQProducer

   `DefaultMQProducer(final String producerGroup, boolean enableMsgTrace, final String customizedTraceTopic)`

   使用指定的分组名创建一个生产者，并设置是否开启消息追踪及追踪topic的名称。

    - 入参描述：

      | 参数名               | 类型    | 是否必须 | 缺省值              | 描述                            |
           | -------------------- | ------- | -------- | ------------------- | ------------------------------- |
      | producerGroup        | String  | 是       | DEFAULT_PRODUCER    | 生产者的分组名称                |
      | rpcHook              | RPCHook | 否       | null                | 每个远程命令执行后会回调rpcHook |
      | enableMsgTrace       | boolean | 是       | false               | 是否开启消息追踪                |
      | customizedTraceTopic | String  | 否       | RMQ_SYS_TRACE_TOPIC | 消息跟踪topic的名称             |

5. DefaultMQProducer

   `DefaultMQProducer(RPCHook rpcHook)`

   使用指定的hook创建一个生产者。

    - 入参描述：

      | 参数名  | 类型    | 是否必须 | 缺省值 | 描述                            |
           | ------- | ------- | -------- | ------ | ------------------------------- |
      | rpcHook | RPCHook | 否       | null   | 每个远程命令执行后会回调rpcHook |

6. DefaultMQProducer

   `DefaultMQProducer(final String producerGroup, RPCHook rpcHook)`

   使用指定的分组名及自定义hook创建一个生产者。

    - 入参描述：

      | 参数名        | 类型    | 是否必须 | 缺省值           | 描述                            |
           | ------------- | ------- | -------- | ---------------- | ------------------------------- |
      | producerGroup | String  | 是       | DEFAULT_PRODUCER | 生产者的分组名称                |
      | rpcHook       | RPCHook | 否       | null             | 每个远程命令执行后会回调rpcHook |

7. DefaultMQProducer

   `DefaultMQProducer(final String producerGroup, RPCHook rpcHook, boolean enableMsgTrace,final String customizedTraceTopic)`

   使用指定的分组名及自定义hook创建一个生产者，并设置是否开启消息追踪及追踪topic的名称。

    - 入参描述：

   | 参数名               | 类型    | 是否必须 | 缺省值              | 描述                            |
      | -------------------- | ------- | -------- | ------------------- | ------------------------------- |
   | producerGroup        | String  | 是       | DEFAULT_PRODUCER    | 生产者的分组名称                |
   | rpcHook              | RPCHook | 否       | null                | 每个远程命令执行后会回调rpcHook |
   | enableMsgTrace       | boolean | 是       | false               | 是否开启消息追踪                |
   | customizedTraceTopic | String  | 否       | RMQ_SYS_TRACE_TOPIC | 消息跟踪topic的名称             |

### 使用方法详细信息

1. createTopic

   `public void createTopic(String key, String newTopic, int queueNum)`

   在broker上创建一个topic。

    - 入参描述：

      | 参数名   | 类型   | 是否必须 | 默认值 | 值范围           | 说明                                                         |
           | -------- | ------ | -------- | ------ | ---------------- | ------------------------------------------------------------ |
      | key      | String | 是       |        |                  | 访问密钥。                                                   |
      | newTopic | String | 是       |        |                  | 新建topic的名称。由数字、字母、下划线（_）、横杠（-）、竖线（&#124;）或百分号（%）组成；<br>长度小于255；不能为TBW102或空。 |
      | queueNum | int    | 是       | 0      | (0, maxIntValue] | topic的队列数量。                                            |

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - 生产者状态非Running；未找到broker等客户端异常。

2. createTopic

   `public void createTopic(String key, String newTopic, int queueNum, int topicSysFlag)`

   在broker上创建一个topic。

    - 入参描述：

      | 参数名       | 类型   | 是否必须 | 默认值 | 值范围           | 说明                 |
           | ------------ | ------ | -------- | ------ | ---------------- | -------------------- |
      | key          | String | 是       |        |                  | 访问密钥。           |
      | newTopic     | String | 是       |        |                  | 新建topic的名称。    |
      | queueNum     | int    | 是       | 0      | (0, maxIntValue] | topic的队列数量。    |
      | topicSysFlag | int    | 是       | 0      |                  | 保留字段，暂未使用。 |

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - 生产者状态非Running；未找到broker等客户端异常。

3. earliestMsgStoreTime

   `public long earliestMsgStoreTime(MessageQueue mq)`

   查询最早的消息存储时间。

    - 入参描述：

      | 参数名 | 类型         | 是否必须 | 默认值 | 值范围 | 说明             |
           | ------ | ------------ | -------- | ------ | ------ | ---------------- |
      | mq     | MessageQueue | 是       |        |        | 要查询的消息队列 |

    - 返回值描述：

      指定队列最早的消息存储时间。单位：毫秒。

    - 异常描述：

      MQClientException - 生产者状态非Running；没有找到broker；broker返回失败；网络异常；线程中断等客户端异常。

4. fetchPublishMessageQueues

   `public List<MessageQueue> fetchPublishMessageQueues(String topic)`

   获取topic的消息队列。

    - 入参描述：

      | 参数名 | 类型   | 是否必须 | 默认值 | 值范围 | 说明      |
           | ------ | ------ | -------- | ------ | ------ | --------- |
      | topic  | String | 是       |        |        | topic名称 |

    - 返回值描述：

      传入topic下的消息队列。

    - 异常描述：

      MQClientException - 生产者状态非Running；没有找到broker；broker返回失败；网络异常；线程中断等客户端异常。

5. maxOffset

   `public long maxOffset(MessageQueue mq)`

   查询消息队列的最大物理偏移量。

    - 入参描述：

      | 参数名 | 类型         | 是否必须 | 默认值 | 值范围 | 说明             |
           | ------ | ------------ | -------- | ------ | ------ | ---------------- |
      | mq     | MessageQueue | 是       |        |        | 要查询的消息队列 |

    - 返回值描述：

      给定消息队列的最大物理偏移量。

    - 异常描述：

      MQClientException - 生产者状态非Running；没有找到broker；broker返回失败；网络异常；线程中断等客户端异常。

6. minOffset

   `public long minOffset(MessageQueue mq)`

   查询给定消息队列的最小物理偏移量。

    - 入参描述：

      | 参数名 | 类型         | 是否必须 | 默认值 | 值范围 | 说明             |
           | ------ | ------------ | -------- | ------ | ------ | ---------------- |
      | mq     | MessageQueue | 是       |        |        | 要查询的消息队列 |

    - 返回值描述：

      给定消息队列的最小物理偏移量。

    - 异常描述：

      MQClientException - 生产者状态非Running；没有找到broker；broker返回失败；网络异常；线程中断等客户端异常。

7. queryMessage

   `public QueryResult queryMessage(String topic, String key, int maxNum, long begin, long end)`

   按关键字查询消息。

    - 入参描述：

      | 参数名 | 类型   | 是否必须 | 默认值 | 值范围 | 说明                   |
           | ------ | ------ | -------- | ------ | ------ | ---------------------- |
      | topic  | String | 是       |        |        | topic名称              |
      | key    | String | 否       | null   |        | 查找的关键字           |
      | maxNum | int    | 是       |        |        | 返回消息的最大数量     |
      | begin  | long   | 是       |        |        | 开始时间戳，单位：毫秒 |
      | end    | long   | 是       |        |        | 结束时间戳，单位：毫秒 |

    - 返回值描述：

      查询到的消息集合。

    - 异常描述：

      MQClientException - 生产者状态非Running；没有找到broker；broker返回失败；网络异常等客户端异常客户端异常。<br>
      InterruptedException - 线程中断。

8. searchOffset

   `public long searchOffset(MessageQueue mq, long timestamp)`

   查找指定时间的消息队列的物理偏移量。

    - 入参描述：

      | 参数名    | 类型         | 是否必须 | 默认值 | 值范围 | 说明                                 |
           | --------- | ------------ | -------- | ------ | ------ | ------------------------------------ |
      | mq        | MessageQueue | 是       |        |        | 要查询的消息队列。                   |
      | timestamp | long         | 是       |        |        | 指定要查询时间的时间戳。单位：毫秒。 |

    - 返回值描述：

      指定时间的消息队列的物理偏移量。

    - 异常描述：

      MQClientException - 生产者状态非Running；没有找到broker；broker返回失败；网络异常；线程中断等客户端异常。

9. send

   `public SendResult send(Collection<Message> msgs)`

   同步批量发送消息。在返回发送失败之前，内部尝试重新发送消息的最大次数（参见*retryTimesWhenSendFailed*
   属性）。未明确指定发送队列，默认采取轮询策略发送。

    - 入参描述：

      | 参数名 | 类型                | 是否必须 | 默认值 | 值范围 | 说明                                              |
           | ------ | ------------------- | -------- | ------ | ------ | ------------------------------------------------- |
      | msgs   | Collection<Message> | 是       |        |        | 待发送的消息集合。集合内的消息必须属同一个topic。 |

    - 返回值描述：

      批量消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

10. send

    `public SendResult send(Collection<Message> msgs, long timeout)`

    同步批量发送消息，如果在指定的超时时间内未完成消息投递，会抛出*RemotingTooMuchRequestException*。
    在返回发送失败之前，内部尝试重新发送消息的最大次数（参见*retryTimesWhenSendFailed*属性）。未明确指定发送队列，默认采取轮询策略发送。

    - 入参描述：

      | 参数名  | 类型                | 是否必须 | 默认值                   | 值范围 | 说明                                              |
            | ------- | ------------------- | -------- | ------------------------ | ------ | ------------------------------------------------- |
      | msgs    | Collection<Message> | 是       |                          |        | 待发送的消息集合。集合内的消息必须属同一个topic。 |
      | timeout | long                | 是       | 参见*sendMsgTimeout*属性 |        | 发送超时时间，单位：毫秒。                        |

    - 返回值描述：

      批量消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

11. send

    `public SendResult send(Collection<Message> msgs, MessageQueue messageQueue)`

    向给定队列同步批量发送消息。

    注意：指定队列意味着所有消息均为同一个topic。

    - 入参描述：

      | 参数名       | 类型                | 是否必须 | 默认值 | 值范围 | 说明                                                        |
            | ------------ | ------------------- | -------- | ------ | ------ | ----------------------------------------------------------- |
      | msgs         | Collection<Message> | 是       |        |        | 待发送的消息集合。集合内的消息必须属同一个topic。           |
      | messageQueue | MessageQueue        | 是       |        |        | 待投递的消息队列。指定队列意味着待投递消息均为同一个topic。 |

    - 返回值描述：

      批量消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

12. send

    `public SendResult send(Collection<Message> msgs, MessageQueue messageQueue, long timeout)`

    向给定队列同步批量发送消息，如果在指定的超时时间内未完成消息投递，会抛出*RemotingTooMuchRequestException*。

    注意：指定队列意味着所有消息均为同一个topic。

    - 入参描述：

      | 参数名       | 类型                | 是否必须 | 默认值                   | 值范围 | 说明                                                        |
            | ------------ | ------------------- | -------- | ------------------------ | ------ | ----------------------------------------------------------- |
      | msgs         | Collection<Message> | 是       |                          |        | 待发送的消息集合。集合内的消息必须属同一个topic。           |
      | timeout      | long                | 是       | 参见*sendMsgTimeout*属性 |        | 发送超时时间，单位：毫秒。                                  |
      | messageQueue | MessageQueue        | 是       |                          |        | 待投递的消息队列。指定队列意味着待投递消息均为同一个topic。 |

    - 返回值描述：

      批量消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

13. send

    `public SendResult send(Message msg)`

    以同步模式发送消息，仅当发送过程完全完成时，此方法才会返回。
    在返回发送失败之前，内部尝试重新发送消息的最大次数（参见*retryTimesWhenSendFailed*属性）。未明确指定发送队列，默认采取轮询策略发送。

    - 入参描述：

      | 参数名 | 类型    | 是否必须 | 默认值 | 值范围 | 说明           |
            | ------ | ------- | -------- | ------ | ------ | -------------- |
      | msg    | Message | 是       |        |        | 待发送的消息。 |

    - 返回值描述：

      消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

14. send

    `public SendResult send(Message msg, long timeout)`

    以同步模式发送消息，如果在指定的超时时间内未完成消息投递，会抛出*RemotingTooMuchRequestException*。仅当发送过程完全完成时，此方法才会返回。
    在返回发送失败之前，内部尝试重新发送消息的最大次数（参见*retryTimesWhenSendFailed*属性）。未明确指定发送队列，默认采取轮询策略发送。

    - 入参描述：

      | 参数名  | 类型    | 是否必须 | 默认值                   | 值范围 | 说明                       |
            | ------- | ------- | -------- | ------------------------ | ------ | -------------------------- |
      | msg     | Message | 是       |                          |        | 待发送的消息。             |
      | timeout | long    | 是       | 参见*sendMsgTimeout*属性 |        | 发送超时时间，单位：毫秒。 |

    - 返回值描述：

      消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

15. send

    `public SendResult send(Message msg, MessageQueue mq)`

    向指定的消息队列同步发送单条消息。仅当发送过程完全完成时，此方法才会返回。

    - 入参描述：

      | 参数名 | 类型         | 是否必须 | 默认值 | 值范围 | 说明               |
            | ------ | ------------ | -------- | ------ | ------ | ------------------ |
      | msg    | Message      | 是       |        |        | 待发送的消息。     |
      | mq     | MessageQueue | 是       |        |        | 待投递的消息队列。 |

    - 返回值描述：

      消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

16. send

    `public SendResult send(Message msg, MessageQueue mq, long timeout)`

    向指定的消息队列同步发送单条消息，如果在指定的超时时间内未完成消息投递，会抛出*RemotingTooMuchRequestException*
    。仅当发送过程完全完成时，此方法才会返回。

    - 入参描述：

      | 参数名  | 类型         | 是否必须 | 默认值                   | 值范围 | 说明                                                        |
            | ------- | ------------ | -------- | ------------------------ | ------ | ----------------------------------------------------------- |
      | msg     | Message      | 是       |                          |        | 待发送的消息。                                              |
      | timeout | long         | 是       | 参见*sendMsgTimeout*属性 |        | 发送超时时间，单位：毫秒。                                  |
      | mq      | MessageQueue | 是       |                          |        | 待投递的消息队列。指定队列意味着待投递消息均为同一个topic。 |

    - 返回值描述：

      消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

17. send

    `public void send(Message msg, MessageQueue mq, SendCallback sendCallback)`

    向指定的消息队列异步发送单条消息，异步发送调用后直接返回，并在在发送成功或者异常时回调`sendCallback`
    ，所以异步发送时`sendCallback`参数不能为null，否则在回调时会抛出`NullPointerException`。
    异步发送时，在成功发送前，其内部会尝试重新发送消息的最大次数（参见*retryTimesWhenSendAsyncFailed*属性）。

    - 入参描述：

      | 参数名       | 类型         | 是否必须 | 默认值 | 值范围 | 说明                                                        |
            | ------------ | ------------ | -------- | ------ | ------ | ----------------------------------------------------------- |
      | msg          | Message      | 是       |        |        | 待发送的消息。                                              |
      | mq           | MessageQueue | 是       |        |        | 待投递的消息队列。指定队列意味着待投递消息均为同一个topic。 |
      | sendCallback | SendCallback | 是       |        |        | 回调接口的实现。                                            |

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      InterruptedException - 发送线程中断。

18. send

    `public void send(Message msg, MessageQueue mq, SendCallback sendCallback, long timeout)`

    向指定的消息队列异步发送单条消息，异步发送调用后直接返回，并在在发送成功或者异常时回调`sendCallback`
    ，所以异步发送时`sendCallback`参数不能为null，否则在回调时会抛出`NullPointerException`。
    若在指定时间内消息未发送成功，回调方法会收到*RemotingTooMuchRequestException*异常。
    异步发送时，在成功发送前，其内部会尝试重新发送消息的最大次数（参见*retryTimesWhenSendAsyncFailed*属性）。

    - 入参描述：

      | 参数名       | 类型         | 是否必须 | 默认值                   | 值范围 | 说明                       |
            | ------------ | ------------ | -------- | ------------------------ | ------ | -------------------------- |
      | msg          | Message      | 是       |                          |        | 待发送的消息。             |
      | mq           | MessageQueue | 是       |                          |        | 待投递的消息队列。         |
      | sendCallback | SendCallback | 是       |                          |        | 回调接口的实现。           |
      | timeout      | long         | 是       | 参见*sendMsgTimeout*属性 |        | 发送超时时间，单位：毫秒。 |

    - 返回值描述：
      void

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      InterruptedException - 发送线程中断。

19. send

    `public SendResult send(Message msg, MessageQueueSelector selector, Object arg)`

    向通过`MessageQueueSelector`计算出的队列同步发送消息。

    可以通过自实现`MessageQueueSelector`接口，将某一类消息发送至固定的队列。比如：将同一个订单的状态变更消息投递至固定的队列。

    注意：此消息发送失败内部不会重试。

    - 入参描述：

      | 参数名   | 类型                 | 是否必须 | 默认值 | 值范围 | 说明                         |
            | -------- | -------------------- | -------- | ------ | ------ | ---------------------------- |
      | msg      | Message              | 是       |        |        | 待发送的消息。               |
      | selector | MessageQueueSelector | 是       |        |        | 队列选择器。                 |
      | arg      | Object               | 否       |        |        | 供队列选择器使用的参数对象。 |

    - 返回值描述：

      消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

20. send

    `public SendResult send(Message msg, MessageQueueSelector selector, Object arg, long timeout)`

    向通过`MessageQueueSelector`计算出的队列同步发送消息，并指定发送超时时间。

    可以通过自实现`MessageQueueSelector`接口，将某一类消息发送至固定的队列。比如：将同一个订单的状态变更消息投递至固定的队列。

    注意：此消息发送失败内部不会重试。

    - 入参描述：

      | 参数名   | 类型                 | 是否必须 | 默认值                   | 值范围 | 说明                         |
            | -------- | -------------------- | -------- | ------------------------ | ------ | ---------------------------- |
      | msg      | Message              | 是       |                          |        | 待发送的消息。               |
      | selector | MessageQueueSelector | 是       |                          |        | 队列选择器。                 |
      | arg      | Object               | 否       |                          |        | 供队列选择器使用的参数对象。 |
      | timeout  | long                 | 是       | 参见*sendMsgTimeout*属性 |        | 发送超时时间，单位：毫秒。   |

    - 返回值描述：

      消息的发送结果，包含msgId，发送状态等信息。

    - 异常描述：
      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 发送线程中断。<br>
      RemotingTooMuchRequestException - 发送超时。

21. send

    `public void send(Message msg, MessageQueueSelector selector, Object arg, SendCallback sendCallback)`

    向通过`MessageQueueSelector`
    计算出的队列异步发送单条消息，异步发送调用后直接返回，并在在发送成功或者异常时回调`sendCallback`
    ，所以异步发送时`sendCallback`参数不能为null，否则在回调时会抛出`NullPointerException`。
    异步发送时，在成功发送前，其内部会尝试重新发送消息的最大次数（参见*retryTimesWhenSendAsyncFailed*属性）。

    可以通过自实现`MessageQueueSelector`接口，将某一类消息发送至固定的队列。比如：将同一个订单的状态变更消息投递至固定的队列。

    - 入参描述：

      | 参数名       | 类型                 | 是否必须 | 默认值 | 值范围 | 说明                         |
            | ------------ | -------------------- | -------- | ------ | ------ | ---------------------------- |
      | msg          | Message              | 是       |        |        | 待发送的消息。               |
      | selector     | MessageQueueSelector | 是       |        |        | 队列选择器。                 |
      | arg          | Object               | 否       |        |        | 供队列选择器使用的参数对象。 |
      | sendCallback | SendCallback         | 是       |        |        | 回调接口的实现。             |

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      InterruptedException - 发送线程中断。

22. send

    `public void send(Message msg, MessageQueueSelector selector, Object arg, SendCallback sendCallback, long timeout)`

    向通过`MessageQueueSelector`
    计算出的队列异步发送单条消息，异步发送调用后直接返回，并在在发送成功或者异常时回调`sendCallback`
    ，所以异步发送时`sendCallback`参数不能为null，否则在回调时会抛出`NullPointerException`。
    异步发送时，在成功发送前，其内部会尝试重新发送消息的最大次数（参见*retryTimesWhenSendAsyncFailed*属性）。

    可以通过自实现`MessageQueueSelector`接口，将某一类消息发送至固定的队列。比如：将同一个订单的状态变更消息投递至固定的队列。

    - 入参描述：

      | 参数名       | 类型                 | 是否必须 | 默认值                   | 值范围 | 说明                         |
            | ------------ | -------------------- | -------- | ------------------------ | ------ | ---------------------------- |
      | msg          | Message              | 是       |                          |        | 待发送的消息。               |
      | selector     | MessageQueueSelector | 是       |                          |        | 队列选择器。                 |
      | arg          | Object               | 否       |                          |        | 供队列选择器使用的参数对象。 |
      | sendCallback | SendCallback         | 是       |                          |        | 回调接口的实现。             |
      | timeout      | long                 | 是       | 参见*sendMsgTimeout*属性 |        | 发送超时时间，单位：毫秒。   |

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      InterruptedException - 发送线程中断。

23. send

    `public void send(Message msg, SendCallback sendCallback)`

    异步发送单条消息，异步发送调用后直接返回，并在在发送成功或者异常时回调`sendCallback`，所以异步发送时`sendCallback`
    参数不能为null，否则在回调时会抛出`NullPointerException`。
    异步发送时，在成功发送前，其内部会尝试重新发送消息的最大次数（参见*retryTimesWhenSendAsyncFailed*属性）。

    - 入参描述：

      | 参数名       | 类型         | 是否必须 | 默认值 | 值范围 | 说明             |
            | ------------ | ------------ | -------- | ------ | ------ | ---------------- |
      | msg          | Message      | 是       |        |        | 待发送的消息。   |
      | sendCallback | SendCallback | 是       |        |        | 回调接口的实现。 |

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      InterruptedException - 发送线程中断。

24. send

    `public void send(Message msg, SendCallback sendCallback, long timeout)`

    异步发送单条消息，异步发送调用后直接返回，并在在发送成功或者异常时回调`sendCallback`，所以异步发送时`sendCallback`
    参数不能为null，否则在回调时会抛出`NullPointerException`。
    异步发送时，在成功发送前，其内部会尝试重新发送消息的最大次数（参见*retryTimesWhenSendAsyncFailed*属性）。

    - 入参描述：

      | 参数名       | 类型         | 是否必须 | 默认值                   | 值范围 | 说明                       |
            | ------------ | ------------ | -------- | ------------------------ | ------ | -------------------------- |
      | msg          | Message      | 是       |                          |        | 待发送的消息。             |
      | sendCallback | SendCallback | 是       |                          |        | 回调接口的实现。           |
      | timeout      | long         | 是       | 参见*sendMsgTimeout*属性 |        | 发送超时时间，单位：毫秒。 |

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      InterruptedException - 发送线程中断。

25. sendMessageInTransaction

    `public TransactionSendResult sendMessageInTransaction(Message msg, LocalTransactionExecuter tranExecuter, final Object arg)`

    发送事务消息。该类不做默认实现，抛出`RuntimeException`异常。参见：`TransactionMQProducer`类。

    - 入参描述：

      | 参数名       | 类型                       | 是否必须 | 默认值 | 值范围 | 说明                                                         |
            | ------------ | -------------------------- | -------- | ------ | ------ | ------------------------------------------------------------ |
      | msg          | Message                    | 是       |        |        | 待投递的事务消息                                             |
      | tranExecuter | `LocalTransactionExecuter` | 是       |        |        | 本地事务执行器。该类*已过期*，将在5.0.0版本中移除。请勿使用该方法。 |
      | arg          | Object                     | 是       |        |        | 供本地事务执行程序使用的参数对象                             |

    - 返回值描述：

      事务结果，参见：`LocalTransactionState`类。

    - 异常描述：

      RuntimeException - 永远抛出该异常。

26. sendMessageInTransaction

    `public TransactionSendResult sendMessageInTransaction(Message msg, final Object arg)`

    发送事务消息。该类不做默认实现，抛出`RuntimeException`异常。参见：`TransactionMQProducer`类。

    - 入参描述：

      | 参数名 | 类型    | 是否必须 | 默认值 | 值范围 | 说明                             |
            | ------ | ------- | -------- | ------ | ------ | -------------------------------- |
      | msg    | Message | 是       |        |        | 待投递的事务消息                 |
      | arg    | Object  | 是       |        |        | 供本地事务执行程序使用的参数对象 |

    - 返回值描述：

      事务结果，参见：`LocalTransactionState`类。

    - 异常描述：

      RuntimeException - 永远抛出该异常。

27. sendOneway

    `public void sendOneway(Message msg)`

    以oneway形式发送消息，broker不会响应任何执行结果，和[UDP](https://en.wikipedia.org/wiki/User_Datagram_Protocol)
    类似。它具有最大的吞吐量但消息可能会丢失。

    可在消息量大，追求高吞吐量并允许消息丢失的情况下使用该方式。

    - 入参描述：

      | 参数名 | 类型    | 是否必须 | 默认值 | 值范围 | 说明         |
            | ------ | ------- | -------- | ------ | ------ | ------------ |
      | msg    | Message | 是       |        |        | 待投递的消息 |

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      InterruptedException - 发送线程中断。

28. sendOneway

    `public void sendOneway(Message msg, MessageQueue mq)`

    向指定队列以oneway形式发送消息，broker不会响应任何执行结果，和[UDP](https://en.wikipedia.org/wiki/User_Datagram_Protocol)
    类似。它具有最大的吞吐量但消息可能会丢失。

    可在消息量大，追求高吞吐量并允许消息丢失的情况下使用该方式。

    - 入参描述：

      | 参数名 | 类型         | 是否必须 | 默认值 | 值范围 | 说明             |
            | ------ | ------------ | -------- | ------ | ------ | ---------------- |
      | msg    | Message      | 是       |        |        | 待投递的消息     |
      | mq     | MessageQueue | 是       |        |        | 待投递的消息队列 |

    - 返回值描述：
      void

    - 异常描述：
      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      InterruptedException - 发送线程中断。

29. sendOneway

    `public void sendOneway(Message msg, MessageQueueSelector selector, Object arg)`

    向通过`MessageQueueSelector`
    计算出的队列以oneway形式发送消息，broker不会响应任何执行结果，和[UDP](https://en.wikipedia.org/wiki/User_Datagram_Protocol)
    类似。它具有最大的吞吐量但消息可能会丢失。

    可在消息量大，追求高吞吐量并允许消息丢失的情况下使用该方式。

    - 入参描述：

      | 参数名   | 类型                 | 是否必须 | 默认值 | 值范围 | 说明                         |
            | -------- | -------------------- | -------- | ------ | ------ | ---------------------------- |
      | msg      | Message              | 是       |        |        | 待发送的消息。               |
      | selector | MessageQueueSelector | 是       |        |        | 队列选择器。                 |
      | arg      | Object               | 否       |        |        | 供队列选择器使用的参数对象。 |

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - broker不存在或未找到；namesrv地址为空；未找到topic的路由信息等客户端异常。<br>
      RemotingException - 网络异常。<br>
      InterruptedException - 发送线程中断。

30. shutdown

    `public void shutdown()`

    关闭当前生产者实例并释放相关资源。

    - 入参描述：

      无。

    - 返回值描述：

      void

    - 异常描述：

31. start

    `public void start()`

    启动生产者实例。在发送或查询消息之前必须调用此方法。它执行了许多内部初始化，比如：检查配置、与namesrv建立连接、启动一系列心跳等定时任务等。

    - 入参描述：

      无。

    - 返回值描述：

      void

    - 异常描述：

      MQClientException - 初始化过程中出现失败。

32. viewMessage

    `public MessageExt viewMessage(String offsetMsgId)`

    根据给定的msgId查询消息。

    - 入参描述：

      | 参数名      | 类型   | 是否必须 | 默认值 | 值范围 | 说明        |
            | ----------- | ------ | -------- | ------ | ------ | ----------- |
      | offsetMsgId | String | 是       |        |        | offsetMsgId |

    - 返回值描述：

      返回`MessageExt`，包含：topic名称，消息题，消息ID，消费次数，生产者host等信息。

    - 异常描述：

      RemotingException - 网络层发生错误。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 线程被中断。<br>
      MQClientException - 生产者状态非Running；msgId非法等。

33. viewMessage

    `public MessageExt viewMessage(String topic, String msgId)`

    根据给定的msgId查询消息，并指定topic。

    - 入参描述：

      | 参数名 | 类型   | 是否必须 | 默认值 | 值范围 | 说明      |
            | ------ | ------ | -------- | ------ | ------ | --------- |
      | msgId  | String | 是       |        |        | msgId     |
      | topic  | String | 是       |        |        | topic名称 |

    - 返回值描述：

      返回`MessageExt`，包含：topic名称，消息题，消息ID，消费次数，生产者host等信息。

    - 异常描述：

      RemotingException - 网络层发生错误。<br>
      MQBrokerException - broker发生错误。<br>
      InterruptedException - 线程被中断。<br>
      MQClientException - 生产者状态非Running；msgId非法等。

# 权限控制

----

## 1.权限控制特性介绍

权限控制（ACL）主要为RocketMQ提供Topic资源级别的用户访问控制。用户在使用RocketMQ权限控制时，可以在Client客户端通过
RPCHook注入AccessKey和SecretKey签名；同时，将对应的权限控制属性（包括Topic访问权限、IP白名单和AccessKey和SecretKey签名等）设置在distribution/conf/plain_acl.yml的配置文件中。Broker端对AccessKey所拥有的权限进行校验，校验不过，抛出异常；
ACL客户端可以参考：**org.apache.rocketmq.example.simple**包下面的**AclClient**代码。

## 2. 权限控制的定义与属性值

### 2.1权限定义

对RocketMQ的Topic资源访问权限控制定义主要如下表所示，分为以下四种

| 权限   | 含义            |
|------|---------------|
| DENY | 拒绝            |
| ANY  | PUB 或者 SUB 权限 |
| PUB  | 发送权限          |
| SUB  | 订阅权限          |

### 2.2 权限定义的关键属性

| 字段                         | 取值                           | 含义                 |
|----------------------------|------------------------------|--------------------|
| globalWhiteRemoteAddresses | \*;192.168.\*.\*;192.168.0.1 | 全局IP白名单            |
| accessKey                  | 字符串                          | Access Key         |
| secretKey                  | 字符串                          | Secret Key         |
| whiteRemoteAddress         | \*;192.168.\*.\*;192.168.0.1 | 用户IP白名单            |
| admin                      | true;false                   | 是否管理员账户            |
| defaultTopicPerm           | DENY;PUB;SUB;PUB\            | SUB                | 默认的Topic权限         |
| defaultGroupPerm           | DENY;PUB;SUB;PUB\            | SUB                | 默认的ConsumerGroup权限 |
| topicPerms                 | topic=权限                     | 各个Topic的权限         |
| groupPerms                 | group=权限                     | 各个ConsumerGroup的权限 |

具体可以参考**distribution/conf/plain_acl.yml**配置文件

## 3. 支持权限控制的集群部署

在**distribution/conf/plain_acl.yml**配置文件中按照上述说明定义好权限属性后，打开**aclEnable**
开关变量即可开启RocketMQ集群的ACL特性。这里贴出Broker端开启ACL特性的properties配置文件内容：

```
brokerClusterName=DefaultCluster
brokerName=broker-a
brokerId=0
deleteWhen=04
fileReservedTime=48
brokerRole=ASYNC_MASTER
flushDiskType=ASYNC_FLUSH
storePathRootDir=/data/rocketmq/rootdir-a-m
storePathCommitLog=/data/rocketmq/commitlog-a-m
autoCreateSubscriptionGroup=true
## if acl is open,the flag will be true
aclEnable=true
listenPort=10911
brokerIP1=XX.XX.XX.XX1
namesrvAddr=XX.XX.XX.XX:9876
```

## 4. 权限控制主要流程

ACL主要流程分为两部分，主要包括权限解析和权限校验。

### 4.1 权限解析

Broker端对客户端的RequestCommand请求进行解析，拿到需要鉴权的属性字段。
主要包括：
（1）AccessKey：类似于用户名，代指用户主体，权限数据与之对应；
（2）Signature：客户根据 SecretKey 签名得到的串，服务端再用SecretKey进行签名验证；

### 4.2 权限校验

Broker端对权限的校验逻辑主要分为以下几步：
（1）检查是否命中全局 IP 白名单；如果是，则认为校验通过；否则走 2；
（2）检查是否命中用户 IP 白名单；如果是，则认为校验通过；否则走 3；
（3）校验签名，校验不通过，抛出异常；校验通过，则走 4；
（4）对用户请求所需的权限 和 用户所拥有的权限进行校验；不通过，抛出异常；
用户所需权限的校验需要注意已下内容：
（1）特殊的请求例如 UPDATE_AND_CREATE_TOPIC 等，只能由 admin 账户进行操作；
（2）对于某个资源，如果有显性配置权限，则采用配置的权限；如果没有显性配置权限，则采用默认的权限；

## 5. 热加载修改后权限控制定义

RocketMQ的权限控制存储的默认实现是基于yml配置文件。用户可以动态修改权限控制定义的属性，而不需重新启动Broker服务节点。

## 6. 权限控制的使用限制

(1)如果ACL与高可用部署(Master/Slave架构)同时启用，那么需要在Broker Master节点的distribution/conf/plain_acl.yml配置文件中
设置全局白名单信息，即为将Slave节点的ip地址设置至Master节点plain_acl.yml配置文件的全局白名单中。

(2)如果ACL与高可用部署(多副本Dledger架构)同时启用，由于出现节点宕机时，Dledger Group组内会自动选主，那么就需要将Dledger
Group组
内所有Broker节点的plain_acl.yml配置文件的白名单设置所有Broker节点的ip地址。

## 7. ACL mqadmin配置管理命令

### 7.1 更新ACL配置文件中“account”的属性值

该命令的示例如下：

sh mqadmin updateAclConfig -n 192.168.1.2:9876 -b 192.168.12.134:10911 -a RocketMQ -s 1234567809123
-t topicA=DENY,topicD=SUB -g groupD=DENY,groupB=SUB

说明：如果不存在则会在ACL Config YAML配置文件中创建；若存在，则会更新对应的“accounts”的属性值;
如果指定的是集群名称，则会在集群中各个broker节点执行该命令；否则会在单个broker节点执行该命令。

| 参数  | 取值                        | 含义                                |
|-----|---------------------------|-----------------------------------|
| n   | eg:192.168.1.2:9876       | namesrv地址(必填)                     |
| c   | eg:DefaultCluster         | 指定集群名称(与broker地址二选一)              |
| b   | eg:192.168.12.134:10911   | 指定broker地址(与集群名称二选一)              |
| a   | eg:RocketMQ               | Access Key值(必填)                   |
| s   | eg:1234567809123          | Secret Key值(可选)                   |
| m   | eg:true                   | 是否管理员账户(可选)                       |
| w   | eg:192.168.0.*            | whiteRemoteAddress,用户IP白名单(可选)    |
| i   | eg:DENY;PUB;SUB;PUB\      | SUB                               | defaultTopicPerm,默认Topic权限(可选)         |
| u   | eg:DENY;PUB;SUB;PUB\      | SUB                               | defaultGroupPerm,默认ConsumerGroup权限(可选) |
| t   | eg:topicA=DENY,topicD=SUB | topicPerms,各个Topic的权限(可选)         |
| g   | eg:groupD=DENY,groupB=SUB | groupPerms,各个ConsumerGroup的权限(可选) |

### 7.2 删除ACL配置文件里面的对应“account”

该命令的示例如下：

sh mqadmin deleteAccessConfig -n 192.168.1.2:9876 -c DefaultCluster -a RocketMQ

说明：如果指定的是集群名称，则会在集群中各个broker节点执行该命令；否则会在单个broker节点执行该命令。
其中，参数"a"为Access Key的值，用以标识唯一账户id，因此该命令的参数中指定账户id即可。

| 参数  | 取值                      | 含义                   |
|-----|-------------------------|----------------------|
| n   | eg:192.168.1.2:9876     | namesrv地址(必填)        |
| c   | eg:DefaultCluster       | 指定集群名称(与broker地址二选一) |
| b   | eg:192.168.12.134:10911 | 指定broker地址(与集群名称二选一) |
| a   | eg:RocketMQ             | Access Key的值(必填)     |

### 7.3 更新ACL配置文件里面中的全局白名单

该命令的示例如下：

sh mqadmin updateGlobalWhiteAddr -n 192.168.1.2:9876 -b 192.168.12.134:10911 -g 10.10.154.1,10.10.154.2

说明：如果指定的是集群名称，则会在集群中各个broker节点执行该命令；否则会在单个broker节点执行该命令。
其中，参数"g"为全局IP白名的值，用以更新ACL配置文件中的“globalWhiteRemoteAddresses”字段的属性值。

| 参数  | 取值                         | 含义                   |
|-----|----------------------------|----------------------|
| n   | eg:192.168.1.2:9876        | namesrv地址(必填)        |
| c   | eg:DefaultCluster          | 指定集群名称(与broker地址二选一) |
| b   | eg:192.168.12.134:10911    | 指定broker地址(与集群名称二选一) |
| g   | eg:10.10.154.1,10.10.154.2 | 全局IP白名单(必填)          |

### 7.4 查询集群/Broker的ACL配置文件版本信息

该命令的示例如下：

sh mqadmin clusterAclConfigVersion -n 192.168.1.2:9876 -c DefaultCluster

说明：如果指定的是集群名称，则会在集群中各个broker节点执行该命令；否则会在单个broker节点执行该命令。

| 参数  | 取值                      | 含义                   |
|-----|-------------------------|----------------------|
| n   | eg:192.168.1.2:9876     | namesrv地址(必填)        |
| c   | eg:DefaultCluster       | 指定集群名称(与broker地址二选一) |
| b   | eg:192.168.12.134:10911 | 指定broker地址(与集群名称二选一) |

### 7.5 查询集群/Broker的ACL配置文件全部内容

该命令的示例如下：

sh mqadmin getAccessConfigSubCommand -n 192.168.1.2:9876 -c DefaultCluster

说明：如果指定的是集群名称，则会在集群中各个broker节点执行该命令；否则会在单个broker节点执行该命令。

| 参数  | 取值                      | 含义                   |
|-----|-------------------------|----------------------|
| n   | eg:192.168.1.2:9876     | namesrv地址(必填)        |
| c   | eg:DefaultCluster       | 指定集群名称(与broker地址二选一) |
| b   | eg:192.168.12.134:10911 | 指定broker地址(与集群名称二选一) |

**特别注意**开启Acl鉴权认证后导致Master/Slave和Dledger模式下Broker同步数据异常的问题，
在社区[4.5.1]版本中已经修复，具体的PR链接为：https://github.com/apache/rocketmq/pull/1149；