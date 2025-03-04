---

layout: CI/CD实践笔记

title: CI/CD实践笔记

tags: CI/CD实践笔记

categories: CI/CD实践笔记

top: 56

path: /article/1739713328

abbrlink: 1739713328

date: 2025-02-16 21:42:06


--- 

## CI/CD实践笔记

CICD（**C**ontinuous **I**ntegration/**C**ontinuous **D**
eployment），持续集成持续部署的意思。完成CICD实践需要Kubernetes集群，Harbor，GitLab和Jenkins等软件配合完成，在前面几篇博客中，我已经搭建好了Kubernetes集群，并且在master节点（192.168.33.11,CentOS）上安装好了Harbor、GitLab和Jenkins，有需要可以参考下。

## 实践准备

### CICD流程图

CICD的大致流程如下图所示：

![QQ截图20191118145712.png](https://mrbird.cc/img/QQ截图20191118145712.png)

1. 开发者将最新代码提交到GitLab仓库；

2. GitLab WebHook触发Jenkins构建流水线：

   2.1 拉取最新代码；

   2.2 Maven打包，打包过程中会先进行单元测试；

   2.3 单元测试通过，构建Docker镜像；

   2.4 将最新镜像推送到Harbor；

   2.5 更新Kubernetes相关配置镜像版本。

3. Kubernetes感知到镜像更新，从Harbor拉取最新镜像，滚动升级；

4. 开发者看到最新的代码效果。

### 项目准备

这里我们在Windows上使用IDEA、Spring Boot构建一个简单的Java Web项目，项目名为demo，项目pom如下所示：

```
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>2.2.1.RELEASE</version>
        <relativePath/> <!-- lookup parent from repository -->
    </parent>
    <groupId>cc.mrbird</groupId>
    <artifactId>demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>demo</name>
    <description>Demo project for Spring Boot</description>

    <properties>
        <java.version>1.8</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>

</project>
```

在Boot入口类中添加一个简单的Controller方法：

```
@RestController
@SpringBootApplication
public class DemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }

    @GetMapping("hello")
    public String index() {
        return "hello world";
    }
}
```

上面方法提供了一个`/hello`接口，简单返回`hello world`信息。

接着编写一个简单的单元测试：

![QQ截图20191118151519.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000512.png)

代码如下：

```
@RunWith(SpringRunner.class)
@SpringBootTest
@AutoConfigureMockMvc
class DemoApplicationTests {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void testIndex() throws Exception {
        mockMvc.perform(MockMvcRequestBuilders.get("/hello"))
                .andExpect(MockMvcResultMatchers.content().string("hello world"));
    }
}
```

最后在项目的根目录下新建一个Dockerfile：

```
FROM openjdk:8u212-jre
MAINTAINER MrBird 852252810@qq.com

COPY target/demo-0.0.1-SNAPSHOT.jar /demo-0.0.1-SNAPSHOT.jar
ENTRYPOINT ["java", "-jar", "/demo-0.0.1-SNAPSHOT.jar"]
```

至此简单的Java Web项目就准备好了。

### GitLab准备

注册一个新的GitLab账号，比如mrbird，然后在GitLab新建一个项目，名称为Demo：

![QQ截图20191118153441.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000622.png)

因为我们后续需要在Windows下将项目提交到GitLab，并在192.168.33.11上拉取该项目，所以我们需要在Windows和192.168.33.11服务器上生成SSH
Key，并添加到GitLab中。

在Windows及192.168.33.11虚拟机通过下面的命令生成SSH Key：

```
ssh-keygen -t rsa -C "852252810@qq.com"

cat ~/.ssh/id_rsa.pub
```

将SSH Key添加到GitLab：

![QQ截图20191118153948.png](https://mrbird.cc/img/QQ截图20191118153948.png)

这样我们后续的push和pull操作就不需要输入用户名了。

接着我们将上面创建的Demo项目推送到GitLab中（在IDEA的Terminal窗口中操作，个人习惯用命令行）：

```
# 配置Git
git config --global user.name "mrbird"
git config --global user.email "852252810@qq.com"

# 初始化Git仓库
git init

# commit
git commit -am init

# 添加远程仓库
git remote add origin ssh://git@gitlab.mrbird.cc:2223/mrbird/demo.git

# 推送到远程仓库
git push origin master
```

推送成功后，回到GitLab页面可以看到项目已经推送OK了：

![QQ截图20191118154957.png](https://mrbird.cc/img/QQ截图20191120162821.png)

### Kubernetes部署SpringBoot项目

在192.168.33.11服务器上将刚刚的项目从GitLab中克隆下来:

```
git clone ssh://git@gitlab.mrbird.cc:2223/mrbird/demo.git
```

因为打包需要Maven环境，所以接着配置Maven：

```
# 下载Maven安装包
wget http://mirrors.tuna.tsinghua.edu.cn/apache/maven/maven-3/3.6.2/binaries/apache-maven-3.6.2-bin.tar.gz

# 解压
tar -xzvf apache-maven-3.6.2-bin.tar.gz

# 修改环境变量
vim /etc/profile
```

添加如下内容：

```
M2_HOME=/home/vagrant/apache-maven-3.6.2
export PATH=$PATH:$JAVA_HOME/bin:$M2_HOME/bin
```

让修改生效：

```
source /etc/profile
```

验证下是否安装成功：

![QQ截图20191118164351.png](https://mrbird.cc/img/QQ截图20191118164351.png)

环境准备好后，将目录切换到刚刚`git clone`的demo目录下，执行`mvn clean package`命令，完成后可以看到fat jar：

![QQ截图20191118171428.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000264.png)

接着执行`docker build -t docker.mrbird.cc/febs/demo .`命令构建docker镜像：

![QQ截图20191119184432.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000435.png)

构建成功后执行`docker push docker.mrbird.cc/febs/demo`命令推送到Harbor：

![QQ截图20191119184535.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000255.png)

访问Harbor管理页面，可以看到镜像已经推送上来了：

![QQ截图20191119184638.png](https://mrbird.cc/img/QQ截图20191119184638.png)

接着编写个简单的Kubernetes配置文件（demo.yml）：

```
apiVersion: v1
kind: Service
metadata:
  name: demo-service
spec:
  type: NodePort
  ports:
    - port: 8080
      targetPort: 8080
      nodePort: 30000
  selector:
    name: demo-app
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-deployment
spec:
  selector:
    matchLabels:
      name: demo-app
  replicas: 2
  template:
    metadata:
      labels:
        name: demo-app
    spec:
      containers:
        - name: demo
          image: docker.mrbird.cc/febs/demo
          ports:
            - containerPort: 8080
          resources:
            limits:
              cpu: 500m
              memory: 500Mi
            requests:
              cpu: 200m
              memory: 200Mi
```

运行该配置:

![QQ截图20191119191043.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000613.png)

使用浏览器访问http://192.168.33.11:30000/hello:

![QQ截图20191119192134.png](https://mrbird.cc/img/QQ截图20191119192134.png)

至此Spring Boot项目已经成功运行在Kubernetes集群中了，接下来开始演示如何进行CICD。

## CICD实践

就如上面CICD流程图所示，第一步将本地开发代码push到GitLab已经实现了，接下来开始配置GitLab WebHook。

### GitLab WebHook

在Jenkins中创建流水线前，先修改两处Jenkins配置。点击Jenkins管理页面的**系统管理**菜单 -> **全局安全配置**：

![QQ截图20191120091638.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000735.png)

关闭CSRF保护和开启匿名用户具有可读权限。

然后点击**新建任务**菜单，新增一个名称为demo的流水线，勾选**触发远程构建**：

![QQ截图20191120091910.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000932.png)

令牌设置为666666，触发地址为`JENKINS_URL/job/demo/build?token=TOKEN_NAME`，我们需要将这个地址配置为GitLab的WebHook中。

打开GitLab的Demo项目页面，点击左侧的设置菜单：

![QQ截图20191120092313.png](https://mrbird.cc/img/QQ截图20191120092313.png)

选择integrations：

![QQ截图20191120092425.png](https://mrbird.cc/img/QQ截图20191120092425.png)

其中`http://192.168.33.11:8081`为我的Jenkins地址，对应JENKINS_URL；666666是我们设置的令牌，对应TOKEN_NAME。触发事件选择push
event就行。

保存WebHook的时候如果提示Url is blocked: Requests to the local network are not
allowed的话，可以使用[admin@example.com](mailto:admin@example.com)账号登录GitLab（密码就是你第一次登录修改的密码），然后点击
**Admin Area**->**Settings**->**Network**：

![QQ截图20191120093459.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000268.png)

勾选Allow requests to the local network from web hooks and services即可。保存后，重新使用mrbird账号登录重新配置WebHook即可。

配置好后，测试一下：

![QQ截图20191120094028.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000419.png)

页面弹出如下提示说明配置🆗：

![QQ截图20191120094121.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000474.png)

### 代码拉取

Maven打包前需要先用git命令将代码拉取下来。编辑刚刚创建的流水线，在Pipeline script中添加如下代码：

![QQ截图20191120141218.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000632.png)

```
#!groovy
pipeline {
  agent any
  environment {
    REPOSITORY="ssh://git@gitlab.mrbird.cc:2223/mrbird/demo.git"
  }
  stages {
    stage('拉取代码') {
      steps {
        echo "从GitLab地址${REPOSITORY}拉取代码"
        deleteDir()
        git "${REPOSITORY}"
      }
    }
  }
}
```

Pipeline script的基本模板为：

```
#!groovy
pipeline {
  agent any
  environment {
    // 定义全局变量
  }
  stages {
  	// 可以定义多个阶段
    stage('阶段名称') {
      steps {
        // 具体步骤
      }
    }
  }
}
```

回到上面的Pipeline script代码，我们主要做了下面几件事：

1. 在environment中定义GitLab项目仓库地址变量，方便下面直接引用；
2. 通过`echo`命令输出，方便后续从日志中观察跟踪；
3. 通过`deleteDir()`清空工作区；
4. 通过`git "${REPOSITORY}"`从指定Git仓库拉取代码。

其中，使用environment中的变量时候，一定要用`"${xx}"`的方式引用；第3第4步的命令可以通过流水线语法来生成，比如生成清空当前目录的命令：

![QQ截图20191120141809.png](https://mrbird.cc/img/QQ截图20191120141809.png)

生成通过Git拉取代码的命令：

![QQ截图20191120141908.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000811.png)

修改好流水线后，点击**立即构建**，看看我们的配置是否🆗：

![20191120142110.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000111.png)

从日志来看，代码拉取是成功的。

### Maven打包和单元测试

Jenkins 通过shell脚本调用mvn 命令的时候，是从/usr/bin 文件夹中找命令的，这个时候需要做个软链接：

```
ln -s /home/vagrant/apache-maven-3.6.2/bin/mvn /usr/bin/mvn
```

更新流水线的Pipeline script，添加maven打包阶段命令：

```
#!groovy
pipeline {
  agent any
  environment {
    REPOSITORY="ssh://git@gitlab.mrbird.cc:2223/mrbird/demo.git"
  }
  stages {
    stage('拉取代码') {
      steps {
        echo "从GitLab地址${REPOSITORY}拉取代码"
        deleteDir()
        git "${REPOSITORY}"
      }
    }
    stage('代码编译及单元测试') {
      steps {
        echo "开始编译代码和单元测试"
        sh "mvn -U -am clean package"
      }
    }
  }
}
```

maven打包前会自动运行我们在项目里写好的单元测试，修改后，点击**立即构建**，查看日志（截取关键部分）：

![QQ截图20191120154051.png](https://mrbird.cc/img/QQ截图20191121170401.png)

![QQ截图20191120154144.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000109.png)

![QQ截图20191120154249.png](https://mrbird.cc/img/QQ截图20191121170512.png)

可以看到单元测试及打包成功。

### 构建镜像及推送

镜像构建和推送涉及命令较多，所以可以定义一个脚本：

```
vim build_push.sh
```

脚本内容如下所示：

```
#!/bin/bash

MODULE=$1
TIME=`date "+%Y%m%d%H%M"`
GIT_REVISION=`git log -1 --pretty=format:"%h"`
IMAGE_NAME=docker.mrbird.cc/febs/${MODULE}:${TIME}_${GIT_REVISION}

docker build -t ${IMAGE_NAME} .

docker push ${IMAGE_NAME}

echo "${IMAGE_NAME}" > image_name
```

上面脚本定义了三个变量：

1. MODULE，模块名称，由脚本执行的时候传入；
2. TIME，时间字符串；
3. GIT_REVISION，git 提交历史哈希码的前7位；
4. IMAGE_NAME，镜像名称。

脚本做的事情很简单，根据当前目录的Dockerfile构建Docker镜像，然后将镜像推送到Harbor仓库，推送后，将镜像名称写到当前目录下的image_name文件中（供后续使用）。

给脚本添加可执行权限：

```
chmod +x build_push.sh
```

修改Pipeline script，新增构建镜像及推送阶段命令：

```
#!groovy
pipeline {
  agent any
  environment {
    REPOSITORY="ssh://git@gitlab.mrbird.cc:2223/mrbird/demo.git"
    SCRIPT_PATH="/home/vagrant/bash"
  }
  stages {
    stage('拉取代码') {
      steps {
        echo "从GitLab地址${REPOSITORY}拉取代码"
        deleteDir()
        git "${REPOSITORY}"
      }
    }
    stage('代码编译及单元测试') {
      steps {
        echo "开始编译代码和单元测试"
        sh "mvn -U -am clean package"
      }
    }
    stage('Docker镜像构建及推送') {
      steps {
        echo "开始构建Docker镜像并推送到Harbor"
        sh "${SCRIPT_PATH}/build_push.sh demo"
      }
    }
  }
}
```

其中`SCRIPT_PATH`是上面定义的脚本的路径。

修改好Pipeline script，重新点击**立即构建**，截取和这部分相关的日志：

![20191121184651.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000405.png)

查看镜像列表：

![QQ截图20191121184855.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000575.png)

![QQ截图20191121184943.png](https://mrbird.cc/img/QQ截图20191121184943.png)

### Kubernetes Deployment升级

在`/home/vagrant/bash`目录下新建deploy.sh脚本：

```
#!/bin/bash

IMAGE=`cat image_name`

kubectl set image deployment/demo-deployment demo=${IMAGE}
```

脚本内容很简单，就是通过kubectl命令升级相关Pod的镜像，镜像名称从image_name文件中读取。

修改Pipeline script，添加Kubernetes Deployment升级阶段命令：

```
#!groovy
pipeline {
  agent any
  environment {
    REPOSITORY="ssh://git@gitlab.mrbird.cc:2223/mrbird/demo.git"
    SCRIPT_PATH="/home/vagrant/bash"
  }
  stages {
    stage('拉取代码') {
      steps {
        echo "从GitLab地址${REPOSITORY}拉取代码"
        deleteDir()
        git "${REPOSITORY}"
      }
    }
    stage('代码编译及单元测试') {
      steps {
        echo "开始编译代码和单元测试"
        sh "mvn -U -am clean package"
      }
    }
    stage('Docker镜像构建及推送') {
      steps {
        echo "开始构建Docker镜像并推送到Harbor"
        sh "${SCRIPT_PATH}/build_push.sh demo"
      }
    }
    stage('更新Kubernetes Deployment') {
      steps {
        echo "开始更新Kubernetes Deployment"
        sh "${SCRIPT_PATH}/deploy.sh"
      }
    }
  }
}
```

修改后，点击**立即构建**：

![QQ截图20191121192052.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000805.png)

至此我们整条CICD流程就已经都通了，下面测试下CICD。

## 效果测试

如上面所示，我们访问http://192.168.33.11:30000/hello，页面返回hello world，我们在IDEA中修改Controller方法：

![QQ截图20191121190234.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000597.png)

同时修改单元测试方法：

![QQ截图20191121190318.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000903.png)

修改后在IDEA的命令窗口输入：

```
git commit -am update

git push origin master
```

将最新的代码提交到GitLab后，过一小会刷新http://192.168.33.11:30000/hello，可以看到，我们修改的内容已经生效了：

![QQ截图20191121191654.png](https://gitee.com/fadeway32/fadeway32/raw/master/img/202503042000590.png)