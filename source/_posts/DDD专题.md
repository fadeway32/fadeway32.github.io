---

layout: DDD专题

title: DDD专题

tags: Web

categories: Web

top: 40

path: /article/1739608323

abbrlink: 1739608323

date: 2025-02-15 16:32:01


---

## DDD建模方法

![面试官：谈一下你对DDD的理解？我：马什么梅？](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502151629280.webp)

#### 用例分析法

用例分析法是领域建模最简单可行的方式。大致可以分为获取用例、收集实体、添加关联、添加属性、模型精化几个步骤。

1. 获取用例：提取领域规则描述
2. 收集实体：定位实体，
3. 添加关联：两个实体间用动词关联起来
4. 添加属性：获取实体属性
5. 模型精化：可选的步骤，可以用UML的泛华和组合来表达模型间的关系，同时可以做子领域的划分

#### 四色建模法

四色建模法源于《Java Modeling In Color With UML》，它是一种模型的分析和设计方法，通过把所有模型分为四种类型，帮助模型做到清晰、可追溯。

简单来说，四色关注的是某个人的角色在某个地点的角色用某个东西的角色做了某件事情。

![面试官：谈一下你对DDD的理解？我：马什么梅？](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502151629385.webp)

#### 事件风暴法

事件风暴法类似头脑风暴，简单来说就是谁在何时基于什么做了什么，产生了什么，影响了什么事情。

![面试官：谈一下你对DDD的理解？我：马什么梅？](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502151629339.png)

## 架构分层

区别于左图传统架构的分层，一般DDD分层会有一些变化。

Application：包含事件注册、业务逻辑等

Domain：聚合、实体、值对象

InfraStructure：基础设施封装、数据库访问等

![面试官：谈一下你对DDD的理解？我：马什么梅？](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502151629757.webp)

## 总结

DDD是一套完善的方法论，他能帮助我们合理的对系统进行架构设计，同时，好的模板应该是在不断的适应变化，而DDD也能帮助我们更快速更方便的支撑业务的发展。

**DDD 作用**

**统一思想**：统一项目各方业务、产品、开发对问题的认知，而不是开发和产品统一，业务又和产品统一从而产生分歧。

**边界分离**：领域模型与数据模型分离，用领域模型来界定哪些需求在什么地方实现，保持结构清晰。

**明确分工**：域模型需要明确定义来解决方方面面的问题，而针对这些问题则形成了团队分钟的理解。

**反映变化**：需求是不断变化的，因此我们的模型也是在不断的变化的。领域模型则可以真实的反映这些变化。

**DDD**概念

#### 实体

有唯一标志的核心领域对象，且这个标志在整个软件生命周期中都不会发生变化。这个概念和我们平时软件模型中和数据库打交道的Model实例比较接近，唯一不同的是DDD中这些实体会包含与该实体相关的业务逻辑，它是操作行为的载体

#### 值对象

依附于实体存在，通过对象属性来识别的对象，它将一些相关的实体属性打包在一起处理，形成一个新的对象。

举个栗子：比如用户实体，包含用户名、密码、年龄、地址，地址又包含省市区等属性，而将省市区这些属性打包成一个属性集合就是值对象。

#### 聚合

实体和值对象表现的是个体的能力，而我们的业务逻辑往往很复杂，依赖个体是无法完成的，这时候就需要多个实体和值对象一起协同工作，而这个协同的组织就是聚合。聚合是数据修改和持久化的基本单元，同一个聚合内要保证事务的一致性，所以在设计的时候要保证聚合的设计拆分到最小化以保证效率和性能。

#### 聚合根

也叫做根实体，一个特殊的实体，它是聚合的管理者，代表聚合的入口，抓住聚合根可以抓住整个聚合

#### 领域服务

有些领域的操作是一些动词，并不能简单的把他们归类到某个实体或者值对象中。这样的行为从领域中识别出来之后应该将它声明成一个服务，它的作用仅仅是为领域提供相应的功能。

#### 领域事件

在特定的领域由用户动作触发，表示发生在过去的事件。比如充值成功、充值失败的事件。

## DDD 架构

**经典四层架构**：

![img](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502151621091.png)

将领域模型和业务逻辑分离出来，并减少对基础设施、用户界面甚至应用层逻辑的依赖，因为它们不属业务逻辑。将一个夏杂的系统分为不同的层，每层都应该具有良好的内聚性，并且只依赖于比其自身更低的层。

传统分层架构的 基础设施层 位于底层，持久化和消息机制便位于该层。可将基础设施层中所有组件看作应用程序的低层服务，较高层与该层发生耦合以复用技术基础设施。即便如此，依然应避免核心的领域模型对象与基础设施层直接耦合。

**整洁架构**(洋葱架构)

在整洁架构里，同心圆代表应用软件的不同部分，从里到外依次是领域模型、领域服务、应用服务和最外围的容易变化的内容，比如用户界面和基础设施。

整洁架构最主要的原则是依赖原则，它定义了各层的依赖关系，越往里依赖越低，代码级别越高，越是核心能力。外圆代码依赖只能指向内圆，内圆不需要知道外圆的任何情况。

![img](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502151620039.png)

在洋葱架构中，各层的职能划分：

领域模型实现领域内核心业务逻辑，它封装了企业级的业务规则。领域模型的主体是实体，一个实体可以是一个带方法的对象，也可以是一个数据结构和方法集合。

领域服务实现涉及多个实体的复杂业务逻辑。应用服务实现与用户操作相关的服务组合与编排，它包含了应用特有的业务流程规则，封装和实现了系统所有用例。

最外层主要提供适配的能力，适配能力分为主动适配和被动适配。主动适配主要实现外部用户、网页、批处理和自动化测试等对内层业务逻辑访问适配。被动适配主要是实现核心业务逻辑对基础资源访问的适配，比如数据库、缓存、文件系统和消息中间件等。

红圈内的领域模型、领域服务和应用服务一起组成软件核心业务能力。

**CQRS架构(命令查询隔离架构)**

CQRS — Command Query Responsibility Segregation，故名思义是读写分离，就是将 command 与 query 分离的一种模式。

Command ：命令则是对会引起数据发生变化操作的总称，即我们常说的新增，更新，删除这些操作，都是命令。

Query：查询则和字面意思一样，即不会对数据产生变化的操作，只是按照某些条件查找数据。

Command 与 Query 对应的数据源可以公用一种数据源，也可以是互相独立的，即更新操作在一个数据源，而查询操作在另一个数据源上。

CQRS三种模式

（1）共享模型/共享存储：读写公用一种领域模型，读写模型公用一种。

（2）分离模型/共享存储：读写分别用不同的领域模型，读操作使用读领域模型，写操作使用写领域模型。

（3）分离模式/分离存储：也叫做事件源 (Event source) CQRS，使用领域事件保证读写数据的一致性。也就是当 command
系统完成数据更新的操作后，会通过领域事件的方式通知 query 系统。query 系统在接受到事件之后更新自己的数据源。

CQRS(读写操作分别使用不同的数据库)

![img](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502151620044.png)

**六边形架构**

六边形架构的核心理念是：应用是通过端口与外部进行交互的

下图的红圈内的核心业务逻辑（应用程序和领域模型）与外部资源（包括 APP、Web
应用以及数据库资源等）完全隔离，仅通过适配器进行交互。它解决了业务逻辑与用户界面的代码交错问题，很好地实现了前后端分离。六边形架构各层的依赖关系与整洁架构一样，都是由外向内依赖。

![img](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502151617916.png)

**DDD实践**

使用 COLA 架构构建，COLA
架构是一个整洁的，面向对象的，分层的，可扩展的应用架构，可以帮助降低复杂应用场景的系统熵值，提升系统开发和运维效率。不管是传统的分层架构、六边形架构、还是洋葱架构，都提倡以业务为核心，解耦外部依赖，分离业务复杂度和技术复杂度等，COLA
架构在此基础上融合了 CQRS、DDD、SOLID 等设计思想，形成一套可落地的应用架构。

## 组件构成

!(https://camo.githubusercontent.com/5bc83e0e0748584bbbe8d1881da783a3ff603fa1e9b4bcf934e6e124d789844d/68747470733a2f2f63646e2e6a7364656c6976722e6e65742f67682f73686979696e64617869616f6a69652f696d616765732f6564656e2d64656d6f2d636f6c612f636f6d706f6e656e742e706e67)

![68747470733a2f2f63646e2e6a7364656c6976722e6e65742f67682f73686979696e64617869616f6a69652f696d616765732f6564656e2d64656d6f2d636f6c612f636f6d706f6e656e742e706e67](https://gitee.com/fadeway32/fadeway32/raw/master/img/202502151628632.png)

- **eden-demo-cola-adapter**：适配层，**六边形架构**中的入站适配器。
- **eden-demo-cola-app**：应用层，负责 **CQRS** 的指令处理工作，更新指令，调用领域层，查询视图操作，直接绕过领域层调用基础设施层。

- **eden-demo-cola-client**：API层，对外以 jar 包的形式提供接口。
- **eden-demo-cola-domain**：领域层，业务核心实现，不同于传统的分层架构，提供防腐层接口，不依赖基础设施层的技术实现。
- **eden-demo-cola-infrastructure**：基础设施层，**六边形架构**中的出站适配器，封装技术细节，使用**依赖倒置**实现 Domain
  暴露的防腐层接口。
- **eden-demo-cola-start**：程序启动入口，统一管理应用的配置和交付。

