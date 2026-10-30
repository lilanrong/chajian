/**
 * dsh-notify-toast — Client 半边。
 *
 * 只做一件事：拿到「用户点了哪条通知」，就调用 uiWorkspace.openSession(sessionId)
 * 直接切到那条对话。两条通道：
 *  1. SSE（主通道）—— 订阅 Host 的 /dsh-notify-api/events，点一下几十毫秒就到，
 *     且不受后台标签页定时器冻结的影响。
 *  2. 低频轮询 /dsh-notify-api/pending（兜底）—— 覆盖 SSE 断开、重连的空窗。
 *
 * 两个关键点（都是踩过坑的）：
 *  1. 轮询器挂在模块作用域（不是 ctx.effect 里），插件热重载/界面重挂时不会把
 *     定时器收走，避免「点了没反应」。
 *  2. 刚启动时 sessions 服务可能还没扫到这条会话，openSession 会抛
 *     "sessions.retain: unknown session <id>"。所以必须重试，不能一次失败就丢，
 *     否则用户会被留在「新会话」页面上——这正是「点了却跳到新对话」的原因。
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify-toast',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const FIRST_DELAY = 120
    const POLL_MS = 350
    const RETRY_MS = 250
    const RETRY_WINDOW_MS = 60000
    const ENDPOINT = '/dsh-notify-api/pending'
    const EVENTS = '/dsh-notify-api/events'
    const HELLO = '/dsh-notify-api/hello'
    const LOG = '/dsh-notify-api/log?msg='

    let currentCtx = null
    let started = false
    let busy = false
    let jumping = false
    let lastJumpId = ''
    let lastJumpAt = 0
    let cycles = 0

    const report = (msg) => {
      try {
        void fetch(LOG + encodeURIComponent(msg), { cache: 'no-store' })
      } catch {
        // 上报失败无所谓
      }
    }

    const resolveWorkspace = () => {
      const ctx = currentCtx
      if (!ctx) return null
      try {
        const direct = ctx.get('uiWorkspace')
        if (direct && typeof direct.openSession === 'function') return direct
      } catch {
        // 换一种取法
      }
      try {
        const ws = ctx.uiWorkspace
        if (ws && typeof ws.openSession === 'function') return ws
      } catch {
        // 拿不到就算了
      }
      return null
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // 一直试到成功或超时：启动瞬间会话还没进索引时 openSession 会抛 unknown session。
    const openWithRetry = async (sessionId) => {
      const deadline = Date.now() + RETRY_WINDOW_MS
      let lastError = ''
      for (;;) {
        const workspace = resolveWorkspace()
        if (!workspace) {
          lastError = 'no uiWorkspace'
        } else {
          try {
            workspace.openSession(sessionId)
            report('opened ' + sessionId)
            return true
          } catch (error) {
            lastError = String(error && error.message ? error.message : error)
          }
        }
        if (Date.now() >= deadline) {
          report('open failed ' + sessionId + ': ' + lastError)
          return false
        }
        await sleep(RETRY_MS)
      }
    }

    const poll = async () => {
      if (busy || jumping) return
      busy = true
      let sessionId = ''
      try {
        let data = null
        try {
          const res = await fetch(ENDPOINT, { cache: 'no-store' })
          data = res.ok ? await res.json() : null
        } catch {
          data = null
        }
        sessionId = data && typeof data.sessionId === 'string' ? data.sessionId : ''
      } finally {
        busy = false
      }
      if (!sessionId) return
      await jump(sessionId)
    }

    const jump = async (sessionId) => {
      if (!sessionId || jumping) return
      // 同一次点击会从两条路到达（Host 的 SSE 推送 + 请求文件兜底），
      // 短时间内重复的同一个会话只处理一次。
      const now = Date.now()
      if (sessionId === lastJumpId && now - lastJumpAt < 2000) return
      lastJumpId = sessionId
      lastJumpAt = now
      jumping = true
      try {
        await openWithRetry(sessionId)
      } finally {
        jumping = false
      }
    }

    // 主通道：SSE。Host 一点通知就推过来，不依赖渲染器里的定时器
    // （后台窗口的 setTimeout 会被 Chromium 节流甚至冻结，这正是
    // 之前「点了没反应 / 停在新对话」的原因）。
    let source = null
    const connect = () => {
      if (source) return
      try {
        source = new EventSource('/dsh-notify-api/events')
        source.onmessage = (event) => {
          let data = null
          try {
            data = JSON.parse(event.data)
          } catch {
            data = null
          }
          if (data && typeof data.sessionId === 'string') void jump(data.sessionId)
        }
        source.onopen = () => report('sse open')
        source.onerror = () => {
          report('sse error')
          try {
            source.close()
          } catch {
            // ignore
          }
          source = null
          // EventSource 自带重连，但关掉后由我们自己重来一次更可控
          setTimeout(connect, 3000)
        }
      } catch (error) {
        source = null
        report('sse failed ' + String(error && error.message ? error.message : error))
      }
    }

    // 兜底：低频轮询 + 窗口重新可见时立刻补一次，覆盖 SSE 断开的情况。
    const tick = () => {
      cycles += 1
      if (cycles % 40 === 0) report('alive #' + cycles)
      void poll()
      setTimeout(tick, POLL_MS)
    }

    const start = () => {
      if (started) return
      started = true
      try {
        void fetch(HELLO, { cache: 'no-store' })
      } catch {
        // 报到失败不影响任何事
      }
      connect()
      setTimeout(tick, FIRST_DELAY)
      const wake = () => {
        connect()
        void poll()
      }
      try {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') wake()
        })
        window.addEventListener('focus', wake)
      } catch {
        // 没有 DOM 就算了
      }
    }

    function apply(ctx) {
      currentCtx = ctx
      start()
      ctx.effect(() => () => {
        // 故意不销毁：插件热重载时保持通道存活
      }, 'dsh-notify-toast: click channel')
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
