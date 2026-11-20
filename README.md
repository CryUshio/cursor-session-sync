# Cursor Session Sync

把 Cursor 会话同步到你自己的私有 GitHub 仓库。扩展负责界面和授权，实际读写由打包进去的 cursaves 完成。

| 目录 | 说明 |
| --- | --- |
| `extension/` | Cursor / VS Code 扩展，MIT |
| `cli/` | [cursaves](https://github.com/Callum-Ward/cursaves) 的 AGPL-3.0 分支 |

## 安装

用 `extension/` 打出来的 VSIX 安装。没有 Python 3.10 及以上时，扩展会在自己的目录里装一份，不需要 sudo。

第一次启动点「授权」，按弹出的 GitHub 登录同意。扩展创建私有仓库 `cursor-saves`（已有同名私有仓库就直接用），登录交给系统钥匙串。设置里不保存 token，也不用配 SSH。

开了多个 Cursor 窗口时，授权共用一把锁：同一个窗口连点只会走一次；其他窗口会等当前这次完成。先完成的窗口建仓库，后到的窗口直接沿用，不会再建一个。

另一台电脑安装同一个扩展，用同一个 GitHub 账号授权。

## 同步哪些仓库

活动栏「会话同步」里按 Git 远端加本地文件夹名列出本机仓库。同一个远端、不同文件夹名会分成两条。勾选后点保存，才会上传和导入这些仓库的会话。一个都不勾并保存，同步暂停。

保存之后马上从本机上传一次，之后按轮询间隔（默认 60 秒）再检查。只上传勾选仓库里比快照新的会话。编辑器右下角会显示「未选择仓库」「同步中」「已同步」或「同步失败」，点一下可以看进度。

## 会话什么时候出现

Cursor 开着时只上传本机更新，并在有新会话时通知。写入本机数据库发生在 Cursor 完全退出之后。重新打开后，导入的会话才会出现。Reload Window 不会让新会话出现。

两台电脑要把同一个本地文件夹名配上同一个 Git 远端，才会视为同一个项目。只是远端相同、文件夹名不同，会分成两个仓库。界面语言默认跟随 Cursor。设置项 cursorSessionSync.language 可改为 auto、zh 或 en。

## English

Sync Cursor chats to your own private GitHub repository. The extension handles the UI and sign-in. Reading and writing is done by the bundled cursaves program.

| Path | What it is |
| --- | --- |
| `extension/` | Cursor / VS Code extension, MIT |
| `cli/` | AGPL-3.0 fork of [cursaves](https://github.com/Callum-Ward/cursaves) |

### Install

Install the VSIX built from `extension/`. If Python 3.10 or newer is missing, the extension installs a copy in its own directory. No sudo.

On first launch, choose Authorize and accept the GitHub prompt. The extension creates a private repository named `cursor-saves` (an existing private repository with that name is reused). The login is stored in the system keychain. The token is not saved in settings, and SSH is not required.

With several Cursor windows open, authorization uses one lock. Repeated clicks in the same window join the attempt already running. Other windows wait. The first window creates the repository; the later ones reuse it.

Install the same extension on the other computer and authorize the same GitHub account.

### Which repositories sync

The Session Sync activity lists repositories by Git remote plus local folder name. Two checkouts of the same remote stay separate when the folder names differ. Chats upload and import only after you check repositories and save. Saving with nothing checked pauses sync.

The first upload starts right after saving, then the extension checks again on the poll interval (60 seconds by default). Only chats newer than the snapshot are uploaded. The status bar shows No repositories, Syncing, Synced, or Sync failed. Click it to see progress.

### When chats appear

While Cursor is open, the extension uploads local updates and shows notifications. The local database is written only after Cursor has fully quit. Imported chats appear after you open Cursor again. Reload Window does not show them.

The same project is the same Git remote and the same local folder name. A different folder name is a different repository, even when the remote matches.

The interface follows Cursor’s display language unless you set cursorSessionSync.language to auto, zh, or en.
