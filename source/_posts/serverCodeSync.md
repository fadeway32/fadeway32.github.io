---

layout: 代码同步命令

title: 代码同步命令

tags: Web

categories: Web

top: 38

path: /article/1685194583

abbrlink: 1685194583

date: 2023-05-27 21:36:26


---

# 服务器代码同步操作示例

##以从192.168.5.129同步至192.168.8.131为例：

1. 以root用户登录192.168.8.131。
2. 创建 以日期命名的备份目录：

```shell
[root@os11728 ~]# mkdir /home/backup/webbak/20191108
```

3. 备份代码：

```shell
[root@os11728 ~]# cp -r /home/fadeway/web/{calendar,html,thinkdrive,fadewaysvr} /home/backup/webbak/20191108/
```

4. 同步代码：

```shell
[root@os11728 ~]# rm -rf /home/fadeway/web/{calendar,html,thinkdrive,fadewaysvr}
[root@os11728 ~]# scp -P 22 -r root@192.168.5.129:/home/fadeway/web/{calendar,html,thinkdrive,fadewaysvr}  /home/fadeway/web/
```

5. 重启服务：

```shell
[root@os11728 ~]# /home/fadeway/sbin/webmailctl.sh --restart
```

##从192.168.5.129同步至210.22.22.150

1. 以root用户登录210.22.22.150。
2. 创建 以日期命名的备份目录：

```shell
[root@os11728 ~]# mkdir /home/backup/webbak/20191108
```

3. 备份代码：

```shell
[root@os11728 ~]# cp -r /home/fadeway/web/{calendar,html,thinkdrive,fadewaysvr} /home/backup/webbak/20191108/
[root@os11728 ~]# rm -rf /home/fadeway/web/{calendar,html,thinkdrive,fadewaysvr}
```

4. 以root用户登录192.168.5.129。

5. 同步代码：

```shell
[root@os11728 ~]# scp -P 1579 -r /home/fadeway/web/{calendar,html,thinkdrive,fadewaysvr} root@210.22.22.150:/home/fadeway/web/
```

5. 重启服务：

```shell
[root@os11728 ~]# /home/fadeway/sbin/webmailctl.sh --restart
```

##还原代码

1. 以root用户登录。
2. 将某日期备份的文件还原：

```shell
[root@os11728 ~]# cp -r /home/backup/webbak/20191108/{calendar,html,thinkdrive,fadewaysvr}  /home/fadeway/web/
```

##fadeway打包备份

示例：

```shell
[root@os11728 ~]# tar -zcvf fadeway.V5.8.0.release.NeoKylin7.6.kp920arm64.tongweb.mysql8.20210318.tar.gz --exclude=fadeway/logs --exclude=fadeway/backup --exclude=fadeway/nginx.new --exclude=fadeway/MailMove/logs fadeway
```