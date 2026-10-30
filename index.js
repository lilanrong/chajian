// dsh-notify-toast — Windows 右下角通知（类似 Codex 的提示）
//
// 三个触发点：
//   1. agent/status  running -> idle   一轮任务做完
//   2. user-questions/request          模型需要你选择 / 回答
//   3. approval/request                需要你批准某个操作
//
// 实现：Host 侧调用 powershell.exe，用 WinRT ToastNotificationManager 弹系统
// 通知；应用名与图标通过 HKCU\Software\Classes\AppUserModelId\<appId> 注册，
// 所以通知顶部显示的是 "DeepSeek Harness" 而不是 "Windows PowerShell"。
// 载荷用 base64(UTF-8 JSON) 从 stdin 传进脚本，彻底避开 Windows 命令行编码坑。
//
// 点击行为：toast 的 launch 是自定义协议 dshnotify://open?session=<id>&kind=<kind>，
// 由本插件注册到 HKCU\Software\Classes\dshnotify。点击后 PowerShell 处理器把这次
// 请求写进临时文件并唤醒/启动桌面端；Client 半边轮询 /dsh-notify-api/pending，
// 拿到 sessionId 后调 uiWorkspace.openSession(id) —— 直接跳到那条对话，而不是
// 用默认浏览器打开 Web 页面。

import z from '@deepseek-ai/schemastery'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export const name = 'dsh-notify-toast'
export const inject = ['subprocess']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ICON = path.join(HERE, 'icon.png')
const PROTOCOL = 'dshnotify'
const API_PREFIX = '/dsh-notify-api'
const STATE_DIR = path.join(os.tmpdir(), 'dsh-notify-toast')
const REQUEST_FILE = path.join(STATE_DIR, 'open-request.txt')

export const Config = z.object({
  enabled: z.boolean().default(true),
  onComplete: z.boolean().default(true),
  onQuestion: z.boolean().default(true),
  onApproval: z.boolean().default(false),
  notifySubagents: z.boolean().default(false),
  appId: z.string().default('DSH.Notify.Whale'),
  appName: z.string().default('DeepSeek Harness'),
  iconPath: z.string().default(''),
  iconBackground: z.string().default('FFE8F0FC'),
  silent: z.boolean().default(false),
  minTurnMs: z.number().default(1500),
  openOnClick: z.boolean().default(true),
  debug: z.boolean().default(false),
})

// PowerShell 侧脚本：纯 ASCII，避免任何编码问题。
const TOAST_PS1 = String.raw`$ErrorActionPreference = 'Stop'
try {
  $b64 = [Console]::In.ReadToEnd()
  if ($null -ne $b64) { $b64 = $b64.Trim() }
  if ([string]::IsNullOrEmpty($b64)) { exit 2 }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  $cfg = $json | ConvertFrom-Json

  $appId = [string]$cfg.appId
  if ([string]::IsNullOrWhiteSpace($appId)) { $appId = 'DSH.Notify.Whale' }

  $regPath = 'HKCU:\Software\Classes\AppUserModelId\' + $appId
  if (-not (Test-Path -LiteralPath $regPath)) { New-Item -Path $regPath -Force | Out-Null }
  $appName = [string]$cfg.appName
  if (-not [string]::IsNullOrWhiteSpace($appName)) {
    New-ItemProperty -Path $regPath -Name DisplayName -Value $appName -PropertyType String -Force | Out-Null
  }
  New-ItemProperty -Path $regPath -Name ShowInSettings -Value 1 -PropertyType DWord -Force | Out-Null
  $icon = [string]$cfg.iconPath
  if (-not [string]::IsNullOrWhiteSpace($icon) -and (Test-Path -LiteralPath $icon)) {
    New-ItemProperty -Path $regPath -Name IconUri -Value $icon -PropertyType String -Force | Out-Null
  }
  $bg = [string]$cfg.iconBackground
  if (-not [string]::IsNullOrWhiteSpace($bg)) {
    New-ItemProperty -Path $regPath -Name IconBackgroundColor -Value $bg -PropertyType String -Force | Out-Null
  }

  # 注册点击协议：点击通知 → 唤起处理器脚本（唤醒桌面端 + 记录要跳转的会话）
  # 优先用 wscript.exe 跑一个 .vbs 启动器：它是 GUI 子系统程序，完全没有控制台，
  # 所以点击通知时不会闪出 PowerShell 黑窗口；直接调 powershell.exe 无论加不加
  # -WindowStyle Hidden 都会先创建控制台窗口再隐藏，视觉上就是闪一下。
  $click = [string]$cfg.clickScript
  $launcher = [string]$cfg.clickLauncher
  $proto = [string]$cfg.protocol
  if (-not [string]::IsNullOrWhiteSpace($click) -and (Test-Path -LiteralPath $click) -and -not [string]::IsNullOrWhiteSpace($proto)) {
    $root = 'HKCU:\Software\Classes\' + $proto
    if (-not (Test-Path -LiteralPath $root)) { New-Item -Path $root -Force | Out-Null }
    Set-ItemProperty -Path $root -Name '(default)' -Value ('URL:' + $proto) -Force
    Set-ItemProperty -Path $root -Name 'URL Protocol' -Value '' -Force
    $cmdPath = $root + '\shell\open\command'
    if (-not (Test-Path -LiteralPath $cmdPath)) { New-Item -Path $cmdPath -Force | Out-Null }
    if (-not [string]::IsNullOrWhiteSpace($launcher) -and (Test-Path -LiteralPath $launcher)) {
      $cmdLine = 'wscript.exe "' + $launcher + '" "%1"'
    } else {
      $cmdLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $click + '" "%1"'
    }
    Set-ItemProperty -Path $cmdPath -Name '(default)' -Value $cmdLine -Force
  }

  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]

  function ConvertTo-XmlText([string]$value) {
    if ([string]::IsNullOrEmpty($value)) { return '' }
    $v = $value.Replace('&', '&amp;')
    $v = $v.Replace('<', '&lt;')
    $v = $v.Replace('>', '&gt;')
    $v = $v.Replace('"', '&quot;')
    $v = $v.Replace("'", '&apos;')
    return $v
  }

  $title = ConvertTo-XmlText ([string]$cfg.title)
  $body = ConvertTo-XmlText ([string]$cfg.body)
  $launch = ConvertTo-XmlText ([string]$cfg.launch)

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<toast')
  if ($cfg.silent -eq $true) { [void]$sb.Append(' silent="true"') }
  if (-not [string]::IsNullOrWhiteSpace($launch)) {
    [void]$sb.Append(' activationType="protocol" launch="' + $launch + '"')
  }
  [void]$sb.Append('><visual><binding template="ToastGeneric">')
  [void]$sb.Append('<text>' + $title + '</text>')
  if (-not [string]::IsNullOrEmpty($body)) { [void]$sb.Append('<text>' + $body + '</text>') }
  [void]$sb.Append('</binding></visual></toast>')

  $doc = New-Object -TypeName Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($sb.ToString())
  $toast = New-Object -TypeName Windows.UI.Notifications.ToastNotification -ArgumentList $doc
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
  $notifier.Show($toast)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

// 点击启动器：由 wscript.exe（GUI 子系统，无控制台）执行，转去跑 click.ps1。
// 参数里带的是协议的 %1，也就是完整的 dshnotify://... 地址。
const CLICK_VBS = String.raw`Option Explicit
Dim shell, fso, dir, raw, cmd, q
If WScript.Arguments.Count > 0 Then
  raw = WScript.Arguments(0)
Else
  raw = ""
End If
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.BuildPath(fso.GetSpecialFolder(2), "dsh-notify-toast")
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & fso.BuildPath(dir, "click.ps1") & """ """
q = Chr(34)
Set shell = CreateObject("WScript.Shell")
shell.Run cmd & q & raw & q, 0, False
`

// 点击处理器：记录这次点击要跳转的会话，并把桌面端叫到前台（没开就启动）。
const CLICK_PS1 = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$raw = ''
if ($args.Count -gt 0) { $raw = [string]$args[0] }

$dir = Join-Path $env:TEMP 'dsh-notify-toast'
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$req = Join-Path $dir 'open-request.txt'

# 优先直接把点击事件 POST 给 Host：SSE 会立刻把它推给界面，比写文件再等轮询快得多。
$sid = ''
if ($raw -match '[?&]session=([^&]+)') { $sid = [System.Uri]::UnescapeDataString($matches[1]) }
$base = ''
if ($raw -match '[?&]web=([^&]+)') { $base = [System.Uri]::UnescapeDataString($matches[1]) }
$posted = $false
if (-not [string]::IsNullOrWhiteSpace($sid) -and -not [string]::IsNullOrWhiteSpace($base)) {
  $kind = 'complete'
  if ($raw -match '[?&]kind=([^&]+)') { $kind = [System.Uri]::UnescapeDataString($matches[1]) }
  $url = $base.TrimEnd('/') + '/dsh-notify-api/click?session=' + [System.Uri]::EscapeDataString($sid) + '&kind=' + [System.Uri]::EscapeDataString($kind)
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
    if ($resp -and $resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) { $posted = $true }
  } catch { }
}
# POST 不通（比如应用还没起来）才落文件，等界面起来后轮询取走。
if (-not $posted) {
  try { Set-Content -LiteralPath $req -Value $raw -Encoding UTF8 } catch { }
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshNotifyFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@

$exe = 'D:\deepseek\DeepSeek Harness.exe'
$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($procs.Count -eq 0) {
  if (Test-Path -LiteralPath $exe) {
    Start-Process -FilePath $exe | Out-Null
  } else {
    $web = ''
    if ($raw -match '[?&]web=([^&]+)') { $web = [System.Uri]::UnescapeDataString($matches[1]) }
    if (-not [string]::IsNullOrWhiteSpace($web)) { Start-Process $web | Out-Null }
  }
} else {
  foreach ($p in $procs) {
    $h = $p.MainWindowHandle
    if ([DshNotifyFocus]::IsIconic($h)) { [DshNotifyFocus]::ShowWindowAsync($h, 9) | Out-Null }
    if (-not [DshNotifyFocus]::SetForegroundWindow($h)) {
      $shell = New-Object -ComObject WScript.Shell
      $shell.AppActivate($p.Id) | Out-Null
    }
  }
}
exit 0
`

function clampText(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function paramOf(raw, key) {
  const match = new RegExp('[?&]' + key + '=([^&]+)').exec(String(raw || ''))
  if (!match) return ''
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

// Agent 只暴露 id，session 需要通过 sessions 服务查。
function isSubagent(ctx, agent) {
  const id = agent?.id
  if (typeof id !== 'string') return false
  try {
    const session = ctx.get('sessions')?.get?.(id)
    const header = session?.header
    if (!header) return false
    return header.origin === 'subagent' || Number(header.delegationDepth ?? 0) > 0
  } catch {
    return false
  }
}

// Only summarize the current run's final visible answer, never reasoning/tool output.
export function completionNotice(events) {
  const end = [...events].reverse().find((event) => event.type === 'turn/end')
  const reason = end?.data?.reason?.kind
  if (reason && reason !== 'completed') {
    return { title: '任务未完成', body: reason === 'error'
      ? '本轮处理遇到错误，点开对话查看详情。'
      : '本轮处理已暂停或中断，点开对话查看进度。' }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'assistant/message' || event.data?.interrupted) continue
    if (end && event.data?.turn !== end.data?.turn) continue
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks) || blocks.some((block) => block.type === 'tool-call')) continue
    const text = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text).join('\n')
      .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\[表情:[^\]]*\]/g, '')
    const body = clampText(text, 180)
    if (body) return { title: '任务完成', body }
  }
  return { title: '任务完成', body: '本轮处理已结束，暂无文字摘要，点开对话查看结果。' }
}

function shortId(id) {
  return typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id ?? '')
}

export function apply(ctx, config) {
  const options = {
    enabled: config?.enabled !== false,
    onComplete: config?.onComplete !== false,
    onQuestion: config?.onQuestion !== false,
    onApproval: config?.onApproval === true,
    notifySubagents: config?.notifySubagents === true,
    appId: typeof config?.appId === 'string' && config.appId.trim() ? config.appId.trim() : 'DSH.Notify.Whale',
    appName: typeof config?.appName === 'string' && config.appName.trim() ? config.appName.trim() : 'DeepSeek Harness',
    iconPath: typeof config?.iconPath === 'string' && config.iconPath.trim() ? config.iconPath.trim() : DEFAULT_ICON,
    iconBackground: typeof config?.iconBackground === 'string' ? config.iconBackground.trim() : 'FFE8F0FC',
    silent: config?.silent === true,
    minTurnMs: Number.isFinite(config?.minTurnMs) ? Math.max(0, config.minTurnMs) : 1500,
    openOnClick: config?.openOnClick !== false,
    debug: config?.debug === true,
  }
  if (!options.enabled) return

  // clientModules 会把「这个包没有 dsh.client 声明」的结果按 sourceKey 永久缓存成 null，
  // 插件后补 client 半边时这份缓存不会自动失效，客户端模块就永远加载不到。
  // 这里只清掉自己那一条，让下一次扫描重新解析；正常安装（一开始就带 client）用不到。
  try {
    const cm = ctx.get('clientModules')
    const cache = cm?.pkgMeta
    let cleared = false
    if (cache instanceof Map) {
      for (const key of [...cache.keys()]) {
        if (typeof key === 'string' && key.endsWith('\u0000' + 'dsh-notify-toast')) {
          cache.delete(key)
          cleared = true
        }
      }
    }
    if (cleared && cm?.dirty instanceof Set && typeof cm.flush === 'function' && !cm.table?.has?.('dsh-notify-toast')) {
      cm.dirty.add('dsh-notify-toast')
      queueMicrotask(() => {
        try {
          cm.flush((err) => ctx.logger?.warn?.(err))
        } catch {
          // 重扫失败就等下次重载
        }
      })
    }
  } catch {
    // 拿不到内部缓存就按正常流程走
  }

  const log = (level, message) => {
    const line = '[dsh-notify-toast] ' + message
    try {
      ctx.logger?.[level]?.(line)
    } catch {
      // 日志服务不可用就算了
    }
    if (!options.debug) return
    try {
      appendFileSync(path.join(STATE_DIR, 'debug.log'), new Date().toISOString() + ' ' + line + '\n')
    } catch {
      // 调试日志写不了也不影响主流程
    }
  }

  // 脚本落在临时目录，只写一次。
  let scriptPath
  let clickScriptPath
  let clickLauncherPath
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    scriptPath = path.join(STATE_DIR, 'toast.ps1')
    writeFileSync(scriptPath, '\uFEFF' + TOAST_PS1, { encoding: 'utf8' })
    clickScriptPath = path.join(STATE_DIR, 'click.ps1')
    writeFileSync(clickScriptPath, '\uFEFF' + CLICK_PS1, { encoding: 'utf8' })
    // .vbs 必须是纯 ASCII 且不带 BOM，wscript 对 UTF-8 BOM 不友好。
    clickLauncherPath = path.join(STATE_DIR, 'click.vbs')
    writeFileSync(clickLauncherPath, CLICK_VBS.replace(/\r?\n/g, '\r\n'), { encoding: 'ascii' })
  } catch (error) {
    log('warn', '无法写入 PowerShell 脚本，通知功能停用：' + (error instanceof Error ? error.message : String(error)))
    return
  }

  const guiOrigin = () => {
    try {
      const origin = ctx.get('webServer')?.getOrigin?.()
      return typeof origin === 'string' ? origin : ''
    } catch {
      return ''
    }
  }

  // 点击 toast 后跳转用的自定义协议 URL（不是 http，否则会用默认浏览器打开）。
  const launchUrl = (sessionId, kind) => {
    if (!options.openOnClick) return ''
    const query = []
    if (sessionId) query.push('session=' + encodeURIComponent(String(sessionId)))
    if (kind) query.push('kind=' + encodeURIComponent(String(kind)))
    const origin = guiOrigin()
    if (origin) query.push('web=' + encodeURIComponent(origin))
    return PROTOCOL + '://open' + (query.length ? '?' + query.join('&') : '')
  }

  // ---- 点击回传：Client 半边轮询这里拿「要跳到哪条对话」 -----------------
  const sseClients = new Set()
  let lastPushId = ''
  let lastPushAt = 0

  function pushOpenRequest(payload) {
    if (!payload || !payload.sessionId) return
    // 一次点击会从两条路到达（click.ps1 的 POST + 请求文件的 watch 兜底），
    // 这里按会话去重，避免前端被推两次。
    const now = Date.now()
    if (payload.sessionId === lastPushId && now - lastPushAt < 2000) return
    lastPushId = payload.sessionId
    lastPushAt = now
    const frame = 'data: ' + JSON.stringify(payload) + '\n\n'
    for (const client of sseClients) {
      try {
        client.res.write(frame)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer?.register) {
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler(req, res) {
          const raw = String(req.url || '')
          if (raw.startsWith(API_PREFIX + '/log')) {
            try {
              appendFileSync(path.join(STATE_DIR, 'client.log'), new Date().toISOString() + ' ' + decodeURIComponent(raw.replace(/^[^?]*\?msg=/, '')) + '\n')
            } catch {
              // 写不了就算了
            }
            res.writeHead(204, { 'Cache-Control': 'no-store' })
            res.end()
            return
          }
          if (raw.startsWith(API_PREFIX + '/hello')) {
            appendFileSync(path.join(STATE_DIR, 'client-hello.log'), new Date().toISOString() + ' client half alive\n')
            let graph = null
            try {
              graph = ctx.get('clientModules')?.graph?.() ?? null
            } catch {
              graph = null
            }
            let probe = null
            try {
              const cm = ctx.get('clientModules')
              const cache = []
              try {
                for (const [k, v] of cm?.pkgMeta ?? []) {
                  if (String(k).includes('notify')) cache.push([String(k).split('\0')[1] ?? String(k), v === null ? 'null' : v === undefined ? 'undefined' : 'obj:' + v.packageName])
                }
              } catch (error) {
                cache.push(['ERR', String(error?.message || error)])
              }
              probe = { cache }
            } catch (error) {
              probe = 'ERR ' + String(error?.message || error)
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(
              JSON.stringify({
                ok: true,
                rev: graph?.rev ?? null,
                sse: sseClients.size,
                pendingFile: (() => {
                  try {
                    return readFileSync(REQUEST_FILE, 'utf8').trim() || null
                  } catch {
                    return null
                  }
                })(),
                self: (() => {
                  try {
                    return ctx.get('clientModules')?.clientPath?.('dsh-notify-toast') ?? null
                  } catch {
                    return null
                  }
                })(),
                entries: graph?.entries?.map((e) => e.id) ?? null,
                probe,
                loader: (() => {
                  try {
                    return Array.from(ctx.loader?.entries?.() ?? []).map((e) => e.options?.name ?? null)
                  } catch (error) {
                    return ['ERR ' + String(error)]
                  }
                })(),
              }),
            )
            return
          }
          if (raw.startsWith(API_PREFIX + '/click')) {
            // 点击处理器直接 POST 过来的即时通道。
            const sessionId = paramOf(raw, 'session')
            const kind = paramOf(raw, 'kind') || 'complete'
            if (sessionId) {
              try {
                unlinkSync(REQUEST_FILE)
              } catch {
                // 已经没有了
              }
              log('info', '通知被点击 session=' + sessionId)
              // 双通道：SSE 立即推 + 请求文件兜底。
              // 不能只看 sseClients.size——浏览器刷新/重连后旧连接可能没触发
              // close，集合里会残留死连接，导致「以为推到了」其实没人收到。
              // 前端按 2 秒窗口去重，两条路都到也只跳一次。
              try {
                writeFileSync(REQUEST_FILE, 'dshnotify://open?session=' + encodeURIComponent(sessionId) + '&kind=' + encodeURIComponent(kind), {
                  encoding: 'utf8',
                })
              } catch {
                // 写不进去就只靠 SSE
              }
              pushOpenRequest({ sessionId, kind })
            }
            res.writeHead(204, { 'Cache-Control': 'no-store' })
            res.end()
            return
          }
          if (raw.startsWith(API_PREFIX + '/events')) {
            // SSE：Host 主动把「点了哪条通知」推给浏览器。后台窗口的
            // setTimeout 会被 Chromium 节流/冻结，轮询不可靠，所以必须由
            // 服务端推。
            const client = { res }
            sseClients.add(client)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            })
            res.write(': connected\n\n')
            const drop = () => {
              sseClients.delete(client)
            }
            req.on('close', drop)
            req.on('error', drop)
            res.on('close', drop)
            res.on('error', drop)
            return
          }
          if (!raw.startsWith(API_PREFIX + '/pending')) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('not found')
            return
          }
          let payload = null
          try {
            const text = readFileSync(REQUEST_FILE, 'utf8').trim()
            if (text) {
              try {
                unlinkSync(REQUEST_FILE)
              } catch {
                // 删不掉下次还会返回一次，能接受
              }
              const sessionId = paramOf(text, 'session')
              if (sessionId) payload = { sessionId, kind: paramOf(text, 'kind') || 'complete' }
            }
          } catch {
            payload = null
          }
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(JSON.stringify(payload))
        },
      }),
    )
  } else {
    log('warn', 'webServer 不可用，点击通知后无法自动跳转会话')
  }

  // 注意：这里**不能**再挂 fs.watch 兜底。点击端点刚把请求写进文件，
  // watch 会在几十毫秒内抢先读走并 unlink，前端的轮询就永远读不到，
  // 表现就是「点了没反应」。请求文件只留给前端 /pending 消费。

  let inflight = 0
  const recent = new Map()

  function notify(kind, title, body, key, sessionId) {
    if (inflight >= 3) return
    const dedupeKey = kind + '|' + (key ?? '')
    const now = Date.now()
    const last = recent.get(dedupeKey)
    if (last && now - last < 2000) return
    recent.set(dedupeKey, now)
    if (recent.size > 64) {
      for (const [k, at] of recent) {
        if (now - at > 60000) recent.delete(k)
      }
    }

    const payload = {
      appId: options.appId,
      appName: options.appName,
      iconPath: options.iconPath,
      iconBackground: options.iconBackground,
      silent: options.silent,
      title,
      body,
      launch: launchUrl(sessionId, kind),
      protocol: PROTOCOL,
      clickScript: clickScriptPath,
      clickLauncher: clickLauncherPath,
    }
    let encoded
    try {
      encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    } catch {
      return
    }

    inflight += 1
    const finish = () => {
      inflight -= 1
    }
    try {
      if (options.debug) log('info', 'spawn toast kind=' + kind + ' title=' + title + ' launch=' + payload.launch)
      const handle = ctx.subprocess.spawn({
        argv: [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
        ],
        cwd: os.tmpdir(),
        stdio: {
          stdin: { data: encoded },
          stdout: { maxBytes: 8192 },
          stderr: { maxBytes: 8192 },
        },
        graceMs: 1500,
      })
      Promise.resolve(handle?.done)
        .then((outcome) => {
          if (options.debug) log('info', 'toast done exit=' + String(outcome?.exitCode))
          if (outcome && outcome.exitCode !== 0) {
            let detail = ''
            try {
              detail = String(handle?.collected?.stderr?.readFrom?.(0)?.text ?? '').trim()
            } catch {
              detail = ''
            }
            log('warn', '通知发送失败（exit ' + outcome.exitCode + '）' + (detail ? '：' + detail : ''))
          }
        })
        .catch((error) => {
          log('warn', '通知发送异常：' + (error instanceof Error ? error.message : String(error)))
        })
        .finally(finish)
    } catch (error) {
      finish()
      log('warn', '无法启动 PowerShell：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  // ---- 1. 任务完成 -------------------------------------------------------
  const runningSince = new Map()

  if (options.debug) log('info', 'plugin applied')

  ctx.effect(() =>
    ctx.on(
      'agent/status',
      (payload) => {
        const agent = payload?.agent
        const status = payload?.status
        const id = agent?.id
        if (options.debug) log('info', 'status event id=' + String(id) + ' status=' + String(status))
        if (!id) return

        if (status === 'running') {
          const session = ctx.get('sessions')?.get?.(id)
          runningSince.set(id, { at: Date.now(), seq: session?.seq ?? 0 })
          return
        }
        if (status !== 'idle') return

        const since = runningSince.get(id)
        runningSince.delete(id)
        if (since === undefined || !options.onComplete) return
        if (Date.now() - since.at < options.minTurnMs) return
        if (isSubagent(ctx, agent) && !options.notifySubagents) return

        let events = []
        try {
          const session = ctx.get('sessions')?.get?.(id)
          events = session?.snapshotEvents(since.seq) ?? []
        } catch {
          // A disposed/missing session must not reuse a previous run's answer.
        }
        const notice = completionNotice(events)
        let taskTitle = ''
        try {
          const session = ctx.get('sessions')?.get?.(id)
          if (session) taskTitle = clampText(ctx.get('sessionTitle')?.get?.(session)?.title, 64)
        } catch {
          // Title lookup must not prevent the result summary from being shown.
        }
        const heading = taskTitle ? notice.title + '：' + taskTitle : notice.title
        notify('complete', heading, notice.body, id, id)
      },
    ),
  )

  ctx.effect(() =>
    ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id
      if (id) runningSince.delete(id)
    }),
  )

  // ---- 2. 需要你选择 -----------------------------------------------------
  ctx.effect(() =>
    ctx.on(
      'user-questions/request',
      async (request, next) => {
        try {
          if (options.onQuestion) {
            const items = Array.isArray(request?.questions) ? request.questions : []
            const first = items[0] ?? {}
            const text = String(first.question ?? '').trim() || '有一个问题需要你回答。'
            const header = String(first.header ?? '').trim()
            const sessionId = String(request?.agent?.id ?? '')
            notify(
              'question',
              header ? '需要你选择：' + clampText(header, 24) : '需要你选择',
              clampText(text, 180),
              String(first.id ?? sessionId),
              sessionId,
            )
          }
        } catch (error) {
          log('warn', '提问通知失败：' + (error instanceof Error ? error.message : String(error)))
        }
        return next()
      },
      { global: true, prepend: true },
    ),
  )

  // ---- 3. 需要你批准 -----------------------------------------------------
  ctx.effect(() =>
    ctx.on(
      'approval/request',
      async (request, next) => {
        try {
          if (options.onApproval) {
            const tool = String(request?.toolName ?? '').trim()
            const reason = String(request?.reason ?? '').trim()
            const body = reason || (tool ? '操作：' + tool : '有一个操作等待你批准。')
            const sessionId = String(request?.agent?.id ?? '')
            notify('approval', '需要你批准', clampText(body, 180), String(request?.callId ?? tool), sessionId)
          }
        } catch (error) {
          log('warn', '批准通知失败：' + (error instanceof Error ? error.message : String(error)))
        }
        return next()
      },
      { global: true, prepend: true },
    ),
  )
}
