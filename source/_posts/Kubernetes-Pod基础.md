---

layout: Kubernetes-Pod基础

title: Kubernetes-Pod基础

tags: Kubernetes

categories: Web

top: 29

path: /article/1753358579

abbrlink: 1753358579

date: 2023-04-29 21:36:21


---

# Kubernetes Pod基础

Pod是Kubernetes的最小调度单位，包含一个或者多个容器（比如Docker容器），容器间共享网络和存储。这节主要记录什么是静态Pod，Pod容器如何共享存储，如何使用ConfigMap管理Pod配置，如何使用Downward
API获取Pod信息等。

## 静态Pod

静态Pod是由kubelet创建并管理的特殊的Pod，无法和Pod管理对象关联，并且不能通过API Server关联。创建静态Pod有配置文件方式和HTTP方式：

### 配置文件方式

在搭建Kubernetes集群的时候，从启动Master节点的日志可以看出，静态Pod的目录位于`/etc/kubernetes/manifests`：

在该目录下创建静态Pod文件：

```
cd /etc/kubernetes/manifests
vim static-pod.yaml
```

内容如下所示：

```
apiVersion: v1
kind: Pod
metadata:
  name: static-pod
  labels:
    name: static-pod
spec:
  containers:
    - name: static-nginx
      image: nginx
      imagePullPolicy: IfNotPresent
      ports:
        - containerPort: 80
```

过了一会查看Pod：

![QQ截图20191103124437.png](https://mrbird.cc/img/QQ截图20191103124437.png)

于静态Pod无法通过API Server直接管理，所以在Master上尝试删除这个Pod时，会使其变成Pending状态，且不会被删除。

![QQ截图20191103124756.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111359301.png)

删除该Pod的操作只能是到其所在Node上将其定义文件static-pod.yaml从/etc/kubernetes/manifests目录下删除：

![QQ截图20191103124916.png](https://mrbird.cc/img/QQ截图20191103124916.png)

### HTTP方式

过设置kubelet的启动参数`--manifest-url`，kubelet将会定期从该URL地址下载Pod的定义文件，并以.yaml或.json文件的格式进行解析，然后创建Pod。

## Pod容器共享Volume

同一个Pod的多个容器间可以共享Pod级别的Volume，举个例子：

```
vim pod-volume.yml
```

内容如下所示：

```
apiVersion: v1
kind: Pod
metadata:
  name: pod-volume
spec:
  containers:
    - name: tomcat
      image: tomcat
      imagePullPolicy: IfNotPresent
      ports:
        - containerPort: 8080
      volumeMounts:
        - mountPath: /usr/local/tomcat/logs
          name: logs
    - name: busybox
      image: busybox
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "tail -f /logs/catalina*.log"]
      volumeMounts:
        - mountPath: /logs
          name: logs
  volumes:
    - name: logs
      emptyDir: {}
```

上面Pod定义中，创建了一个Pod级别的Volume，名称为logs，类型为emptyDir。这个Volume同时挂载到了tomcat的/usr/local/tomcat/logs目录下，也挂载到了busybox的/logs目录下。

创建该Pod：

```
kubectl create -f pod-volume.yml
```

这里的tomcat镜像比较大，大概有500MB左右，所以在创建之前，最好在Kubernetes集群的每个节点中配置Docker镜像加速地址。

当pod-volume状态为ready后，查看busybox的日志：

![QQ截图20191103143252.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111359166.png)

该日志为tomcat的启动日志，说明上面挂载的Volume生效了，可以通过查看tomcat`/usr/local/tomcat/logs`目录下和busybox`/logs`
目录下的内容来证明这一点：

![QQ截图20191103143458.png](https://mrbird.cc/img/QQ截图20191103143458.png)

## ConfigMap

ConfigMap以一个或多个key:
value的形式保存在Kubernetes系统中供应用使用，既可以用于表示一个变量的值（例如version=v1），也可以用于表示一个完整配置文件的内容（例如`server.xml=<?xml...>...`）。

### 创建ConfigMap

创建ConfigMap主要有两种方式：

**1.通过yml文件创建**

创建`simple-cm.yml`文件，内容如下所示：

```
apiVersion: v1
kind: ConfigMap
metadata:
  name: simple-cm
data:
  version: v1
  release: stable
```

该ConfigMap仅包含两个简单的值version和releases。

创建该ConfigMap：

```
kubectl create -f simple-cm.yml
```

查看该ConfigMap：

![QQ截图20191103145002.png](https://mrbird.cc/img/QQ截图20191103145002.png)

在定义ConfigMap的时候，value除了可以使用简单的值外，还可以是整个配置文件的内容。

创建`file-cm.yml`，内容如下所示：

```
apiVersion: v1
kind: ConfigMap
metadata:
  name: file-cm
data:
  serverXml: |
    <?xml version="1.0" encoding="UTF-8"?>
    <Server port="8005" shutdown="SHUTDOWN">
      <Listener className="org.apache.catalina.startup.VersionLoggerListener"/>
      <Listener SSLEngine="on" className="org.apache.catalina.core.AprLifecycleListener"/>
      <!-- Prevent memory leaks due to use of particular java/javax APIs-->
      <Listener className="org.apache.catalina.core.JreMemoryLeakPreventionListener"/>
      <Listener className="org.apache.catalina.mbeans.GlobalResourcesLifecycleListener"/>
      <Listener className="org.apache.catalina.core.ThreadLocalLeakPreventionListener"/>
      <GlobalNamingResources>
        <Resource auth="Container" description="User database that can be updated and saved" factory="org.apache.catalina.users.MemoryUserDatabaseFactory" name="UserDatabase" pathname="conf/tomcat-users.xml" type="org.apache.catalina.UserDatabase"/>
      </GlobalNamingResources>
      <Service name="Catalina">
        <Connector connectionTimeout="20000" port="8080" protocol="HTTP/1.1" redirectPort="8443"/>
        <Connector port="8009" protocol="AJP/1.3" redirectPort="8443"/>
        <Engine defaultHost="localhost" name="Catalina">
          <Realm className="org.apache.catalina.realm.LockOutRealm">
            <Realm className="org.apache.catalina.realm.UserDatabaseRealm" resourceName="UserDatabase"/>
          </Realm>

          <Host appBase="webapps" autoDeploy="true" name="localhost" unpackWARs="true">
            <Valve className="org.apache.catalina.valves.AccessLogValve" directory="logs" pattern="%h %l %u %t &quot;%r&quot; %s %b" prefix="localhost_access_log" suffix=".txt"/>
          <Context docBase="D:\Code\apache-tomcat-8.5.32\webapps\tj_certification" path="/tj_certification" reloadable="true" source="org.eclipse.jst.jee.server:tj_certification"/></Host>
        </Engine>
      </Service>
    </Server>
  serverProperties: "1catalina.org.apache.juli.AsyncFileHandler.level = FINE
                     1catalina.org.apache.juli.AsyncFileHandler.directory = ${catalina.base}/logs
                     1catalina.org.apache.juli.AsyncFileHandler.prefix = catalina.

                     2localhost.org.apache.juli.AsyncFileHandler.level = FINE
                     2localhost.org.apache.juli.AsyncFileHandler.directory = ${catalina.base}/logs
                     2localhost.org.apache.juli.AsyncFileHandler.prefix = localhost.

                     3manager.org.apache.juli.AsyncFileHandler.level = FINE
                     3manager.org.apache.juli.AsyncFileHandler.directory = ${catalina.base}/logs
                     3manager.org.apache.juli.AsyncFileHandler.prefix = manager.

                     4host-manager.org.apache.juli.AsyncFileHandler.level = FINE
                     4host-manager.org.apache.juli.AsyncFileHandler.directory = ${catalina.base}/logs
                     4host-manager.org.apache.juli.AsyncFileHandler.prefix = host-manager.

                     java.util.logging.ConsoleHandler.level = FINE
                     java.util.logging.ConsoleHandler.formatter = org.apache.juli.OneLineFormatter

                     org.apache.catalina.core.ContainerBase.[Catalina].[localhost].level = INFO
                     org.apache.catalina.core.ContainerBase.[Catalina].[localhost].handlers = 2localhost.org.apache.juli.AsyncFileHandler

                     org.apache.catalina.core.ContainerBase.[Catalina].[localhost].[/manager].level = INFO
                     org.apache.catalina.core.ContainerBase.[Catalina].[localhost].[/manager].handlers = 3manager.org.apache.juli.AsyncFileHandler

                     org.apache.catalina.core.ContainerBase.[Catalina].[localhost].[/host-manager].level = INFO
                     org.apache.catalina.core.ContainerBase.[Catalina].[localhost].[/host-manager].handlers = 4host-manager.org.apache.juli.AsyncFileHandler"
```

创建该ConfigMap：

![QQ截图20191103150049.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111359196.png)

**2.直接通过Kubectl命令创建**

通过kubectl命令创建ConfigMap主要有以下三种用法：

1. 通过–from-file参数从文件中进行创建，可以指定key的名称，也可以在一个命令行中创建包含多个key的ConfigMap，语法为：

   ```
   kubectl cerate configmap [NAME] --from-file=[key=]source --from-file=[key=]source
   ```

2. 通过–from-file参数从目录中进行创建，该目录下的每个配置文件名都被设置为key，文件的内容被设置为value，语法为：

   ```
   kubectl cerate configmap [NAME] --from-file=config-file-dir
   ```

3. 使用–from-literal时会从文本中进行创建，直接将指定的key#=value#创建为ConfigMap的内容，语法为：

   ```
   kubectl cerate configmap [NAME] --from-literal=key1=value1 --from-literal=key2=value2
   ```

比如使用kubectl命令创建一个和simple-cm效果一样的ConfigMap：

![QQ截图20191103150859.png](https://mrbird.cc/img/QQ截图20191103150859.png)

使用kubectl命令创建一个和file-cm效果一样的ConfigMap：

首先在当前目录下准备好两个配置文件server.xml和server.properties：

![QQ截图20191103151524.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111359656.png)

然后使用kubectl命令创建：

![QQ截图20191103151751.png](https://mrbird.cc/img/QQ截图20191103151751.png)

### Pod容器使用ConfigMap

Pod的容器要使用ConfigMap主要有两种方式：

1. 通过环境变量获取ConfigMap中的内容;
2. 通过Volume挂载的方式将ConfigMap中的内容挂载为容器内部的文件或目录。

**通过环境变量的方式**

创建一个Pod配置（simple-cm-pod.yml）：

```
apiVersion: v1
kind: Pod
metadata:
  name: simple-cm-pod
spec:
  containers:
    - name: busybox
      image: busybox
      command: ["sh", "-c", "env | grep ENV"] # 打印名称包含ENV的环境变量
      env:
        - name: ENVVERSION     # 定义环境变量名称
          valueFrom:           # 值来自...
            configMapKeyRef:   # ConfigMap键的引用
              key: version     # ConfigMap的key
              name: simple-cm  # ConfigMap的名称
        - name: ENVRELEASE
          valueFrom:
            configMapKeyRef:
              key: release
              name: simple-cm
```

创建该Pod，并查看日志：

![QQ截图20191103153532.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111359195.png)

可以看到，值已经成功从ConfigMap里去到了。

如果要引用某个ConfigMap的所有内容，可以使用下面这种方式。定义一个Pod配置（simple-cm-pod-all.uyml）：

```
apiVersion: v1
kind: Pod
metadata:
  name: simple-cm-pod-all
spec:
  containers:
    - name: busybox
      image: busybox
      command: ["sh", "-c", "env"]
      envFrom:
        - configMapRef:
            name: simple-cm
```

创建该Pod，并查看日志：

![QQ截图20191103154213.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111359649.png)

**通过Volume挂载的方式**

创建一个Pod配置（file-cm-pod.yml）：

```
apiVersion: v1
kind: Pod
metadata:
  name: file-cm-pod
spec:
  containers:
    - name: tomcat
      image: tomcat
      ports:
        - containerPort: 8080
      volumeMounts:
        - mountPath: /configs # 容器挂载目录为/configs
          name: config-vm # 引用下面定义的这个Volume
  volumes:
    - name: config-vm   # volume名称为config-vm
      configMap:        # 通过ConfigMap获取
        name: file-cm   # 引用名称为file-cm的ConfigMap
        items:
          - key: serverXml # ConfigMap里配置的key
            path: server.xml # 值使用server.xml文件进行挂载
          - key: serverProperties
            path: server.properties
```

创建该Pod，并进入到容器内部观察/configs目录下文件内容：

![QQ截图20191103155731.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111359881.png)

可以看到名称为file-cm的ConfigMap内容已经成功挂载到了tomcat容器内部。

如果在引用ConfigMap时不指定items，则使用volumeMount方式在容器内的目录下为每个item都生成一个文件名为key的文件。

在Pod对ConfigMap进行挂载（volumeMount）操作时，在容器内部只能挂载为“目录”，无法挂载为“文件”。在挂载到容器内部后，在目录下将包含ConfigMap定义的每个item，如果在该目录下原来还有其他文件，则容器内的该目录将被挂载的ConfigMap
**覆盖**。

## Downward API

Downward API用于将Pod相关信息注入到容器内部，主要有**环境变量**和**Volume挂载**两种方式。

**环境变量**

创建一个Pod配置（dapi-pod.yml）：

```
apiVersion: v1
kind: Pod
metadata:
  name: dapi-pod
spec:
  containers:
    - name: busybox
      image: busybox
      command: ["sh", "-c", "env | grep MY_POD"]
      env:
        - name: MY_POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name # 通过downward api获取当前pod名称
        - name: MY_POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace  # 通过downward api获取当前pod namespace
        - name: MY_POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP  # 通过downward api获取当前pod IP
```

创建该Pod，并查看日志：

![QQ截图20191103162045.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111359106.png)

通过环境变量的方式还可以将容器的requests和limits信息注入到容器的环境变量中，创建一个Pod配置（dapi-pod-container-vars.yml）：

```
apiVersion: v1
kind: Pod
metadata:
  name: dapi-pod-container-vars
spec:
  containers:
    - name: busybox
      image: busybox
      command: ["sh", "-c"]
      args:
        - while true;do
            echo -en '\n';
            printenv MY_CPU_REQUEST MY_CPU_LIMIT;
            printenv MY_MEM_REQUEST MY_MEM_LIMIT;
            sleep 3600;
          done;
      resources:
        requests:
          memory: "32Mi"
          cpu: "125m"
        limits:
          memory: "64Mi"
          cpu: "250m"
      env:
        - name: MY_CPU_REQUEST
          valueFrom:
            resourceFieldRef:
              resource: requests.cpu
              containerName: busybox
        - name: MY_CPU_LIMIT
          valueFrom:
            resourceFieldRef:
              resource: limits.cpu
              containerName: busybox
        - name: MY_MEM_REQUEST
          valueFrom:
            resourceFieldRef:
              resource: request.memory
              containerName: busybox
        - name: MY_MEM_LIMIT
          valueFrom:
            resourceFieldRef:
              resource: limits.memory
              containerName: busybox
```

创建该Pod并观察日志：

![QQ截图20191103163059.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202406111359217.png)

**通过Volume挂载**

我们可以通过Downward API将Pod的Label，Annotation等信息挂载到容器内部文件中，新建一个Pod配置（dapi-pod-volumes.yml）：

```
apiVersion: v1
kind: Pod
metadata:
  name: dapi-pod-volume
  labels:
    tier: frontend
    release: canary
    environment: dev
  annotations:
    builder: mrbird
    blog: https://mrbird.cc
spec:
  containers:
    - name: busybox
      image: busybox
      command: ["sh", "-c", "sleep 36000"]
      volumeMounts:
        - mountPath: /podinfo # 挂载路径
          name: pod-info
  volumes:
    - name: pod-info
      downwardAPI: # 通过downward api获取pod labels和annations信息
        items:
          - path: "labels" # 挂载文件名称
            fieldRef:
              fieldPath: metadata.labels # 挂载内容
          - path: "annotation"
            fieldRef:
              fieldPath: metadata.annotations
```

创建该Pod，并进入到容器/podinfo目录观察结果：

![QQ截图20191103171025.png](https://mrbird.cc/img/QQ截图20191103171025.png)

## Pod生命周期

| 阶段            | 描述                                                                        |
|:--------------|:--------------------------------------------------------------------------|
| **Pending**   | Pod 已被 Kubernetes 接受，但尚未创建一个或多个容器镜像。这包括被调度之前的时间以及通过网络下载镜像所花费的时间，执行需要一段时间。 |
| **Running**   | Pod 已经被绑定到了一个节点，所有容器已被创建。至少一个容器正在运行，或者正在启动或重新启动。                          |
| **Succeeded** | 所有容器成功终止，也不会重启。                                                           |
| **Failed**    | 所有容器终止，至少有一个容器以失败方式终止。也就是说，这个容器要么已非 0 状态退出，要么被系统终止。                       |
| **Unknown**   | 由于一些原因，Pod 的状态无法获取，通常是与 Pod 通信时出错导致的。                                     |

三种重启策略：

1. Always：当容器失效时，由kubelet自动重启该容器；
2. OnFailure：当容器终止运行且退出码不为0时，由kubelet自动重启该容器；
3. Never：不论容器运行状态如何，kubelet都不会重启该容器。

结合Pod的状态和重启策略，以下为一些常见的状态转换场景：

| Pod包含的容器数 | Pod当前的状态 | 发生事件     | Pod的结果状态            |                         |                     |
|-----------|----------|----------|---------------------|-------------------------|---------------------|
|           |          |          | RestarPolicy=Always | RestartPolicy=OnFailure | RestartPolicy=Never |
| 包含1个容器    | Running  | 容器成功退出   | Running             | Succeeded               | Succeeded           |
| 包含1个容器    | Running  | 容器失败退出   | Running             | Running                 | Failed              |
| 包含两个容器    | Running  | 1个容器失败退出 | Running             | Running                 | Running             |
| 包含两个容器    | Running  | 容器被OOM杀掉 | Running             | Running                 | Failed              |

> 《Kubernetes权威指南(第4版)》读书笔记