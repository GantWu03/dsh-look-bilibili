/**
 * Swappable full-frame Bilibili video background for the DSH Web frame.
 *
 * `shell.overlay` is `.overlayLayer { z-index: 20; pointer-events: none }`
 * inside the app frame, so an entry there paints ABOVE every column. The layer
 * is therefore made click-through (`pointer-events: none`) and kept readable
 * with a low opacity plus a radial mask that fades the video out where the
 * conversation column sits, so text keeps its contrast.
 *
 * The video itself is the official Bilibili embed player in an iframe; the only
 * thing that decides *what* plays is the iframe URL, so switching videos means
 * rewriting `src` (bvid+page for UGC, seasonId+episodeId for PGC, `t` for the
 * start offset, `muted` for audio). A paste box normalises links through the
 * Host's `/bili-player/resolve` route, which also pre-checks the target so an
 * unplayable video fails as a readable message instead of a black frame.
 */
window.__ModuleLoader__.load({
  id: 'dsh-look-bilibili',
  factory(require) {
    const REPORT = '/bili-player/report'
    const RESOLVE = '/bili-player/resolve'
    const CONTROL = '/bili-player/control'
    const POINTER = '/bili-player/pointer'
    const STORE_KEY = 'biliPlayer.state.v1'
    const TRANSPORT_KEY = 'biliPlayer.transport.v1'

    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))

    function formatClock(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = total % 60
      const pad = (value) => String(value).padStart(2, '0')
      return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
    }

    // Control-bar geometry of the Bilibili embed player, in player-page CSS px
    // measured from the bottom-left corner. It is stable across viewport sizes
    // (verified at 900x506 … 1920x1080): the seek bar is 16px tall and its
    // centre sits 76px above the bottom, starting 12px in from either side.
    const PLAYER = {
      progressInset: 12,
      progressFromBottom: 76,
      playCenterX: 33,
      playCenterFromBottom: 39,
    }

    function report(payload) {
      try {
        fetch(REPORT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: new Date().toISOString(), ...payload }),
          keepalive: true,
        }).catch(() => {})
      } catch {}
    }

    const LEVELS = [
      { key: 'weak', opacity: 0.3, center: 0.26, label: '弱' },
      { key: 'medium', opacity: 0.42, center: 0.14, label: '中' },
      { key: 'strong', opacity: 0.58, center: 0.04, label: '强' },
    ]

    const DEFAULT_STATE = {
      kind: 'video',
      bvid: 'BV18paz6kE8m',
      page: 2,
      pageCount: 9,
      seasonId: 0,
      episodeId: 0,
      episodes: [],
      seasonTitle: '',
      duration: 0,
      t: 0,
      muted: true,
      level: 1,
      enabled: true,
      title: 'FX战士久留美 · 第2话',
    }

    function loadState() {
      const fallback = { ...DEFAULT_STATE }
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return fallback
        return { ...fallback, ...parsed }
      } catch {
        return fallback
      }
    }

    function saveState(state) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(state))
      } catch {}
    }

    // The transport bar is a floating widget: collapsed to a 14px dot, expanded
    // on hover, and draggable anywhere in the viewport. Only the position is
    // remembered; it always starts collapsed.
    const TRANSPORT_DOT = 14
    const TRANSPORT_ROW_H = 26
    const TRANSPORT_GAP = 6
    const TRANSPORT_MARGIN = 6
    const TRANSPORT_FALLBACK_W = 360

    function defaultTransportPos() {
      const viewportH = window.innerHeight || 800
      // Bottom-left corner, near where the old status pill used to sit. The
      // stored value is the widget's vertical CENTRE (the card expands around
      // the dot symmetrically).
      return { x: 12, y: Math.max(TRANSPORT_MARGIN + TRANSPORT_ROW_H, viewportH - 26) }
    }

    function loadTransportPos() {
      const fallback = defaultTransportPos()
      try {
        const raw = window.localStorage.getItem(TRANSPORT_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        const x = Number(parsed && parsed.x)
        const y = Number(parsed && parsed.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback
        return { x, y }
      } catch {
        return fallback
      }
    }

    function saveTransportPos(pos) {
      try {
        window.localStorage.setItem(TRANSPORT_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }))
      } catch {}
    }

    function buildSrc(state) {
      const params = new URLSearchParams()
      if (state.kind === 'pgc' && state.episodeId) {
        if (state.seasonId) params.set('seasonId', String(state.seasonId))
        params.set('episodeId', String(state.episodeId))
      } else {
        params.set('bvid', String(state.bvid || DEFAULT_STATE.bvid))
        params.set('page', String(state.page || 1))
      }
      params.set('autoplay', '1')
      params.set('danmaku', '0')
      params.set('muted', state.muted ? '1' : '0')
      if (Number(state.t) > 0) params.set('t', String(Math.round(Number(state.t))))
      return `https://player.bilibili.com/player.html?${params.toString()}`
    }

    // Duration of the *selected* page / episode, so the transport can turn a
    // seek ratio into a `t=` offset without asking the player (the embed page is
    // cross-origin: its `currentTime` is not readable).
    function pickDuration(data) {
      if (!data) return 0
      if (data.kind === 'pgc') {
        const list = Array.isArray(data.episodes) ? data.episodes : []
        const current = list.find((entry) => Number(entry.id) === Number(data.episodeId))
        return Number((current && current.duration) || 0)
      }
      const pages = Array.isArray(data.pages) ? data.pages : []
      const current = pages.find((entry) => Number(entry.page) === Number(data.page || 1))
      return Number((current && current.duration) || 0)
    }

    function parseStart(text) {
      const raw = String(text ?? '').trim()
      if (!raw) return 0
      if (/^\d+$/.test(raw)) return Number(raw)
      const parts = raw.split(':').map((part) => Number(part.trim()))
      if (parts.length > 1 && parts.every((value) => Number.isFinite(value))) {
        return parts.reduce((acc, value) => acc * 60 + value, 0)
      }
      const match = raw.match(/^(\d+(?:\.\d+)?)\s*(h|m|s)$/i)
      if (match) {
        const amount = Number(match[1])
        const unit = match[2].toLowerCase()
        return Math.round(unit === 'h' ? amount * 3600 : unit === 'm' ? amount * 60 : amount)
      }
      return 0
    }

    try {
      const React = require('react')
      const h = React.createElement

      const PILL_BUTTON = {
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: '16px',
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'transparent',
        color: 'inherit',
        pointerEvents: 'auto',
      }

      const INPUT = {
        width: '100%',
        boxSizing: 'border-box',
        marginTop: 6,
        padding: '4px 7px',
        borderRadius: 7,
        border: '1px solid rgba(255,255,255,.24)',
        background: 'rgba(0,0,0,.42)',
        color: '#fff',
        fontSize: 11,
        outline: 'none',
      }

      function Widget() {
        const [state, setState] = React.useState(loadState)
        const [open, setOpen] = React.useState(false)
        const [text, setText] = React.useState('')
        const [info, setInfo] = React.useState(null)
        const [error, setError] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [startText, setStartText] = React.useState('0')
        const [playing, setPlaying] = React.useState(true)
        const [hitThrough, setHitThrough] = React.useState(false)
        const [pos, setPos] = React.useState(() => Number(loadState().t) || 0)
        const [note, setNote] = React.useState('')
        const revRef = React.useRef(0)
        const busyRef = React.useRef(false)
        const frameRef = React.useRef(null)
        const hitThroughRef = React.useRef(false)
        const draggingRef = React.useRef(false)

        // floating transport: collapsed dot -> hover expands
        const [tpOpen, setTpOpen] = React.useState(false)
        const [tpDragging, setTpDragging] = React.useState(false)
        const [tpPos, setTpPos] = React.useState(loadTransportPos)
        const tpPosRef = React.useRef(tpPos)
        const tpDragRef = React.useRef(null)
        const tpRootRef = React.useRef(null)
        const tpBarRef = React.useRef(null)
        // Measured size of the EXPANDED card (+ dot), used to keep the widget on
        // screen in both states.
        const tpSizeRef = React.useRef({ w: TRANSPORT_FALLBACK_W, h: TRANSPORT_ROW_H })
        const tpTimerRef = React.useRef(0)
        const tpHoldRef = React.useRef(0)

        const clampTransport = React.useCallback((x, y) => {
          const viewportW = window.innerWidth || 1280
          const viewportH = window.innerHeight || 800
          const { w, h } = tpSizeRef.current
          // Keep the *expanded* card on screen, so it never opens off the edge.
          // `y` is the vertical centre, hence the half-height on both sides.
          const maxX = Math.max(TRANSPORT_MARGIN, viewportW - w - TRANSPORT_MARGIN)
          const maxY = Math.max(TRANSPORT_MARGIN + h / 2, viewportH - h / 2 - TRANSPORT_MARGIN)
          return {
            x: Math.round(Math.max(TRANSPORT_MARGIN, Math.min(maxX, x))),
            y: Math.round(Math.max(h / 2 + TRANSPORT_MARGIN, Math.min(maxY, y))),
          }
        }, [])

        React.useEffect(() => {
          hitThroughRef.current = hitThrough
        }, [hitThrough])

        React.useEffect(() => {
          tpPosRef.current = tpPos
          saveTransportPos(tpPos)
        }, [tpPos])

        // A resize can leave the stored position off screen.
        React.useEffect(() => {
          const onResize = () => setTpPos((prev) => {
            const next = clampTransport(prev.x, prev.y)
            return next.x === prev.x && next.y === prev.y ? prev : next
          })
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        }, [clampTransport])

        React.useEffect(() => () => {
          if (tpTimerRef.current) window.clearTimeout(tpTimerRef.current)
        }, [])

        const expandTransport = () => {
          if (tpTimerRef.current) {
            window.clearTimeout(tpTimerRef.current)
            tpTimerRef.current = 0
          }
          setTpOpen(true)
        }

        const cancelCollapse = () => {
          if (tpTimerRef.current) {
            window.clearTimeout(tpTimerRef.current)
            tpTimerRef.current = 0
          }
        }

        // Collapse later, but never while the user is actually using the bar:
        // dragging it, dragging the seek slider, mid-injection (pointer-events
        // are off then, so a synthetic `pointerleave` is meaningless), or right
        // after a click.
        const scheduleCollapse = (delay) => {
          if (tpTimerRef.current) window.clearTimeout(tpTimerRef.current)
          const tick = () => {
            const busy = tpDragRef.current || draggingRef.current || hitThroughRef.current || Date.now() < tpHoldRef.current
            if (busy) {
              tpTimerRef.current = window.setTimeout(tick, 240)
              return
            }
            tpTimerRef.current = 0
            setTpOpen(false)
          }
          tpTimerRef.current = window.setTimeout(tick, delay)
        }

        // Collapse is driven by the real cursor position rather than by
        // enter/leave events: expanding moves the card around the dot, and
        // those layout changes can emit spurious `pointerleave`, which made the
        // card flicker open/closed.
        React.useEffect(() => {
          if (!tpOpen) return undefined
          const onMove = (event) => {
            const node = tpRootRef.current
            if (!node) return
            const rect = node.getBoundingClientRect()
            const pad = 6
            const inside = event.clientX >= rect.left - pad && event.clientX <= rect.right + pad
              && event.clientY >= rect.top - pad && event.clientY <= rect.bottom + pad
            if (inside) cancelCollapse()
            else scheduleCollapse(420)
          }
          window.addEventListener('pointermove', onMove, true)
          return () => window.removeEventListener('pointermove', onMove, true)
        }, [tpOpen])

        const holdTransport = (ms) => {
          tpHoldRef.current = Date.now() + ms
        }

        const onGripPointerDown = (event) => {
          event.preventDefault()
          event.stopPropagation()
          expandTransport()
          holdTransport(6000)
          setTpDragging(true)
          const node = event.currentTarget
          try { node.setPointerCapture(event.pointerId) } catch {}
          tpDragRef.current = {
            id: event.pointerId,
            sx: event.clientX,
            sy: event.clientY,
            ox: tpPosRef.current.x,
            oy: tpPosRef.current.y,
            moved: false,
          }
        }

        const onGripPointerMove = (event) => {
          const drag = tpDragRef.current
          if (!drag || drag.id !== event.pointerId) return
          const dx = event.clientX - drag.sx
          const dy = event.clientY - drag.sy
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return
          drag.moved = true
          setTpPos(clampTransport(drag.ox + dx, drag.oy + dy))
        }

        const onGripPointerUp = (event) => {
          const drag = tpDragRef.current
          if (!drag || drag.id !== event.pointerId) return
          tpDragRef.current = null
          setTpDragging(false)
          holdTransport(900)
          if (drag.moved) {
            report({ ev: 'transport-move', x: tpPosRef.current.x, y: tpPosRef.current.y })
          }
          // The widget followed the pointer, so it usually ends up under it:
          // keep it open in that case, otherwise collapse as usual.
          const node = tpRootRef.current
          if (node) {
            const rect = node.getBoundingClientRect()
            const pad = 6
            const inside = event.clientX >= rect.left - pad && event.clientX <= rect.right + pad
              && event.clientY >= rect.top - pad && event.clientY <= rect.bottom + pad
            if (inside) {
              cancelCollapse()
              return
            }
          }
          scheduleCollapse(700)
        }

        // Measure the expanded card so the drag clamp accounts for its real
        // size; `animate` gives the expansion a little slide-in without needing
        // a stylesheet.
        //
        // NOTE: this ref callback MUST keep a stable identity. React re-invokes
        // an inline ref callback on every render (detach -> attach), and the
        // playhead ticker re-renders once a second, which replayed the expand
        // animation every second (the card looked like it kept closing and
        // reopening).
        const measureTransport = React.useCallback((node) => {
          const previous = tpBarRef.current
          tpBarRef.current = node
          if (!node) return
          const rect = node.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            tpSizeRef.current = {
              w: rect.width + TRANSPORT_GAP + TRANSPORT_DOT,
              h: Math.max(TRANSPORT_ROW_H, rect.height),
            }
          }
          setTpPos((prev) => {
            const next = clampTransport(prev.x, prev.y)
            return next.x === prev.x && next.y === prev.y ? prev : next
          })
          if (previous !== node && typeof node.animate === 'function') {
            node.animate(
              [{ opacity: 0, transform: 'translateX(-6px) scale(.97)' }, { opacity: 1, transform: 'none' }],
              { duration: 140, easing: 'ease-out' },
            )
          }
        }, [clampTransport])

        const src = buildSrc(state)
        const level = LEVELS[state.level] || LEVELS[1]
        const duration = Number(state.duration) || 0
        const mask = `radial-gradient(ellipse 68% 62% at 50% 50%, rgba(0,0,0,${level.center}) 0%, rgba(0,0,0,${Math.min(1, level.center + 0.35)}) 60%, #000 100%)`

        const applyState = React.useCallback((patch) => {
          setState((prev) => {
            const next = { ...prev, ...patch }
            saveState(next)
            return next
          })
        }, [])

        React.useEffect(() => {
          report({ ev: 'apply', src, muted: state.muted, kind: state.kind, bvid: state.bvid, page: state.page, episodeId: state.episodeId, t: state.t })
        }, [src])

        React.useEffect(() => {
          report({ ev: 'mount', viewport: { w: window.innerWidth, h: window.innerHeight }, muted: state.muted })
        }, [])

        const resolveText = React.useCallback(async (input) => {
          const trimmed = String(input || '').trim()
          if (!trimmed) {
            setError('先粘一个链接或 BV 号')
            return null
          }
          setBusy(true)
          setError('')
          try {
            const response = await fetch(`${RESOLVE}?text=${encodeURIComponent(trimmed)}`, { cache: 'no-store' })
            const data = await response.json()
            report({
              ev: 'resolve',
              ok: !!data.ok,
              title: data.title || '',
              pages: Array.isArray(data.pages) ? data.pages.length : 0,
              episodes: Array.isArray(data.episodes) ? data.episodes.length : 0,
              error: data.error || '',
              input: trimmed.slice(0, 160),
            })
            if (!data.ok) {
              setInfo(null)
              setError(data.error || '解析失败')
              return null
            }
            setInfo(data)
            setStartText(String(Number(data.t) || 0))
            return data
          } catch (err) {
            const message = String((err && err.message) || err)
            setError(`解析请求失败：${message}`)
            report({ ev: 'resolve-error', error: message })
            return null
          } finally {
            setBusy(false)
          }
        }, [])

        const commit = React.useCallback((data, tOverride) => {
          if (!data) return
          const t = tOverride != null ? tOverride : parseStart(startText)
          const episodes = Array.isArray(data.episodes)
            ? data.episodes.map((entry) => ({ id: Number(entry.id) || 0, title: String(entry.title || '') }))
            : []
          if (data.kind === 'pgc') {
            const title = data.title + (data.episodeTitle ? ` · ${data.episodeTitle}` : '')
            applyState({
              kind: 'pgc',
              seasonId: data.seasonId || 0,
              episodeId: data.episodeId || 0,
              bvid: '',
              page: 1,
              pageCount: 0,
              episodes,
              seasonTitle: String(data.title || ''),
              duration: pickDuration({ ...data, episodeId: data.episodeId }),
              t,
              title,
            })
          } else {
            applyState({
              kind: 'video',
              bvid: data.bvid,
              page: data.page || 1,
              pageCount: data.pageCount || (Array.isArray(data.pages) ? data.pages.length : 1),
              seasonId: 0,
              episodeId: 0,
              episodes: [],
              seasonTitle: '',
              duration: pickDuration({ ...data, page: data.page || 1 }),
              t,
              title: data.title || data.bvid,
            })
          }
          report({ ev: 'commit', kind: data.kind, bvid: data.bvid || '', page: data.page || 0, t, title: data.title || '', duration: pickDuration(data) })
          setOpen(false)
        }, [applyState, startText])

        // ---- transport -----------------------------------------------------
        // Seeking goes through the `t=` parameter because the embed page is
        // cross-origin (its `currentTime` cannot be read, and Bilibili's own
        // progress bar does not commit a seek on a synthetic click). Pause and
        // chrome hiding go through Win32 injection, which the player does honour.
        const postPointer = React.useCallback(async (action, pageX, pageY, extra) => {
          const frame = frameRef.current
          if (!frame) return { ok: false, error: '播放器还没准备好' }
          const dpr = window.devicePixelRatio || 1
          const rect = frame.getBoundingClientRect()
          const maxX = Math.round(window.innerWidth * dpr) - 2
          const maxY = Math.round(window.innerHeight * dpr) - 2
          // The iframe is deliberately oversized (`max(100vw, 177.78vh)`) and
          // centred, so its left/right edges stick out of the window. Clamp the
          // target into the visible client area instead of posting off-window.
          const rawX = Math.round((rect.left + pageX) * dpr)
          const rawY = Math.round((rect.top + pageY) * dpr)
          const x = Math.max(2, Math.min(maxX, rawX))
          const y = Math.max(2, Math.min(maxY, rawY))
          setHitThrough(true)
          await sleep(40) // let React commit `pointer-events: auto` before posting
          try {
            const response = await fetch(POINTER, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, x, y, ...extra }),
            })
            const data = await response.json()
            report({ ev: 'inject', action, x, y, clamped: x !== rawX || y !== rawY, ok: !!(data && data.ok), ms: (data && data.ms) || 0, error: (data && data.error) || '' })
            return data || { ok: false, error: '空响应' }
          } catch (err) {
            return { ok: false, error: String((err && err.message) || err) }
          } finally {
            // PostMessage only queues the message; keep the iframe hit-testable
            // until Chromium has certainly processed it.
            window.setTimeout(() => setHitThrough(false), 180)
          }
        }, [])

        const hideChrome = React.useCallback(() => {
          const frame = frameRef.current
          if (!frame) return undefined
          const rect = frame.getBoundingClientRect()
          // One posted move is what makes the player start its idle timer; it
          // fades its own chrome out ~3s later and never brings it back while
          // the iframe stays click-through.
          return postPointer('move', rect.width / 2, rect.height / 2)
        }, [postPointer])

        const togglePlay = React.useCallback(async () => {
          const frame = frameRef.current
          if (!frame) return
          const rect = frame.getBoundingClientRect()
          const result = await postPointer('click', PLAYER.playCenterX, rect.height - PLAYER.playCenterFromBottom)
          if (!result || !result.ok) {
            setNote((result && result.error) || '注入失败')
            return
          }
          setNote('')
          setPlaying((value) => !value)
        }, [postPointer])

        const seekTo = React.useCallback((ratio) => {
          const clamped = Math.max(0, Math.min(1, Number(ratio) || 0))
          if (!duration) {
            setNote('时长未知，先用「换片」解析一次')
            return
          }
          const t = Math.max(0, Math.min(Math.round(duration) - 1, Math.round(clamped * duration)))
          setNote('')
          setPos(t)
          setPlaying(true) // a `t=` reload always restarts playback
          report({ ev: 'seek', ratio: Number(clamped.toFixed(4)), t, duration })
          applyState({ t })
        }, [applyState, duration])

        const stepPage = React.useCallback((delta) => {
          if (state.kind === 'pgc') {
            const list = Array.isArray(state.episodes) ? state.episodes : []
            const index = list.findIndex((entry) => Number(entry.id) === Number(state.episodeId))
            const next = list[index + delta]
            if (!next) {
              setNote(delta > 0 ? '已经是最后一集' : '已经是第一集')
              return
            }
            setNote('')
            setPos(0)
            report({ ev: 'step', delta, episodeId: next.id })
            applyState({
              episodeId: Number(next.id) || 0,
              t: 0,
              title: [state.seasonTitle, next.title].filter(Boolean).join(' · ') || state.title,
            })
            return
          }
          const nextPage = Number(state.page || 1) + delta
          const total = Number(state.pageCount) || 1
          if (nextPage < 1) {
            setNote('已经是第一话')
            return
          }
          if (total > 1 && nextPage > total) {
            setNote('已经是最后一话')
            return
          }
          setNote('')
          setPos(0)
          report({ ev: 'step', delta, page: nextPage })
          applyState({ page: nextPage, t: 0 })
        }, [applyState, state.episodes, state.episodeId, state.kind, state.page, state.pageCount, state.seasonTitle, state.title])

        // Start the player's own idle timer once the page is up, so its title
        // bar and control bar fade out on their own.
        React.useEffect(() => {
          if (!state.enabled) return undefined
          const timer = window.setTimeout(() => {
            void hideChrome()
          }, 2600)
          return () => window.clearTimeout(timer)
        }, [src, state.enabled, hideChrome])

        // Optimistic playhead: the real position is unreadable, so the slider
        // tracks the last seek and advances while playback is presumed running.
        React.useEffect(() => {
          setPos(Number(state.t) || 0)
        }, [src])

        React.useEffect(() => {
          if (!playing || !duration) return undefined
          const timer = window.setInterval(() => {
            if (draggingRef.current) return
            setPos((value) => Math.min(duration, value + 1))
          }, 1000)
          return () => window.clearInterval(timer)
        }, [playing, duration])

        // Fill in the duration once, so a stored state without it still gets a
        // working seek bar on the next launch.
        React.useEffect(() => {
          if (Number(state.duration) > 0) return undefined
          const target = state.kind === 'pgc' && state.episodeId ? `ep${state.episodeId}` : String(state.bvid || '')
          if (!target) return undefined
          let cancelled = false
          void (async () => {
            try {
              const response = await fetch(`${RESOLVE}?text=${encodeURIComponent(target)}`, { cache: 'no-store' })
              const data = await response.json()
              if (cancelled || !data || !data.ok) return
              const patch = { duration: pickDuration(data) }
              if (data.kind === 'pgc' && Array.isArray(data.episodes)) {
                patch.episodes = data.episodes.map((entry) => ({ id: Number(entry.id) || 0, title: String(entry.title || '') }))
                patch.seasonTitle = String(data.title || '')
              } else if (Array.isArray(data.pages)) {
                patch.pageCount = data.pages.length
              }
              applyState(patch)
              report({ ev: 'duration', duration: patch.duration, pages: data.pages ? data.pages.length : 0 })
            } catch (err) {
              report({ ev: 'duration-error', error: String((err && err.message) || err) })
            }
          })()
          return () => { cancelled = true }
        }, [])

        React.useEffect(() => {
          let stopped = false
          const tick = async () => {
            if (stopped || busyRef.current) return
            try {
              const response = await fetch(CONTROL, { cache: 'no-store' })
              if (!response.ok) return
              const data = await response.json()
              const cmd = data && data.cmd
              if (!cmd || !cmd.rev || cmd.rev <= revRef.current) return
              revRef.current = cmd.rev
              report({ ev: 'control', action: String(cmd.action || ''), hasInput: !!cmd.input })
              busyRef.current = true
              if (cmd.action === 'apply' && cmd.input) {
                const resolved = await resolveText(cmd.input)
                if (resolved) {
                  if (cmd.page) resolved.page = Number(cmd.page)
                  if (cmd.episodeId) resolved.episodeId = Number(cmd.episodeId)
                  commit(resolved, cmd.t != null ? Number(cmd.t) : 0)
                }
              } else if (cmd.action === 'set') {
                const patch = {}
                if (cmd.page != null) patch.page = Number(cmd.page)
                if (cmd.t != null) patch.t = Number(cmd.t)
                if (cmd.muted != null) patch.muted = !!cmd.muted
                if (cmd.enabled != null) patch.enabled = !!cmd.enabled
                if (cmd.level != null) patch.level = Math.max(0, Math.min(LEVELS.length - 1, Number(cmd.level)))
                if (Object.keys(patch).length) applyState(patch)
              } else if (cmd.action === 'panel') {
                setOpen(!!cmd.open)
              }
            } catch {
            } finally {
              busyRef.current = false
            }
          }
          const timer = window.setInterval(tick, 1200)
          return () => {
            stopped = true
            window.clearInterval(timer)
          }
        }, [applyState, commit, resolveText])

        const pillButton = (label, onClick, active, act) => h('button', {
          type: 'button',
          onClick,
          'data-bili-ctrl': act,
          style: { ...PILL_BUTTON, background: active ? 'rgba(90,208,164,.28)' : 'transparent' },
        }, label)

        const infoBlock = (data) => {
          const children = [
            h('div', {
              key: 'title',
              style: { marginTop: 8, fontSize: 11.5, fontWeight: 600, whiteSpace: 'normal', wordBreak: 'break-all' },
            }, data.title || '(无标题)'),
          ]
          if (data.owner) {
            children.push(h('div', { key: 'owner', style: { fontSize: 10.5, opacity: 0.7, marginTop: 1 } }, data.owner))
          }
          for (const warning of data.warnings || []) {
            children.push(h('div', { key: `w-${warning}`, style: { fontSize: 10.5, color: '#ffcc66', marginTop: 3 } }, warning))
          }
          const items = data.kind === 'pgc'
            ? data.episodes.map((episode) => ({
              key: `ep-${episode.id}`,
              label: episode.title || `ep${episode.id}`,
              active: episode.id === data.episodeId,
              pick: () => setInfo({ ...data, episodeId: episode.id, episodeTitle: episode.title }),
            }))
            : (data.pages || []).map((page) => ({
              key: `p-${page.page}`,
              label: `P${page.page} ${page.part || ''}`.trim(),
              active: page.page === data.page,
              pick: () => setInfo({ ...data, page: page.page }),
            }))
          if (items.length > 1) {
            children.push(h('div', {
              key: 'list',
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                maxHeight: 148,
                overflowY: 'auto',
                marginTop: 8,
                paddingRight: 2,
              },
            }, items.map((item) => h('button', {
              key: item.key,
              type: 'button',
              onClick: item.pick,
              style: {
                ...PILL_BUTTON,
                textAlign: 'left',
                borderRadius: 7,
                fontSize: 10.5,
                padding: '3px 7px',
                whiteSpace: 'normal',
                wordBreak: 'break-all',
                background: item.active ? 'rgba(90,208,164,.28)' : 'transparent',
              },
            }, item.label))))
          }
          children.push(h('div', { key: 'start', style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 } },
            h('span', { style: { fontSize: 10.5, opacity: 0.75, flex: 'none' } }, '起点'),
            h('input', {
              value: startText,
              onChange: (event) => setStartText(event.target.value),
              placeholder: '秒或 mm:ss',
              style: { ...INPUT, width: 78, marginTop: 0, flex: 'none' },
            }),
            h('button', {
              type: 'button',
              onClick: () => commit(data, undefined),
              style: {
                ...PILL_BUTTON,
                marginLeft: 'auto',
                padding: '3px 9px',
                background: 'rgba(90,208,164,.34)',
              },
            }, '用这个当背景')))
          return h('div', { key: 'info' }, children)
        }

        const panel = open ? h('div', {
          key: 'panel',
          style: {
            position: 'fixed',
            left: Math.max(6, tpPos.x),
            // Sits above the floating widget, wherever the user dragged it.
            bottom: Math.min(window.innerHeight - 120, Math.max(6, Math.round(window.innerHeight - tpPos.y + 40))),
            width: 340,
            maxHeight: '62vh',
            overflowY: 'auto',
            padding: '9px 10px',
            borderRadius: 11,
            background: 'rgba(14,14,16,.94)',
            color: '#fff',
            fontSize: 11,
            lineHeight: 1.45,
            border: '1px solid rgba(255,255,255,.2)',
            boxShadow: '0 12px 34px rgba(0,0,0,.5)',
            pointerEvents: hitThrough ? 'none' : 'auto',
          },
        },
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('span', { style: { fontWeight: 600 } }, '换背景视频'),
          h('button', { type: 'button', onClick: () => setOpen(false), style: PILL_BUTTON }, '关闭')),
        h('div', { key: 'current', style: { fontSize: 10.5, opacity: 0.72, marginTop: 4, whiteSpace: 'normal', wordBreak: 'break-all' } },
          `当前：${state.title || state.bvid || '未设置'}`),
        h('input', {
          key: 'input',
          value: text,
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !busy) void resolveText(text)
          },
          placeholder: '粘贴 B 站链接 / BV 号 / b23.tv 短链',
          style: INPUT,
        }),
        h('div', { key: 'actions', style: { display: 'flex', gap: 6, marginTop: 7 } },
          pillButton(busy ? '解析中…' : '解析', () => { if (!busy) void resolveText(text) }, false),
          pillButton('用当前设置', () => { if (info) commit(info, undefined) }, false)),
        error ? h('div', {
          key: 'error',
          style: { marginTop: 7, fontSize: 10.5, color: '#ff8a8a', whiteSpace: 'normal', wordBreak: 'break-all' },
        }, error) : null,
        info ? infoBlock(info) : null) : null

        return h('div', {
          style: { position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 },
        },
        state.enabled ? h('iframe', {
          key: src,
          ref: frameRef,
          src,
          title: 'Bilibili background',
          allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
          allowFullScreen: true,
          style: {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'max(100vw, 177.78vh)',
            height: 'max(100vh, 56.25vw)',
            border: 0,
            // Click-through by design (the chat must stay usable). Injection
            // flips this to `auto` for the ~200ms around a posted message,
            // otherwise Chromium's hit test skips the iframe.
            pointerEvents: hitThrough ? 'auto' : 'none',
            opacity: level.opacity,
            maskImage: mask,
            WebkitMaskImage: mask,
            transition: 'opacity .25s ease',
            background: '#000',
          },
        }) : null,
        panel,
        h('div', {
          key: 'transport',
          ref: tpRootRef,
          onPointerEnter: () => expandTransport(),
          onPointerDown: () => holdTransport(1200),
          style: {
            position: 'fixed',
            left: tpPos.x,
            top: tpPos.y,
            // Anchored by its vertical centre, so the dot keeps its place when
            // the card grows around it during expansion.
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: TRANSPORT_GAP,
            // While collapsed only the dot shows, but a slightly wider strip
            // stays hoverable so the 14px target is not fiddly.
            minWidth: tpOpen ? undefined : TRANSPORT_DOT + 10,
            pointerEvents: hitThrough ? 'none' : 'auto',
            zIndex: 2,
          },
        },
        // Invisible pad: a 14px dot is a fiddly hover target, and an absolute
        // child enlarges the hit area without shifting the dot on expand.
        tpOpen ? null : h('span', {
          key: 'pad',
          style: {
            position: 'absolute',
            left: -7,
            top: -7,
            right: -7,
            bottom: -7,
            borderRadius: 999,
          },
        }),
        // The dot doubles as the drag handle: it is the only thing visible while
        // collapsed, and the grab point once expanded.
        h('div', {
          key: 'grip',
          'data-bili-ctrl': 'grip',
          title: '拖动移动位置 · 悬停展开 · 双击回到左下角',
          onPointerDown: onGripPointerDown,
          onPointerMove: onGripPointerMove,
          onPointerUp: onGripPointerUp,
          onPointerCancel: onGripPointerUp,
          onDoubleClick: () => {
            cancelCollapse()
            setTpPos(defaultTransportPos())
            report({ ev: 'transport-reset' })
          },
          style: {
            flex: 'none',
            width: TRANSPORT_DOT,
            height: TRANSPORT_DOT,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: tpOpen ? 'rgba(22,22,26,.92)' : 'rgba(16,16,16,.72)',
            border: '1px solid rgba(255,255,255,.42)',
            boxShadow: '0 2px 8px rgba(0,0,0,.45)',
            cursor: tpDragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            transition: 'background .16s ease, border-color .16s ease',
          },
        }, h('span', {
          style: {
            width: 4,
            height: 4,
            borderRadius: 999,
            background: tpOpen ? 'rgba(255,255,255,.85)' : '#5ad0a4',
            transition: 'background .16s ease',
          },
        })),
        tpOpen ? h('div', {
          key: 'card',
          ref: measureTransport,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '5px 8px',
            borderRadius: 12,
            background: 'rgba(16,16,16,.86)',
            color: '#fff',
            fontSize: 11,
            border: '1px solid rgba(255,255,255,.22)',
            boxShadow: '0 8px 26px rgba(0,0,0,.45)',
            backdropFilter: 'blur(6px)',
            whiteSpace: 'nowrap',
          },
        },
        state.enabled ? h('div', {
          key: 'row1',
          style: { display: 'flex', gap: 6, alignItems: 'center' },
        },
        pillButton('⏮', () => stepPage(-1), false, 'prev'),
        h('input', {
          key: 'seek',
          'data-bili-ctrl': 'seek',
          type: 'range',
          min: 0,
          max: 1000,
          step: 1,
          value: Math.round((duration > 0 ? Math.min(1, pos / duration) : 0) * 1000),
          onPointerDown: () => { draggingRef.current = true },
          onChange: (event) => {
            const ratio = Number(event.target.value) / 1000
            setPos(duration > 0 ? ratio * duration : 0)
          },
          onPointerUp: (event) => {
            draggingRef.current = false
            // Derive the ratio from the pointer position (the same mapping the
            // browser uses internally) instead of reading `value`, which can be
            // rolled back by a React render landing between two posted moves.
            const track = event.currentTarget
            const rect = track.getBoundingClientRect()
            const inset = 8
            const usable = Math.max(1, rect.width - inset * 2)
            seekTo((event.clientX - rect.left - inset) / usable)
          },
          onPointerCancel: () => { draggingRef.current = false },
          onKeyUp: (event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
              seekTo(Number(event.currentTarget.value) / 1000)
            }
          },
          title: duration > 0 ? `拖到 ${formatClock(duration)} 内任意位置` : '时长未知',
          style: { width: 190, accentColor: '#5ad0a4', cursor: 'pointer' },
        }),
        pillButton(playing ? '⏸' : '▶', () => { void togglePlay() }, false, 'play'),
        pillButton('⏭', () => stepPage(1), false, 'next'),
        h('span', {
          key: 'clock',
          style: { opacity: 0.82, flex: 'none', fontVariantNumeric: 'tabular-nums' },
        }, duration > 0 ? `${formatClock(pos)} / ${formatClock(duration)}` : '--:--'),
        note ? h('span', { key: 'note', style: { color: '#ffcc66', flex: 'none', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, note) : null) : null,
        h('div', {
          key: 'row2',
          style: { display: 'flex', gap: 6, alignItems: 'center' },
        },
        h('span', { style: { opacity: 0.85, flex: 'none' } }, 'B站背景'),
        h('span', { style: { opacity: 0.66, flex: 'none', fontSize: 10.5, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          state.pageCount > 1 && state.kind !== 'pgc' ? `P${state.page}` : ''),
        pillButton(state.enabled ? '关' : '开', () => applyState({ enabled: !state.enabled }), state.enabled),
        pillButton('弱', () => applyState({ level: 0 }), state.level === 0),
        pillButton('中', () => applyState({ level: 1 }), state.level === 1),
        pillButton('强', () => applyState({ level: 2 }), state.level === 2),
        pillButton(state.muted ? '静音' : '有声', () => applyState({ muted: !state.muted }), state.muted),
        pillButton('换片', () => setOpen((value) => !value), open))) : null))
      }

      // ---- boot animation -------------------------------------------------
      // A 16:9 splash clip shipped in `assets/splash.mp4` (replace it with your
      // own). Served by the Host half at /bili-player/splash and played once per
      // page load (which is once per app launch), then cross-faded into the
      // frame.
      const SPLASH_SRC = '/bili-player/splash'
      const SPLASH_FADE_MS = 420
      const SPLASH_SOUND_KEY = 'biliPlayer.splash.sound'
      // "Cold start" = this window/renderer session. sessionStorage survives a
      // client HMR module reload (so editing the plugin does not replay the
      // animation) but is empty again after the app is restarted.
      const SPLASH_PLAYED_KEY = 'biliPlayer.splash.played'

      function readSessionFlag(key) {
        try {
          return window.sessionStorage.getItem(key) === '1'
        } catch {
          return false
        }
      }

      function writeSessionFlag(key, on) {
        try {
          if (on) window.sessionStorage.setItem(key, '1')
          else window.sessionStorage.removeItem(key)
        } catch {}
      }

      function loadSplashSound() {
        try {
          // Sound ON unless the user explicitly turned it off.
          return window.localStorage.getItem(SPLASH_SOUND_KEY) !== '0'
        } catch {
          return true
        }
      }

      function saveSplashSound(on) {
        try {
          window.localStorage.setItem(SPLASH_SOUND_KEY, on ? '1' : '0')
        } catch {}
      }

      function Splash() {
        const [visible, setVisible] = React.useState(() => !readSessionFlag(SPLASH_PLAYED_KEY))
        const [fading, setFading] = React.useState(false)
        const [run, setRun] = React.useState(0)
        const [sound, setSound] = React.useState(loadSplashSound)
        const videoRef = React.useRef(null)
        const revRef = React.useRef(0)
        const doneRef = React.useRef(false)

        const finish = React.useCallback((reason) => {
          if (doneRef.current) return
          doneRef.current = true
          report({ ev: 'splash-end', reason })
          setFading(true)
          window.setTimeout(() => setVisible(false), SPLASH_FADE_MS)
        }, [])

        React.useEffect(() => {
          if (visible) writeSessionFlag(SPLASH_PLAYED_KEY, true)
        }, [visible])

        // Replay on demand through the Host control channel.
        React.useEffect(() => {
          let stopped = false
          const tick = async () => {
            if (stopped) return
            try {
              const response = await fetch(CONTROL, { cache: 'no-store' })
              if (!response.ok) return
              const data = await response.json()
              const cmd = data && data.cmd
              if (!cmd || !cmd.rev || cmd.rev <= revRef.current) return
              revRef.current = cmd.rev
              if (cmd.action !== 'splash') return
              report({ ev: 'splash-replay', sound: cmd.sound == null ? sound : !!cmd.sound })
              doneRef.current = false
              if (cmd.sound != null) {
                setSound(!!cmd.sound)
                saveSplashSound(!!cmd.sound)
              }
              setFading(false)
              setVisible(true)
              setRun((value) => value + 1)
            } catch {
            }
          }
          const timer = window.setInterval(tick, 1200)
          return () => {
            stopped = true
            window.clearInterval(timer)
          }
        }, [sound])

        React.useEffect(() => {
          if (!visible) return undefined
          const video = videoRef.current
          const root = document.querySelector('[data-splash-root]')
          const rect = root ? root.getBoundingClientRect() : null
          const vrect = video ? video.getBoundingClientRect() : null
          report({
            ev: 'splash-show',
            run,
            viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
            root: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
            video: vrect ? { w: Math.round(vrect.width), h: Math.round(vrect.height) } : null,
          })
          const fallback = window.setTimeout(() => finish('timeout'), 9000)
          const onMeta = () => {
            report({
              ev: 'splash-meta',
              duration: Number(video.duration) || 0,
              width: video.videoWidth || 0,
              height: video.videoHeight || 0,
              muted: !!video.muted,
            })
          }
          const onEnded = () => finish('ended')
          const onError = () => {
            report({ ev: 'splash-error', code: video.error ? video.error.code : null })
            finish('error')
          }
          if (video) {
            video.muted = !sound
            video.addEventListener('loadedmetadata', onMeta)
            video.addEventListener('ended', onEnded)
            video.addEventListener('error', onError)
            const attempt = video.play()
            if (attempt && typeof attempt.catch === 'function') {
              attempt.catch((error) => {
                report({ ev: 'splash-play-blocked', error: String((error && error.message) || error) })
                video.muted = true
                const retry = video.play()
                if (retry && typeof retry.catch === 'function') {
                  retry.catch((inner) => {
                    report({ ev: 'splash-play-failed', error: String((inner && inner.message) || inner) })
                    finish('blocked')
                  })
                }
              })
            }
          }
          const skip = (event) => {
            if (event && event.type === 'keydown') {
              const key = event.key
              if (key !== 'Escape' && key !== ' ' && key !== 'Enter') return
            }
            finish('skip')
          }
          window.addEventListener('keydown', skip)
          return () => {
            window.clearTimeout(fallback)
            window.removeEventListener('keydown', skip)
            if (video) {
              video.removeEventListener('loadedmetadata', onMeta)
              video.removeEventListener('ended', onEnded)
              video.removeEventListener('error', onError)
            }
          }
        }, [visible, run, sound, finish])

        if (!visible) return null

        return h('div', {
          'data-splash-root': '1',
          onClick: () => finish('click'),
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 5000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#ffffff',
            cursor: 'pointer',
            pointerEvents: 'auto',
            opacity: fading ? 0 : 1,
            transition: `opacity ${SPLASH_FADE_MS}ms ease`,
          },
        },
        h('video', {
          key: run,
          ref: videoRef,
          src: SPLASH_SRC,
          muted: sound ? false : true,
          autoPlay: true,
          playsInline: true,
          preload: 'auto',
          style: {
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            background: '#ffffff',
            pointerEvents: 'none',
          },
        }))
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          try {
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
              name: 'shell.overlay',
              id: 'bili-player.frame',
              order: 1000,
            }, Widget))
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
              name: 'shell.overlay',
              id: 'bili-player.splash',
              order: 5000,
            }, Splash))
            report({ ev: 'plugin-apply', clientVersion: 6 })
          } catch (error) {
            report({ ev: 'register-failed', error: String((error && error.message) || error) })
          }
        },
      }
    } catch (error) {
      report({ ev: 'factory-failed', error: String((error && error.message) || error) })
      return { apply() {} }
    }
  },
})
