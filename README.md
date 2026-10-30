# dsh-notify-toast

在 Windows 任务栏右下角弹出系统通知：**任务做完**或**需要你选择**的时候提醒你，类似 Codex 的提示音+气泡。

## 触发时机

| 事件 | 说明 |
| --- | --- |
| `agent/status` running → idle | 一轮任务结束（默认只在主会话，子代理默认不提醒） |
| `user-questions/request` | 模型需要你选择 / 回答 |
| `approval/request` | 需要你批准某个操作（默认关闭） |

完成通知标题显示**任务完成：会话标题**（会话标题最多 64 字），正文显示**本轮最终回复的文字摘要**（最多 180 字）。会去掉 Markdown 标记、代码块和图片；不读取思考过程或工具输出，也不额外调用模型。没有文字回复时提示点开查看，失败或中断时显示“任务未完成”。点击通知仍跳转到原会话。

## 配置

在 profile 的 `cordis.patch.yml` 里对应条目下写 `config:`：

```yaml
- id: dsh-notify-toast
  name: dsh-notify-toast
  config:
    enabled: true          # 总开关
    onComplete: true       # 任务完成时提醒
    onQuestion: true       # 需要选择时提醒
    onApproval: false      # 需要批准时提醒
    notifySubagents: false # 子代理完成也提醒
    appName: DeepSeek Harness   # 通知标题栏显示的名字
    appId: DSH.Notify.Whale     # 用于注册 AUMID 的标识
    iconPath: ''           # 留空则用包内 icon.png（大肥鱼头像）
    iconBackground: 'FFE8F0FC'
    silent: false          # true = 不响声音
    minTurnMs: 1500        # 太短的回合不提醒（毫秒）
    openOnClick: true      # 点击通知直接跳到发通知的那条对话（false = 点击无动作）
    debug: false           # true = 写日志到 %TEMP%\dsh-notify-toast\debug.log
```

## 实现要点

- 通知由 PowerShell + WinRT `ToastNotificationManager` 发出，脚本落在 `%TEMP%\dsh-notify-toast\toast.ps1`。
- 应用名与图标通过 `HKCU\Software\Classes\AppUserModelId\<appId>` 注册，所以通知顶部显示 "DeepSeek Harness" 而不是 "Windows PowerShell"。
- 载荷以 base64(UTF-8 JSON) 从 stdin 传给 PowerShell，彻底避开 Windows 命令行编码问题。
- 同一内容 2 秒内只弹一次；同时最多 3 个在飞。

## 点击通知 = 直接跳到那条对话

点通知不会开浏览器，而是把界面切到「发这条通知的那次对话」，窗口从最小化恢复并前置。

链路：

1. 通知用 `activationType="protocol"`，launch 是 `dshnotify://open?session=<会话id>&kind=<类型>&web=<GUI 地址>`。
2. 首次发通知时自动在 `HKCU\Software\Classes\dshnotify` 注册协议处理器，命令是
   `wscript.exe "%TEMP%\dsh-notify-toast\click.vbs" "%1"`。
3. `click.vbs` 用 `WScript.Shell.Run(..., 0, False)` 隐藏启动 `click.ps1`；`click.ps1` 把窗口恢复到前台，并 `POST <web>/dsh-notify-api/click?session=...`（失败才落盘兜底）。
4. Host 半边 `index.js` 收到 POST 后**同时**做两件事：往 SSE 通道 `/dsh-notify-api/events` 推一帧，并写一份 `open-request.txt`。
5. Client 半边 `client.js` 订阅 SSE（主通道，不受后台标签页定时器冻结影响），并用低频轮询 `/dsh-notify-api/pending` 兜底；拿到会话 id 后调 `uiWorkspace.openSession(id)`，与手动点侧栏完全一致。

两个必须保留的细节（都踩过坑）：

- **协议处理器不能直接写 `powershell.exe`**：哪怕加了 `-WindowStyle Hidden`，PowerShell 仍会先创建控制台窗口再隐藏，点击通知时会闪一个黑色窗口（实测枚举到 `CASCADIA_HOSTING_WINDOW_CLASS|WindowsTerminal` 和 `PseudoConsoleWindow|powershell`）。所以改用 `wscript.exe` 跑 `click.vbs`——wscript 是 GUI 子系统程序，本身没有控制台，由它用 `Run(..., 0, False)` 隐藏启动 PowerShell。实测同一段点击流程枚举到的控制台窗口数为 0。
- **不能挂 `fs.watch` 去抢读 `open-request.txt`**：点击端刚写完文件，watch 会在几十毫秒内读走并删除，前端的轮询就永远读不到，表现为「点了没反应」。
- **`uiWorkspace.openSession` 必须重试**：刚启动时会话可能还没进索引，会抛 `sessions.retain: unknown session <id>`，不重试就会把用户留在「新会话」页面。
