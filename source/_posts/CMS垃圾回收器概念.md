---

layout: CMS垃圾回收器概念

title: CMS垃圾回收器概念

tags: GC

categories: Web

top: 39

path: /article/1717618917

abbrlink: 1717618917

date: 2023-05-20 23:21:21


---

# CMS垃圾回收器概念

GC Roots 是 GC Root的集合，本质上是一组必须活跃的对象引用，主要包含以下几种类型：

1. 虚拟机栈中的引用对象：每个线程的虚拟机栈中的局部变量表中的引用。这些引用可能是方法的参数、局部变量或临时状态。
2. 方法区中的类静态属性引用对象：所有加载的类的静态字段。静态属性是类级别的，因此它们在整个Java虚拟机中是全局可访问的。
3. 方法区中的常量引用对象：方法区中的常量池（例如字符串常量池）中的引用。
4. 本地方法栈中的JNI引用：由 Java本地接口（JNI）代码创建的引用，例如，Java代码调用了本地 C/C++库。
5. 活跃的 Java线程**：**每个执行中的Java线程本身也是一个GC Root。
6. 同步锁持有的对象：被线程同步持有的对象。
7. Java虚拟机内部的引用：比如基本数据类型对应的Class对象，一些常见的异常对象（如NullPointerException、OutOfMemoryError）的实例，系统类加载器。
8. 反射引用的对象：通过反射API持有的对象。
9. 临时状态：例如，从Java代码到本地代码的调用。

![image-20240626171143448](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261711524.png)

## **1. 三色标记法**

在垃圾收集器中，主要采用三色标记算法来标记对象的可达性：

白色：表示对象尚未被访问。初始状态时，所有的对象都被标记为白色。

灰色：表示对象已经被标记为存活，但其引用的对象还没有全部被扫描。灰色对象可能会引用白色对象。

黑色：表示对象已经被标记为存活，并且该对象的所有引用都已经被扫描过。黑色对象不会引用任何白色对象。

三色标记算法的工作流程大致如下：

1. 初始化时，所有对象都标记为白色。
2. 将所有的 GC Roots 对象标记为灰色，并放入灰色集合。
3. 从集合中选择一个灰色对象，将其标记为黑色，并将其引用的所有白色对象标记为灰色，然后放入灰色集合。
4. 重复步骤3，直到灰色集合为空。
5. 最后，所有黑色对象都是活跃的，白色对象都是垃圾。

**2. 卡表**

对于分代垃圾回收器，势必存在一个跨代引用的问题，通常会使用一种名为记忆集（Remembered
Set）的数据结构，它是一种用于记录从非收集区指向收集区的指针集合的数据结构。

而卡表就是最常用的一种记忆集，它是一个字节数组，用于记录堆内存的映射关系，下面是 HotSpot虚拟机默认的卡表标记逻辑：

~~~java
// >> 9 代表右移 9位，即 2^9 = 512 字节
CARD_TABLE[this address >> 9] = 0;
~~~

每个元素都对应着其标识的内存区域中一块特定大小的内存块，这个内存块叫做“卡页（Card
Page）”。因为卡页代表的是一个区域，所以可能存在很多对象，只要有一个对象存在跨代引用，就把数组的值设为1，称该元素“变脏（Dirty）”，该卡页叫“脏页（Dirty
Page）”，如下：

~~~java
// >> 9 代表右移 9位，即2^9=512
CARD_TABLE[this address >> 9] = 1;
~~~

当垃圾回收时，只要筛选卡表中有变脏的元素，即数组值为 1，就能判断出其对应的内存区域存在对象跨代引用，卡表和卡页的关系如下图：

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261717749.webp)

**3. 写屏障**

在 HotSpot虚拟机中，写屏障本质上是引用字段被赋值这个事件的一个环绕切面（Around
AOP），即一个引用字段被赋值的前后可以为程序提供额外的动作（比如更新卡表），写屏障分为：前置写屏障（Pre-Write-Barrier）和后置写屏障（Post-Write-Barrier）2种类型。

**CMS回收过程**

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261718353.webp)

从整体上看，CMS 回收垃圾主要包含 5个步骤（网上很多 4，6，7个步骤的版本，其实都大差不差，没有本质上的差异）：

1. Initial Mark（初始标记）
2. Concurrent Marking（并发标记）
3. Remark（重新标记）
4. Concurrent Sweep（并发清除）
5. Resetting（重置）

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261719174.webp)

## **1. 初始标记**

初始标记阶段会 Stop The World（STW），即所有的应用线程（也叫 mutator线程）被挂起。

该阶段主要任务是：枚举出 GC Roots以及标识出 GC Roots直接关联的存活对象，包括那些可能从年轻代可达的对象。

那么，GC Roots是如何被枚举的？GC Roots的直接关联对象是什么？为什么需要 STW？

**1.1 GC Roots是如何被枚举的？**

通过上文对 GC Roots的描述可知，作为 GC Roots的对象类型有很多种，遍及 JVM中的多个区域，对于现如今这种大内存的
VM，如果需要临时去扫描各区域来获取 GC Roots，那将是很大的一个工程量，因此，JVM采用了一种名为 OopMap（Object-Oriented
Programming Map）的数据结构，它用于在垃圾收集期间快速地定位和更新堆中的对象引用（OOP，Object-Oriented Pointer）。

OopMap是在 JVM在编译期间生成的，主要作用是提供一个映射，通过这个映射垃圾收集器可以知道在特定的程序执行点（如safepoint）哪些位置（比如在栈或寄存器中）存放着指向堆中对象的引用，这样就可以快速定位
GC Roots。

OopMap的优点：

1. 提高效率：OopMap使得垃圾收集器能够快速准确地找到和更新所有的对象引用，从而减少垃圾收集的时间。
2. 减少错误：手动管理对象引用的位置容易出错，OopMap提供了一种自动化的方式来追踪这些信息。
3. 便于优化：由于 OopMap是在编译时生成的，编译器可以进行优化，比如减少需要记录的引用数量，从而减少垃圾收集的开销。

在 HotSpot虚拟机中，OopMap是实现精确垃圾收集的关键组件之一。

**1.2 GC Roots的直接关联对象是什么？**

所谓直接关联对象就是 GC Root直接引用的对象，下面以一个示例来说明，如下代码：

```java
public class AssociatedObjectExample {

  public static void main(String[] args) {
    // Associated 是 GC Root obj 直接关联
    Associated obj = new Associated();
    // BigObject是 GC Root obj 的间接关联的对象，BigObject是一个大对象，直接分配到老年代
    ((Associated) obj).bObj = new BigObject();
  }

  static class Associated {
    // 与Associated对象直接关联的对象
    BigObject bObj;
  }

  static class BigObject {
    // 其它代码
  }
}
```

上述例子中，obj是一个 GC Root，Associated对象就是它的直接关联对象，bObj是一个 GC Root，BigObject对象是它的直接关联对象，obj可以通过
Associated对象间接关联 到 BigObject对象，但 BigObject对象不是 obj的直接关联对象，而是间接关联对象。 整个关联关系可以描绘成下图：

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261721045.webp)

### **1.3 为什么需要 STW？**

为什么初始标记阶段需要 Stop The World？这里主要归纳成两个原因：

1. 确定 GC Roots集合：初始标记阶段的主要任务是识别出所有的 GC
   Roots，这是后续并发标记阶段的起点。在多线程运行的环境中，如果应用线程和垃圾回收线程同时运行，应用线程可能会改变对象引用关系，导致
   Roots集合不准确。因此，需要暂停应用线程，以确保 GC Roots的准确性和一致性。

2. 避免并发问题：在初始标记阶段，垃圾收集器需要更新一些共享的数据结构，例如标记位图或者引用队列。如果应用线程在此时运行，可能会引入并发修改的问题，导致数据不一致。STW可以避免这种情况的发生。

**2. 并发标记**

这里的并发是指应用线程和 GC线程可以并发执行。

在并发标记阶段主要完成 2个事情：

1. 遍历对象图，标记从 GC Roots可以追踪到所有可达的存活对象；
2. 处理并发修改

因为应用线程仍在继续工作，因此老年代的对象可能会发生以下几种变化：

a. 新生代的对象晋升到老年代；

b. 直接在老年代分配对象；

c. 老年代对象的引用关系发生变更；

为了防止这些并发修改被遗漏，CMS 使用了后置写屏障机制，确保这些更改会被记录在“卡表”中，同时将相应的卡表条目标记为脏（Dirty），以便后续处理。

如下图：从 GC Roots追溯所有可达对象，并将它们修改为已标记，即黑色。

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261721224.webp)

当老年代中，D 到 E到引用被修改时，就会触发写屏障机制，最终 E就会被写进脏页，如下图：

![图片](https://mmbiz.qpic.cn/mmbiz_png/1oRAoFf3XpKBnVEVV8gd2C9kjIDScG1RjicnAZ4GwUH9DGEfusvbz3vibz5Q8zibJ9BNGEqYxlmda7W7zqRcm4Onw/640?wx_fmt=png&tp=webp&wxfrom=5&wx_lazy=1&wx_co=1)

并发标记会出现对象可达性误判问题，如下图：假如对象 D对象被标记成黑色，E对象被标记为灰色（图左半部分），这时，工作线程将
E对象修改成不再指向F，并将 D对象指向 F对象（图右半部分），按照三色标记算法，D对象为黑色，不会再往下追溯，所以
F对象就无法被标记从而变成垃圾，“存活”对象凭空消失了，这是很可怕的问题，那么 CMS是如何解决这种问题的呢？

![图片](https://mmbiz.qpic.cn/mmbiz_png/1oRAoFf3XpIgVBzMicLo3ltUlt87SbtNHLDjicDUNclicPXgtqQgEL4WPopChoJWsksZYAkibibMKFpqR8ianTibWiawNA/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1&wx_co=1)

解决这种问题，通常有两种方案：

1. 增量更新（Incremental Update）

当新增黑色对象指向白色对象关系时（D->F），需要记录这次新增，等并发扫描结束后，将这些黑色的对象作为 GC
Root，重新扫描一次，也就是把这些黑色对象看成灰色对象，它们指向的白色对象就可以被正常标记。CMS采取的就是这种方式。

2. 原始快照（Snapshot At The Beginning，SATB）

当删除灰色对象指向白色对象关系时（E->F），需要记录这次删除，等并发扫描结束后，将这些灰色的对象作为 GC Root，按照删除 E对象指向
F对象前一刻的快照（也就是E->F 还是可达的）重新扫描一次，即不管关系删除与否，都会按照删除前那一刻快照的对象图来进行搜索标记。G1，Shenandoah采取的是这种方式。

## **3. 重新标记**

重新标记阶段也会 Stop The World，即挂起所有的应用线程，该阶段主要完成事情是：

1. 并发预清理：在重新标记阶段之前，CMS可能会执行一个可选的并发预清理步骤，以尽量减少重新标记阶段的工作量。(
   该过程在很多文章中会单独成一个大步骤讲解)
2. 修正标记结果：由于在并发标记阶段导致的并发修改，导致漏标，错标，因此需要暂停应用线程（STW），确保修正这些标记结果。
3. 处理卡表：检查并发标记阶段修改的这些脏卡，并重新标记引用的对象，以确保所有可达对象都被正确识别。
4. 处理最终可达对象：处理那些在并发标记阶段被识别出的“最终可达”（Finalizable）对象。这些对象需要执行它们的
   finalize方法，finalize方法可能会使对象重新变为可达状态。
5. 处理弱引用、软引用、幻象引用等：处理各种不同类型的引用，确保它们按照预期被处理。例如，弱引用在
   GC后会被清除，软引用在内存不足时会被清除，而幻象引用则在对象被垃圾收集器回收时被放入引用队列。

## **4. 并发清除**

这里的并发也是指应用线程和 GC线程可以并发执行，并发清除阶段主要完成 2个事情：

1. 清除并发标记阶段标记为死亡的对象；
2. 并发清除结束后，CMS 会利用空闲列表（free-list）将未被标记的内存（即垃圾对象占据的内存）收集起来，组成一个空闲列表，用于新对象的内存分配；

## **5. 重置**

清理和重置 CMS收集器的内部数据结构，为下一次垃圾回收做准备。

到此，回收过程就分析完毕，接下来总结下 CMS的优点和缺点。

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261723538.webp)

**CMS优点**

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261723551.webp)

**1. 低停顿时间**

相对 Serial，Serial Old，ParNew，Parallel Scavenge 4款收集器，CMS收集器的主要优势是减少垃圾收集时的停顿时间，特别是减少了Full
GC的停顿时间，这对于延迟敏感的应用程序非常有利。

**2. 并发收集**

CMS在回收过程中，应用线程和 GC线程可以并发执行，从而减少了垃圾收集对应用程序的影响。

**3. 适合多核处理器**

由于CMS利用了并发执行，它能够更好地利用现代多核处理器的能力，将垃圾收集的工作分散到多个CPU核心。

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261723538.webp)

**CMS缺点**

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261723551.webp)

## **1. 浮动垃圾**

在并发清除阶段，因为应用线程可以并发工作，可能会产生垃圾，这些垃圾在当前 GC无法处理，需要到下一次 GC才能进行处理，因此，这些垃圾就叫做“浮动垃圾”。

## **2. 并发失败**

JDK5 默认设置下，当老年代使用了68%的空间后就会被激活 CMS回收，从JDK 6开始，垃圾回收启动阈值默认提升至92%，我们可以通过 -XX:
CMSInitiatingOccupancyFraction 参数自行调节。

如果阈值是 68%，可能导致空间没有完全利用，频繁产生 GC，如果是92%，又会更容易面临另一种风险，要是预留的内存无法满足程序分配新对象的需要，就会出现一次
Concurrent Mode Failure（并发失败），因此会引发 FullGC。

这时候虚拟机将不得不启动后备预案：冻结用户线程的执行，临时启用Serial Old收集器来重新进行老年代的垃圾收集，但这样停顿时间就很长了。

## **3. 内存碎片**

因为 CMS采用的是标记-清理算法，当清理之后就会产生很多不连续的内存空间，这就叫做内存碎片。如果老年代无法使用连续空间来分配对象，就会出发
Full GC。为了解决这个问题，CMS收集器提供了 -XX：+UseCMS-CompactAtFullCollection 参数进行碎片压缩整理，参数默认是开启的，不过
从JDK 9开始废弃。

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261723538.webp)

**总结**

![图片](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406261723551.webp)

本文不仅讲解了 CMS回收器，更是铺垫了很多 GC相关的基础知识，比如 安全点，三色标记法，卡表，写屏障。

CMS 是 Concurrent Mark Sweep 的简称，中文翻译为并发标记清除，它的目标是减少垃圾回收时应用线程的停顿时间，并且实现应用线程和
GC线程并发执行。

CMS 用于老年代的垃圾回收，使用的是标记-清除算法。通过 -XX:+UseConMarkSweepGC 参数即可启动 CMS收集器。

CMS 主要包含：初始标记，并发标记，重新标记，并发清除，重置 5个过程。

CMS 收集器使用三色标记法来标记对象，采用写屏障，卡表和脏页的方式来防止并发标记中修改的引用被漏标。

CMS 收集器有 3大缺点：浮动垃圾，并发失败以及内存碎片。

尽管 CMS收集器已经被官方废弃了，但是它这种优化思路值得我们日常开发中借鉴。