# Cursor Session Sync

安装扩展后点「授权」，用 Cursor 弹出的 GitHub 登录创建一个私有仓库。不用单独安装命令行，不用填 token，也不用配置 SSH。

同步程序随扩展一起打包，是 [cursaves](https://github.com/Callum-Ward/cursaves) 的 AGPL-3.0 分支，源码在安装包的 `vendor/cursaves` 和本仓库的 `cli/`。扩展本身是 MIT。

## 安装

安装这个 VSIX。本机没有 Python 3.10 或更新版本时，扩展会自动下载一份。第一次启动时点「授权」，在弹出的 GitHub 登录里同意即可。扩展会创建私有仓库 `cursor-saves`（已有同名私有仓库就直接用），并把登录交给系统钥匙串。开了多个窗口时，授权会排队：一个窗口在登录，其他窗口等待，不会再建第二个仓库。另一台电脑同样安装扩展并授权同一个 GitHub 账号。

侧边栏「会话同步」里勾选要同步的仓库，保存后才会上传和导入这些仓库的会话。命令 `Cursor Session Sync: 配置` 用来改轮询间隔和冲突策略。

## 权限

扩展在本机运行自带的同步程序。GitHub 授权只用于创建和访问这个私有仓库，token 不写入扩展设置。会话正文只进你的私有仓库。

## 会话什么时候出现

Cursor 开着的时候只推送本机更新和弹通知。写入本地数据库发生在 Cursor 进程退出之后。完全退出再打开，导入的会话才会出现在侧边栏里，然后可以接着聊。`Developer: Reload Window` 不会让新会话出现。

界面默认跟随 Cursor 的显示语言。设置项 cursorSessionSync.language 可改为 auto、zh 或 en。

## English

After installing the extension, choose Authorize and sign in with the GitHub prompt. That creates a private repository. You do not install a CLI, paste a token, or configure SSH.

The sync program is bundled with the extension. It is an AGPL-3.0 fork of [cursaves](https://github.com/Callum-Ward/cursaves). Source is in `vendor/cursaves` inside the package and in `cli/` in this repository. The extension itself is MIT.

### Install

Install the VSIX. If Python 3.10 or newer is missing, the extension downloads a copy. On first launch, choose Authorize and accept the GitHub prompt. The extension creates a private repository named `cursor-saves`, or reuses a private repository with that name, and stores the login in the system keychain. With several windows open, authorization is queued: one window signs in, the others wait, and a second repository is not created. Install the extension on the other computer and authorize the same GitHub account.

In the Session Sync sidebar, check the repositories to sync. Chats upload and import only after you save. `Cursor Session Sync: Settings` changes the poll interval and the conflict policy.

### Permissions

The extension runs the bundled sync program on this computer. GitHub authorization is used only to create and access this private repository. The token is not written into extension settings. Chat contents go only to your private repository.

### When chats appear

While Cursor is open, the extension pushes local updates and shows notifications. The local database is written after the Cursor process has exited. Quit completely and open Cursor again to see imported chats and continue them. `Developer: Reload Window` does not reveal new chats.

The interface follows Cursor’s display language unless you set cursorSessionSync.language to auto, zh, or en.
