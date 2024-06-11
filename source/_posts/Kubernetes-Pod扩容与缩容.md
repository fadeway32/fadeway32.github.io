---

layout: Kubernetes-Pod扩容与缩容

title: Kubernetes-Pod扩容与缩容

tags: Kubernetes

categories: Web

top: 29

path: /article/1753358581

abbrlink: 1753358581

date: 2023-04-29 21:36:28


---

# Kubernetes Pod扩容与缩容

针对不同时期流量的大小我们可以给Pod扩缩容，Kubernetes支持通过kubectl命令手动扩缩容，也支持通过HPA自动横向扩缩容。

## 手动扩缩容

现有如下deployment配置（nginx-deployment.yml）：

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

创建该Deployment：

![QQ截图20191108094938.png](https://mrbird.cc/img/QQ截图20191108094938.png)

有3个nginx实例，现在用下面这条命令将nginx实例扩充到5个：

```
kubectl scale deployment nginx-deployment --replicas 5
```

![QQ截图20191108100513.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111328301.png)

缩容：

```
kubectl scale deployment nginx-deployment --replicas 1
```

![QQ截图20191108100834.png](https://mrbird.cc/img/QQ截图20191108100834.png)

## HPA

HPA能够根据特定指标完成目标Pod的自动扩缩容。创建一个与上面nginx-deployment相对应的HPA（nginx-deployment-hpa.yml）：

```
apiVersion: autoscaling/v1
kind: HorizontalPodAutoscaler
metadata:
  name: nginx-deployment-hpa-v1
spec:
  maxReplicas: 6
  minReplicas: 2
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nginx-deployment
  targetCPUUtilizationPercentage: 50
```

主要参数如下：

1. scaleTargetRef：目标作用对象，可以是Deployment、ReplicationController或ReplicaSet。
2. targetCPUUtilizationPercentage：期望每个Pod的CPU使用率都为50%，该使用率基于Pod设置的CPU
   Request值进行计算，例如该值为200m，那么系统将维持Pod的实际CPU使用值为100m。
3. minReplicas和maxReplicas：Pod副本数量的最小值和最大值，系统将在这个范围内进行自动扩缩容操作，并维持每个Pod的CPU使用率为50%。

使用HPA，需要预先安装Metrics Server，用于采集Pod的CPU使用率。

> 《Kubernetes权威指南(第4版)》读书笔记