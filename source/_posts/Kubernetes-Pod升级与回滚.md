---

layout: Kubernetes-Pod升级与回滚

title: Kubernetes-Pod升级与回滚

tags: Kubernetes

categories: Web

top: 29

path: /article/1753358582

abbrlink: 1753358582

date: 2023-04-29 21:37:28


---

# Kubernetes Pod升级与回滚

当集群中的某个服务需要升级时，我们需要停止目前与该服务相关的所有Pod，然后下载新版本镜像并创建新的Pod。如果集群规模比较大，则这个工作变成了一个挑战，而且先全部停止然后逐步升级的方式会导致较长时间的服务不可用。Kubernetes提供了滚动升级功能来解决上述问题。如果在更新过程中发生了错误，则还可以通过回滚操作恢复Pod的版本。

## Deployment升级

现有如下deployment定义（nginx-deployment.yml）：

```
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  selector:
    matchLabels:
      name: nginx
  replicas: 3
  template:
    metadata:
      labels:
        name: nginx
    spec:
      containers:
        - name: nginx
          image: nginx:1.7.9
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 80
```

创建该deployment：

![QQ截图20191106094755.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111326919.png)

通过kubectl命令将nginx的版本更新到1.9.1：

```
kubectl set image deployment/nginx-deployment nginx=nginx:1.9.1
```

查看滚动升级的过程：

![QQ截图20191106095447.png](https://mrbird.cc/img/QQ截图20191106095447.png)

查看Pod，会发现名称已经改变了：

![QQ截图20191106095549.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111326041.png)

上述滚动升级的过程可以用下图表示：

![QQ截图20191106101327.png](https://mrbird.cc/img/QQ截图20191106101327.png)

查看Deployment nginx-deployment的详细事件信息可以证明这一点：

```
kubectl describe deployments/nginx-deployment
```

![QQ截图20191106100133.png](https://mrbird.cc/img/QQ截图20191106100133.png)

查看rs：

![QQ截图20191106102115.png](https://mrbird.cc/img/QQ截图20191106102115.png)

默认的升级策略为RollingUpdate（滚动更新），Kubernetes还支持Recreate（重建）策略：

1. Recreate：先杀掉所有正在运行的Pod，然后创建新的Pod。
2. RollingUpdate：以滚动更新的方式来逐个更新Pod。同时，可以通过设置spec.strategy.rollingUpdate下的两个参数（maxUnavailable和maxSurge）来控制滚动更新的过程。

RollingUpdate的两个参数含义如下：

1. maxUnavailable：用于指定Deployment在更新过程中不可用状态的Pod数量的上限。该maxUnavailable的数值可以是绝对值（例如1）或Pod期望的副本数的百分比（例如10%）。
2. maxSurge：用于指定在Deployment更新Pod的过程中Pod总数超过Pod期望副本数部分的最大值。该maxSurge的数值可以是绝对值（例如5）或Pod期望副本数的百分比（例如10%）。

此外，除了使用kubectl命令升级外，我们也可以直接通过修改deployment.yml的方式来完成。

## Deployment回滚

如果升级后效果不满意的话，我们也可以将Deployment回滚到升级之前，使用下面这条命令查看滚动升级的历史：

```
kubectl rollout history deployment/nginx-deployment
```

![QQ截图20191106103606.png](https://mrbird.cc/img/QQ截图20191106103606.png)

REVISION为升级的历史版本，我们只完成了nginx从1.7.9升级到1.9.1的过程，所以REVISION 1表示nginx为1.7.9的版本，REVISION
2表示nginx为1.9.1的版本。因为我们在创建deployment的时候没有加上`--record=true`参数，所以CHANGE-CACSE列是空的。

需要查看特定版本的详细信息，则可以加上–revision=参数：

![QQ截图20191106104520.png](https://mrbird.cc/img/QQ截图20191106104520.png)

要将nginx回退到1.7.9版本，我们可以将REVISION指定为1：

```
kubectl rollout undo deployment/nginx-deployment --to-revision=1
```

![QQ截图20191106105253.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111326440.png)

![QQ截图20191106105638.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111326736.png)

## 暂停与恢复

因为Deployment配置一旦修改就会触发升级操作，所以当修改的地方较多的时候就会频繁触发升级。我们可以先暂停升级操作，当所有配置都修改好后再恢复升级。

暂停：

```
kubectl rollout pause deployment/nginx-deployment
```

暂停后，对nginx-deployment的修改不会触发升级。修改好后，恢复升级：

```
kubectl rollout resume deployment/nginx-deployment
```

## 其他Pod管理对象升级策略

### DaemonSet

DaemonSet的升级策略包括两种：OnDelete和RollingUpdate：

1. OnDelete（默认）：在创建好新的DaemonSet配置之后，新的Pod并不会被自动创建，直到用户手动删除旧版本的Pod，才触发新建操作。
2. RollingUpdate：和前面介绍的一致，不过不支持rollout，只能通过将配置改回去来实现。

### StatefulSet

支持Recreate、OnDelete和RollingUpdate。

> 《Kubernetes权威指南(第4版)》读书笔记