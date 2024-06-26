---

layout: 为什么G1能够替代CMS回收器

title: 为什么G1能够替代CMS回收器

tags: GC

categories: Web

top: 40

path: /article/1717418917

abbrlink: 1717418917

date: 2023-05-20 22:21:21


---

# 为什么G1能够替代CMS回收器？

## **01 简介**

G1 是 Garbage First 的简称，最初起源于 Sun在2004年发布的一篇 G1学术论文 ，2012年9月，JDK 7 Update 4 发布，G1正式投入商业使用，耗时
8年之久。

G1收集器是一款面向[服务器](https://cloud.tencent.com/act/pro/promotion-cvm?from_column=20065&from=20065)
的垃圾收集器，采用标记整理算法，用于大内存的多处理器计算机，目标是实现低延时垃圾回收，从 2017年9月发布的 JDK9 开始，G1
就已经成为了默认的垃圾收集器。

Oracle官方给 G1的定位是用来替代 CMS收集器，这就是为什么很多文章会把 G1 和 CMS进行对比的根本原因。

## **02 堆内存结构**

和以往的垃圾收集器不一样，G1尽管依然保留了年轻代和老年代的概念，
但是它们已经变成了一个逻辑上的概念，G1的堆内存被切分成若干个大小（1M ～ 32M）相同且不连续的 Region，包括 4种类型：

1. Eden Region，Eden区域
2. Survivor Region，存活区域
3. Old Generation Region，老年代区域
4. Humongous Region，大对象区域

具体的堆内存结构如下图：

![图片](https://developer.qcloudimg.com/http-save/4096205/1d84e4529f19529ea9ae46dc572a9257.webp)

图片

Eden 区和 Survivor区的组合就是通常说的年轻代。

Humongous是 G1 提出来的一个新区域，专门用于存储大对象，这里的大对象是指内存占用大于等于单个 Region一半大小的对象。

比如，假设每个 Region是 2M，如果当前对象是 1M，那么它就是一个大对象，如果当前对象的大小是 3M，超过 1个 Region的范围， 那么
G1会寻找连续的 2个 Humongous 区域来存放它，如果找不到连续的空间存放当前对象， G1可能会触发一次垃圾回收来释放空间，或者进行内存压缩操作。

参数-XX:G1HeapRegionSize可以用来设置Region的大小，-XX:G1HeapRegionSize=4M，代表每个 Region的大小是 4M。

从 JVM运行时内存结构的角度看，G1 回收对象是整个堆内存，如下图：

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261701923.webp)

图片

Region的特别说明：一个 Region可以是 Eden，Survivor，Old，Humongous 4种角色中的任意一种。在垃圾回收的过程中，存活对象可以从一个
Region 移动到另一个 Region， 比如，从 Eden区 移动到 Survivor区，从 Survivor区移动到老年代，所以，每个
Region具体属于哪一种角色也是动态变化的。理解这一点，可以帮助我们更好地领会下文 G1的回收原理。

## **03 几个重要技术点**

在 CMS收集器这篇文章中，我们分析过三色标记法，记忆集，卡表，可达性分析等重要技术，作为 CMS的替换者和继承人，G1也使用了类似的技术点。

在 CMS收集器中，存在跨代引用的问题，在 G1收集器中也存在同样的问题：跨区域引用，可能因为 G1堆内存有很多的
Region，所以这个跨区域引用的问题似乎表现地更明显。

#### **什么是跨区域引用？**

如下图：Eden区的 A对象引用 Old区的 B对象，这是一种跨区域引用，Old区的 D对象指向 Eden区域的 E对象，这也是一种跨区域引用。

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261702786.webp)

#### **跨区域引用产生的问题**

对于上图中 Eden区域（年轻代）A对象指向老年代 B对象，即便 Young GC把 A对象回收了，程序还能正常运行，随着 A->
B引用链的断开，B对象最终也可能因为无法被标记被回收，这种行为是可以接受的。但是，对于老年代 D对象指向 Eden区域（年轻代）E对象的场景，因为老年代
D对象是一个活跃对象，它是一个 GC Root， 所以，D对象直接关联的 E对象也应该是存活对象，假如 E对象被 Young
GC掉，就会出现存活的对象无故消失，该如何避免呢 ？

方法1：在 Young GC时扫描所有的老年代，找出指向 E对象的引用，因为 G1是用于大内存的垃圾回收器，如果全局扫描老年代区域，将会是一个很耗时的操作，显然和
G1的设计初衷相违背。

方法2：把老年代指向年轻代（A -> B）的引用关系记录起来，GC时只要扫描这些记录数据，而 G1就是采用这种方式。在 G1中，
这种关系数据叫做记忆集（Remembered Set，RSet，RS），对于这里 A -> B里面的 B，G1也有专门的术语叫收集集（Collection Set）。

#### **收集集（Collection Set）**

在 G1中，收集集（Collection Set，CSet，CS）是指那些将要被清理以回收空间的源区域（Regions）的集合。根据垃圾回收的类型，收集集包含不同种类的区域：

Young-Only阶段：在这个阶段，收集集只包含年轻代中的区域，以及那些可能被回收的大对象区域中的对象。

空间回收阶段：在这个阶段，收集集包括年轻代区域、可能被回收的大对象区域中的对象，以及从候选收集集区域集合中选出的一些老年代区域。

候选收集集区域（Collection Set Candidate Regions）是指那些在空间回收阶段很可能被回收的区域。G1
会根据区域存活对象的数量以及和其他区域的连接性两个指标进行选择。存活对象少，连接性低的区域会优先成为候选收集集区域，这种选择的目的是为了优化垃圾回收过程的效率，减少暂停时间，同时最大化回收空间。

#### **记忆集（Remembered Set）**

在 G1中，记忆集（Remembered Set，RSet，RS）本质上是一种哈希表，它用于跟踪那些包含指向收集集中对象的引用的位置，这些引用是通过
Cards Table（卡表）来管理。

因为 Region的角色（Eden，Survivor，Old，Humongous）是动态变化的，所以 G1会给每个 Region设置一个 RSet，RSet本质上是一种哈希表，Key是
Region的起始地址，Key对应的 Value是一个集合，里面存储的元素是卡表的索引号。

如下图：Eden是一个收集集，包含一个记忆集（RSet），RSet 指向了两个 Old区域。

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261704849.webp)

记忆集的作用，主要有 2点：

1. 为了防止整个堆作为GC Roots的扫描范围
2. 确保在垃圾回收过程中，当收集集中的对象被移动，所有指向这些对象的引用都能够更新，指向对象的新位置

#### **卡表**

卡表（Card Table）是记忆集的一种具体实现，每个 Region被分成了若干个大小为 512字节的连续内存区域，即卡表（Card Table），因为
Region的大小是 1～32M，所以每个 Region中卡表数量是 2～64个。

当一个老年代区域中的对象被修改，比如更新了一个引用字段指向一个年轻代对象时，JVM会使用写屏障（Write
Barrier）将相应的卡片标记为“脏”（Dirty）。在执行 Young GC时，G1会检查这些卡表并找出所有的脏卡片，然后只扫描这些脏卡片对应的内存区域，以更新老年代到年轻代的引用，避免每次
Young GC时都会扫描整个老年代。

如下图：假设 Region的大小为 1M，因此每个 Region就包含 2个卡表。对象D 指向对象E，对象 E所在的 Eden是一个收集集，它会包含一个
RSet，RSet里有一个 Entry（Key）指向对象 D所在的 Old区域的起始地址，这个 Key对应的 Value包含了卡表的信息。

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261705967.webp)

## **04 工作流程**

### **4.1 两条主线**

为了更好地讲解 G1回收过程，我特地整理了官方文档的两条主线（或者说两个维度）：回收过程 和 回收周期。

#### **4.1.1 回收过程**

回收过程是指 G1回收过程中会经历哪些具体的步骤，从全局上看，包括年轻代回收（Young GC），老年代并发标记周期（Concurrent Marking
Cycle），混合回收（Mixed GC）和 Full GC 4个过程。

而老年代并发标记周期（Concurrent Marking Cycle）又包含以下 5个过程：

1. Initial Marking（初始标记）
2. Root Region Scanning（根据扫描）
3. Concurrent Marking（并发标记）
4. Remark（重新标记）
5. Copying/Cleanup（清除垃圾）

从回收过程角度，G1工作流程可以抽象成如下示意图：

![图片](https://developer.qcloudimg.com/http-save/4096205/02a10b94f858d467c37b63a58ae37e7d.webp)

图片

严格意义上讲，Full GC并不能算是一个必需过程，它是 G1设计时需要尽量避免的，但因为这个点比较重要，所以还是把它放在过程中。

#### **4.1.2 回收周期**

回收周期是对应官方文档的“On a high level”，它是对回收过程更高一层的抽象，包括 Young-only phase 和 Space-reclamation phase
两个阶段。

Young-only phase：这里的“Young-only”是指垃圾收集器只会回收年轻代，该阶段主要完成回收过程中的 年轻代回收（Young GC） 和
老年代并发标记周期（Concurrent Marking Cycle） 两个过程。

Space-reclamation phase：空间回收阶段，该阶段会进行多次年轻代收集（Young GC）以及增量回收部分老年代，被称为混合收集（Mixed
GC）。当 G1判断继续回收老年代不足以释放更多的空间，或者停顿时间大于 MaxGCPauseMillis（默认
200ms）时，会退出该阶段。空间回收阶段对应回收过程中的混合回收（Mixed GC）。

从回收周期角度，G1的工作流程可以抽象成如下示意图：

![图片](https://developer.qcloudimg.com/http-save/4096205/ba5301989adf898e09dd4afdb334c16f.webp)

图片

扁平化后的示意图：

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261705715.webp)

图片

最后，我们从回收过程和回收周期两个维度进行对比，G1的工作流程可以抽象成如下示意图：

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261705670.webp)

图片

G1的实现细节比较难懂，但是我们可以通过上述两条主线，从整体上去把握 G1，接下来，我们将逐步来分析 G1的工作流程。

### **4.2 回收过程详解**

#### **4.2.1 年轻代回收**

年轻代回收，顾名思义就是对年轻代的回收，它是一个 Stop The World的过程，当 Eden区的剩余空间无法完成新对象的分配时会触发
Young GC，年轻代回收包含对 Eden区 和 Survivor区的回收， 具体表现为存活对象被复制或移动到一个或多个
Survivor区域，如果对象存活时间达到进入老年代（Old Generation）的阈值，对象将被提升到老年代。

G1 Young GC回收过程示意图如下：

![图片](https://developer.qcloudimg.com/http-save/4096205/85645fd5a5338657b7ef791fd1ac5a1c.webp)

图片

#### **4.2.2 老年代并发标记周期**

##### **Initial Mark（初始标记）**

初始标记阶段会 Stop The World（STW），但耗时很短，它是伴随 Young GC同步完成的。

初始标记主要完成 2件事情：

1. 标记 GC Roots直接关联的对象
2. 标记出所有的 survivor区（Root区）

下图为一个简单的初始标记过程示例：

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261705666.webp)

图片

**为什么初始标记会伴随 Young GC？**

最大的考虑是性能问题，这里给出两个具体的理由：

1. 减少停顿时间：Young GC会 Stop The World，而初始标记刚好借着这个停顿时间，做一些额外的标记工作，从而减少 STW的时间；
2. 提升效率：Young GC是回收年轻代，而初始标记是标记年轻代和老年代中存活的对象。两者结合，就可以把处理年轻代这个重叠的过程给复用了，提高垃圾收集的效率；

##### **Root Region Scanning（根区扫描）**

根区扫描主要是扫描 Survivor区指向老年代的引用。扫描线程和用户线程是并发执行的， 另外，该过程必须在下一个 Young
GC到来之前完成，主要原因是 Young GC会涉及到存活对象的在 Region间的移动， 因此，可能会改变 Survivor指向老年代的引用，从而影响数据的正确性。

##### **Concurrent Marking（并发标记）**

这里的并发是指 GC线程和用户线程可以并发执行，并发标记阶段的耗时会较长一些。

并发标记主要完成 3件事情：

1. 从 GC Root开始，对堆中所有对象进行可达性分析，确认需要回收的对象
2. 更新卡表
3. 标记空的 Region

并发标记示意图如下：

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261705571.webp)

图片

##### **Remark（重新标记）**

重新标记主要完成 2件事情：

1. 回收并发标记过程中的空 Region
2. 利用 Snapshot-At-The-Beginning （SATB） 修正并发标记中的数据

##### **Cleanup（并发清理）**

并发清除阶段主要完成 3件事情：

1. 对存活对象进行统计并完全释放空闲区域。（STW）
2. 清理记忆集（Remembered Sets）。（STW）
3. 重置空闲区域并将它们返回到空闲列表。（并发执行）

#### **4.2.3 混合回收**

当老年代的堆使用率达到参数 -XX:InitiatingHeapOccupancyPercent 设定阈值（默认是 45%）， 则触发混合回收，混合回收阶段会进行多次
Young GC 以及对部分老年代进行增量回收。

#### **4.2.4 Full GC**

Fu1l GC 是 G1最后的防护线，它本是 G1设计时需要尽量避免的，严格上说，不应该作为一个过程来讲，但是 Full
GC是实际生产中大家比较关注的问题，所以作为一个过程来分析。

G1 主要通过以下几个参数和指标来决定是否需要触发Full GC：

-XX:G1HeapWastePercent：堆中可以容忍的最大垃圾比例。如果在 Mixed GC之后，垃圾的比例超过了这个阈值，G1可能会触发 Full
GC来回收更多的空间。

-XX:G1MixedGCLiveThresholdPercent：当 Old区中的对象占用的比例超过多少时，这部分区域会被包含在 Mixed GC中，默认
85。如果这个比例设置得太低，可能会导致过多的 Old区域被包含在 Mixed GC中，进而增加GC的工作量和停顿时间，最终可能引发 Full GC。

-XX:G1MixedGCCountTarget：在开始进行 Full GC之前，可以执行 Mixed GC的最大次数。如果连续的 Mixed
GC没有有效地回收内存，达到这个次数限制后，G1可能会触发 Full GC。

-XX:G1ReservePercent：保留的堆内存的百分比，默认是10，作为一个缓冲区来减少 Full GC的发生。如果可用内存低于这个阈值，G1可能会触发
Full GC。

## **05 为什么 G1 能替代 CMS**

接下来，我们呼应文章标题：G1为什么能替代 CMS收集器？我觉得最核心的两个因素是：设计思想更好 以及 算法更优。

### **设计思想**

思想决定高度，对于垃圾回收器也一样，G1 的三个优秀的设计思想，为后面的垃圾收集器（ZGC）奠定了坚实的基础：

1. 基于 Region 的内存布局
2. 面向局部收集的设计思想
3. GC停顿时间和吞吐量的平衡

Region化整为零，面向局部收集的思想完全碾压了 CMS这种需要收集整个老年代的设计。

基于 Region可以同时兼顾年轻代和老年代的回收，而 CMS只能回收老年代。

基于 Region，因为回收的粒度更细，范围更小，使得 G1的停顿时间更加可预测。

实际生产中，并非全部是非此即彼的选择题，很多时候是即要…又要…，因此，CMS为了追求低延时，牺牲了吞吐量，这显然和这种即又场景格格不入。而
G1则吸取了 CMS的经验教训，尽量做到 GC停顿时间和吞吐量的平衡，它更符合当代大内存的场景需求。

### **算法**

CMS使用的是标记-清除算法，这种算法的最大缺点是产生内存碎片，当内存碎片过多，无法找到足够的连续空间来分配新对象，就会产生一次并发模式失败（Concurrent
Mode Failure），启动 Full GC，

而 G1采用的是标记-整理算法，在每次垃圾回收后会进行内存压缩，因此，不会产生内存碎片，便于新生对象的分配。

当然，还有其他一些的性能提升也促成了 G1能替换 CMS，这里就不一一列举了

## **06 总结**

因为 G1涉及的知识点太多，所以本文通过两条主线（回收过程和回收周期）进行讲解，作为普通的开发， 个人觉得能够把握
G1的整体流程和一些重要的技术点以及掌握重要的调优参数，就 OK了。

本文同时分析了 G1为什么能替代 CMS回收器，最核心是设计思想以及算法，其他的一些功能也多少有影响。

为了更好的阅读本文，建议先阅读《[肝了一周，彻底弄懂了 CMS收集器原理，这个轮子造的真值！](https://cloud.tencent.com/developer/tools/blog-entry?target=https%3A%2F%2Fmp.weixin.qq.com%2Fs%3F__biz%3DMzIwNDAyOTI2Nw%3D%3D%26mid%3D2247494932%26idx%3D1%26sn%3D1e0a7a74e947dd03967c36cc3270f8a1%26chksm%3D96c4c128a1b3483e78405fa2b1cf2f2f901b91593c56fc4d6ee086eb1b7c8a27e4d9be1fbf7d%26token%3D2016670857%26lang%3Dzh_CN%26scene%3D21%23wechat_redirect&source=article&objectId=2400306)
》这篇文章。

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261707194.webp)