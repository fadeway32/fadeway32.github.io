---

layout: GitLab flow工作流程

title: GitLab flow工作流程

tags: Web

categories: git

top: 21

path: /article/1653658581

abbrlink: 1685194581

date: 2022-05-27 21:36:28


---

# GitLab flow工作流程

### 一、分支约定

#### 临时分支：在开发完成会被删除

1. 功能分支： feature - 用于新功能的开发，以“feature-版本号-需求工单号” 命名，，若涉及前后端开发，可以加上后缀-FE或-BE加以区分，FE：前端，BE：后端。如：
   feature-5.6.0-QYRD-3172-BE，对应工单号为：[https://oa.richinfo.cn:5443/browse/QYRD-3172](https://oa.richinfo.cn:5443/browse/QYRD-3172)
2. 修复分支：fix -
   用户bug的修复，以“fix-版本号-问题工单号”命名，如：fix-5.0.0-QYRD-2216，对应工单号为：[https://oa.richinfo.cn:5443/browse/QYRD-2216](https://oa.richinfo.cn:5443/browse/QYRD-2216)

#### 固定分支:

1. 开发分支： master - 用于发布到开发环境，上游分支为 feature 和 fix，该分支为受保护分支。
2. 测试分支： test - 用于发布到测试环境（标准版的测试环境），上游分支为master，该分支为受保护分支。——等同于SIT
3. 生产分支： prod - 用于发布到生产环境（标准版的打包环境），上游分支为 test，该分支为受保护分支。——等同于UAT

### 二、开发与自测试：

1. 从master拉取feature分支进行编码开发(多个开发人员拉取多个feature同时进行并行开发 , 互不影响)；
2. feature分支开发完成后, 在feature分支变基合并（git rebase master)master的代码 (合并前先更新本地master)，进行本地测试；
3. 测试没问题后，在GitLab上发起 New Merge Request，Assignee给*
   *代码评审员（前端：彭宝文、陈英华，后端：黄健秋、唐伟、于亚林，如果需要某一位开发人员关注，你可以在描述字段中@该名开发人员）**；
4. 代码评审员进行Code Review后，批准merge（若拒绝，需提供有关必要修复的评论），合并有冲突，通知开发人员解决冲突，开发人员解决完冲突后推送到远程feature分支，如果New
   Merge Request被关闭，再次打开（如果合并请求未关闭，它将自动更新，直到最后一次提交为止），注释合并的请求或以其他方式报告已实施的修复；
5. 代码评审员合并代码，开发人员部署到开发环境。

### 示例：

```shell
shell>git checkout -b feature-5.6.0-QYRD-3172-BE origin/master  #基于远程master创建一个feature分支
#在当前分支开发完成后：
shell>git add -A #添加修改的文件到暂存区

#将暂存区里的改动给提交到本地的版本库:
shell>git commit -m '
feat(setting): 增加发邮件默认编辑格式的设置。
closes issue #https://oa.richinfo.cn:5443/browse/QYRD-3172 
'

#将master代码合并到当前分支：
shell>git checkout master #先切换到master
shell>git pull  #更新本地仓master的代码到最新
shell>git checkout feature-5.6.0-QYRD-3172-BE #切换分支到需要rebase的分支
shell>git rebase master  #执行变基。
#若合并有冲突：
shell>git status #查看本地工作区、暂存区中文件的修改状态
shell>git add -A #手动解决冲突后，添加修改的文件到暂存区
shell>git rebase --continue #继续变基操作
shell>git rebase -i HEAD~3 #合并之前的提交记录，~3表示最后提交的三次commit，git rebase -i <commitHash> #合并某个commitHash之后的所有提交
shell>git push origin feature-5.6.0-QYRD-3172-BE -f #推送本地分支代码到远程仓库

#在 https://192.168.8.7/enterprise/xx_STD/-/merge_requests 页面发起 New Merge Request,具体操作参考： Merge_Request_Workflow.md
```

### 三、基线测试及Bug修复：

1. 代码评审员将master分支代码合并到test；
2. 提交基线测试，配置管理员(CM)**赖玉兰**通过jenkins将test代码自动化构建和部署到测试环境，提测；
3. 提测过程发现BUG，从master拉取fix分支进行修复，修复完成后，按Merge Request流程合并到master分支；（参考：Merge_Request_Workflow.md）
4. master部署到开发环境，研发自测试没问题后，开发人员从master分支增量合并（cherry-pick）到test，再走第2步提交基线测试。

### 四、生产发布：

1. test测试没问题后，代码管理员将test分支代码覆盖至为prod分支，打上tag，封版发布。
2. tag版本号建议采用语义化版本规范(2.0.0)，参考：[https://semver.org/lang/zh-CN/](https://semver.org/lang/zh-CN/)

### 五、历史版本的Bug修复

1. 从历史版本的tag创建一个fix修复分支进行开发；
2. fix分支开发完成后,打包部署到历史版本的测试环境;
3. 测试没问题后，打上新的tag，将tag推送到远程。

### 示例：

```shell
shell>git checkout -b fix-5.0.0-QYRD-2216 V5.0.0  #基于指定tag版本创建一个分支
#在当前分支修复完bug后：
shell>git add -A #添加修改的文件到暂存区

#将暂存区里的改动给提交到本地的版本库:
shell>git commit -m '
fix(admin): 修复写邮件，勾选“转发禁止修改”，发送提示：系统错误。
close issue #https://oa.richinfo.cn:5443/browse/QYRD-2216
'

#基于fix-5.0.0-QYRD-2216打包部署到历史版本的测试环境，测试没问题后：
shell>git push origin fix-5.0.0-QYRD-2216 # 将本地code推送到远程分支仓库。

###########代码评审员操作#############
shell>git checkout fix-5.0.0-QYRD-2216
shell>git tag -a V5.0.1 -m "version 5.0.1 released" #打新的tag
shell>git push origin V5.0.1 #将当前tag分支推送到远程仓库
###########代码评审员操作#############

#将master代码合并到当前分支：
shell>git checkout master #先切换到master
shell>git pull  #更新本地仓master的代码到最新
shell>git checkout fix-5.0.0-QYRD-2216 #切换分支到需要rebase的分支
shell>git rebase master  #执行变基。
#若合并有冲突：
shell>git status #查看本地工作区、暂存区中文件的修改状态
shell>git add -A #手动解决冲突后，添加修改的文件到暂存区
shell>git rebase --continue #继续变基操作
shell>git push -f #推送本地分支代码到远程仓库

#在 https://192.168.8.7/enterprise/xx_STD/-/merge_requests 页面发起 New Merge Request,具体操作参考： Merge_Request_Workflow.md
#合并完成后，部署master的代码到开发环境

###########代码评审员操作#############
#开发环境测试没问题后，代码评审员将修复后的代码从master增量（cherry-pick）合并到prod：
shell>git log --author 'pengbaowen' --graph --oneline --decorate=short --date-order -10 #查看自己最近10次的提交记录，复制要增量合并的记录哈希值，此处为：231766b2
shell>git checkout prod #切换至prod分支
shell>git pull  #更新本地仓prod的代码到最新
shell>git cherry-pick 231766b2 #将指定的提交commitHash（多个用空格隔开），应用于当前分支，这会在当前分支产生一个新的提交，当然它们的哈希值会不一样。
shell>git push origin prod #推送到远程仓库，部署到最新版本的测试环境测试
###########代码评审员操作#############

```

### 六、Merge Request的好处：

1. 利于多人协同开发；
2. 强化了代码记录的可读性， 去除杂乱无用的提交记录；
3. 便于 Code review 的执行；
4. 重要分支设置为受保护，杜绝了有些问题代码被提交了，但项目经理不知道的情况；
5. 每个任务都有一个对应的分支，互相隔离，所有的代码改动有据可查；
6. 开发人员不用在分支间切换和合并，更专注于开发。

### 七、Code Review的一般原则：

1. 代码评审是任何开发过程中不可或缺的一部分 -
   将其打印出来并放在墙上以便记住。可参考 《[你的代码评审需要来一次清单革命](https://www.jianshu.com/p/f3b61e3c4313)》！
2. 代码评审是在小段的逻辑完整的代码片段上执行的，例如功能，任务，错误修复，改进等；
3. 只有通过审核的代码才能发送到测试部门；
4. 该项目的所有开发人员都会进行代码评审，无论他们的级别如何;
5. 项目的所有开发人员都应该通过代码评审，无论他们的级别如何（初级开发人员也应该审查经验丰富的中高级专家的代码）。

### 八、注意事项：

1. 始终要遵循"上游优先"（upsteam first）原则，即：master ->prod；

2. 控制提交粒度，不要一次性提交包括多个问题的代码，一个问题的相关代码作为一次提交；

3. 养成时不时pull远程master分支（git rebase
   master）的好习惯，把同事最新的提交合并到自己分支，提前解决冲突。这样下去就可以避免你在一个无用的代码上进行长期的开发，回头来看这些代码不是新的代码，甚至是会面临很多冲突需要解决，而这个时候你可能还需要对冲突的部分代码进行测试回归，这就很麻烦了。

4. rebase原则：只对尚未推送的本地修改执行变基操作清理历史，从不对已推送远程的提交执行变基操作。为防止产生不可预料的事情，已经推送到服务器的分支直接经过merge合并，不使用rebase；使用
   git rebase 的黄金法则就是：分支的开发者尽量是一个人，重写提交历史不会影响别人。

### 九、一些有用的操作示例：

#### 查看提交日志：

```shell
$ git log                     #查看所有提交记录
$ git log --author 'pengbaowen'  #查看某用户的提交记录
$ git log --name-status       #每次修改的文件列表, 显示状态
$ git log --name-only         #每次修改的文件列表
$ git log --stat              #每次修改的文件列表, 及文件修改的统计
$ git whatchanged             #每次修改的文件列表
$ git whatchanged --stat      #每次修改的文件列表, 及文件修改的统计
$ git show                    #显示最后一次的文件改变的具体内容 
$ git show <commit-hash-id>   #查看某次commit的修改内容
$ git log -- <filename>       #查询某个文件的所有历史版本，如：git log -- ./Web/Mail/resource2/se/mail/js/options/pref.js
$ git log -p <filename>       #查看某个文件的所有修改版本及对应的修改内容，如：git log --follow -p src/components/public/BuildingFloorSelect.vue
$ git log -p -2               #查看最近2次的更新内容
$ git log --author 'pengbaowen' --graph --oneline --decorate=short --date-order
```

#### 查看修改（比较修改之间的差异）：

```shell
$ git diff     #不加参数即默认比较工作区与暂存区 
$ git diff --cached [<path>...]  #比较暂存区与最新本地版本库（本地库中最近一次commit的内容） 
$ git diff HEAD [<path>...]  #比较工作区与最新本地版本库。如果HEAD指向的是master分支，那么HEAD还可以换成master 
$ git diff commit-id [<path>...] #比较工作区与指定commit-id的差异　　　　　　 
$ git diff --cached [<commit-id>] [<path>...]  #比较暂存区与指定commit-id的差异 
$ git diff [<commit-id>] [<commit-id>]   #比较两个commit-id之间的差异 

```

#### 删除本地所有fix-相关的分支：

```shell
$ git branch | grep 'fix-' | xargs git branch -D
```

#### 查看本地分支和追踪情况：

```shell
$ git remote show origin
```

#### 本地同步删除远程已被删除的分支：

```shell
$ git remote prune origin
```

#### git revert回滚代码示例：

```shell
shell>git revert -n 817e1f  # 817e1f 为要回滚到commit记录的哈希值
#若冲突，则修改冲突的文件，然后：
shell>git add <冲突的文件>
shell>git revert --continue
shell>git commit -m 'refactor:回退误提交的Q4代码' #将暂存区里的改动给提交到本地的版本库
shell>git push origin master #推送到远程仓库
```

#### 其他git revert相关示例：

**实例一：** git revert 多个提交，比如revert c15a7ae 到 3a2055 之间的提交（包含它俩）

```shell
shell>git revert -n c15a7ae^..3a2055  #到缓存区
shell>git commit -m "revert c15a7ae to 3a2055"   #本地仓库
```

**实例二：** 撤销 HEAD 指针之前的第3个提交，并且生成一个新的提交。这里补充解释一下，HEAD 是指当前的提交指针，除了
HEAD，再往前找3个，所以下面的英文里面说是第4个。

```shell
shell>git revert HEAD~3
```

**实例三：** 撤销从 master 之前第5个提交到之前第3个提交的变化（这么看来，前面是开区间，第6个没有被包含；后面是闭区间，包含了第3个），但是这个操作不会提交一个commit，只是修改
work tree 和 index，如果没有冲突，则直接在 index 里面了。

```shell
shell>git revert -n master~5..master~2
```

#### 不同项目仓库之间的cherry-pick代码(增量合并代码):

下面以xx_STD库prod分支的代码cherry-pick到xx_BOC库（当前库）为例：

1. 基于xx_BOC库的master分支创建新分支：

```shell
shell>git checkout master 
shell>git pull
shell>git checkout -b fix-5.8.0-XXX 
```

2. 将xx_STD库加为远程仓库：

```shell
shell>git remote add xx_STD git@192.168.8.7:enterprise/xx_STD.git  
shell>git remote -v #查看是否添加成功
```

或者直接修改xx_boc/.git/config文件，增加以下内容：

```shell
[remote "xx_STD"]
	url = git@192.168.8.7:enterprise/xx_STD.git
	fetch = +refs/heads/*:refs/remotes/xx_STD/*
```

3. 把远程 xx_STD库的分支信息同步到本地：

```shell
shell>git fetch xx_STD
shell>git log xx_STD/prod #检查一下要从远程仓库prod分支的提交日志，获取要增量合并到当前分支的日志哈希值
```

4. 把远程xx_STD库的代码提交（commitHash）cherry-pick到xx_BOC库的当前分支（fix-5.8.0-XXX）：

```shell
shell>git cherry-pick 166c5561d1915f76cc343514f9c42ca761788791
```

5. 将xx_BOC库当前分支（xx_STD库prod分支的BUG修复代码已增量合并到xx_BOC库分支）推送到远程：

```shell
shell>git push origin fix-5.8.0-XXX
```

6. 基于fix-5.8.0-XXX创建合并到xx_BOC库master分支的合并请求。

### 十、Git缩写命令配置：

编辑git配置文件：

```shell
shell>git config --global -e
```

加入以下内容：

```shell
[alias]
        st = status
        co = checkout
        br = branch
        mg = merge
        ci = commit
        md = commit --amend
        dt = difftool
        mt = mergetool
        unstage = reset HEAD
        last = log -1 HEAD
        cf = config
        latest = for-each-ref --sort=-committerdate --format='%(committerdate:short) %(refname:short) [%(committername)]'
        line = log --oneline
        lg = log --color --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit
        ls = log --pretty=format:\"%C(yellow)%h %C(blue)%ad %C(red)%d %C(reset)%s %C(green)[%cn]\" --decorate --date=short
        hist = log --pretty=format:\"%C(yellow)%h %C(red)%d %C(reset)%s %C(green)[%an] %C(blue)%ad\" --topo-order --graph --date=short
        type = cat-file -t
        dump = cat-file -p
```

或者直接命令行添加：

```shell
shell>git config --global alias.st status
shell>git config --global alias.co checkout
shell>git config --global alias.br branch
shell>git config --global alias.mg merge
shell>git config --global alias.ci commit
shell>git config --global alias.md 'commit --amend'
shell>git config --global alias.dt difftool
shell>git config --global alias.mt mergetool
shell>git config --global alias.unstage 'reset HEAD'
shell>git config --global alias.last 'log -1 HEAD'
shell>git config --global alias.cf config
shell>git config --global alias.latest "for-each-ref --sort=-committerdate --format='%(committerdate:short) %(refname:short) [%(committername)]'"
shell>git config --global alias.line 'log --oneline'
shell>git config --global alias.lg "log --color --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit"
shell>git config --global alias.ls "log --pretty=format:\"%C(yellow)%h %C(blue)%ad %C(red)%d %C(reset)%s %C(green)[%cn]\" --decorate --date=short"
shell>git config --global alias.hist "log --pretty=format:\"%C(yellow)%h %C(red)%d %C(reset)%s %C(green)[%an] %C(blue)%ad\" --topo-order --graph --date=short"
shell>git config --global alias.type "cat-file -t"
shell>git config --global alias.dump "cat-file -p"
```

### 十一、参考链接：

**PRO GIT BOOK 2nd Edition:**

[https://git-scm.com/book/zh/v2](https://git-scm.com/book/zh/v2)

**.gitignore:**

[https://github.com/github/gitignore](https://github.com/github/gitignore)

**Git Commit Message:**

​
Angular规范：[https://github.com/angular/angular.js/blob/master/DEVELOPERS.md#commits](https://github.com/angular/angular.js/blob/master/DEVELOPERS.md#commits)

Conventional Commits
规范：[https://www.conventionalcommits.org/zh-hans/v1.0.0-beta.4/](https://www.conventionalcommits.org/zh-hans/v1.0.0-beta.4/)

​ How to Write a Git Commit
Message： [https://chris.beams.io/posts/git-commit/](https://chris.beams.io/posts/git-commit/)

​ Commit message
编写指南：[https://www.oschina.net/news/69705/git-commit-message-and-changelog-guide](https://www.oschina.net/news/69705/git-commit-message-and-changelog-guide)

**workflows and branching models and strategies:**

A Successful Git branching
model: [http://nvie.com/posts/a-successful-git-branching-model/](http://nvie.com/posts/a-successful-git-branching-model/)

​ Introduction to GitLab
Flow：[https://docs.gitlab.com/ee/topics/gitlab_flow.html](https://docs.gitlab.com/ee/topics/gitlab_flow.html)

​ GitLab的权限管理及Merge
Request：[https://blog.csdn.net/justyman/article/details/90142327](https://blog.csdn.net/justyman/article/details/90142327)

​ 创建和接受合并请求 Merge
Requests：  [https://blog.csdn.net/weixin_43606948/article/details/85489257](https://blog.csdn.net/weixin_43606948/article/details/85489257)