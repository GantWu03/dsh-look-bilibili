/**
 * Host half of the swappable Bilibili video background.
 *
 * Routes on the GUI's own origin:
 *
 *  - `/bili-player/report`  append JSONL measurements from the Client half
 *  - `/bili-player/resolve` normalise + pre-check a pasted link / BV number
 *  - `/bili-player/control` a tiny out-of-band command channel, so a script or
 *                           an agent can change the background without clicking
 *  - `/bili-player/splash`  the boot animation video (H.264 MP4, Range-aware)
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe } from './resolve.js'
import { createPointerBridge } from './pointer.js'

export const inject = ['webServer']

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
}

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }

function readBody(req, limit = 65536) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) req.destroy()
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })
}

function json(res, status, payload) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

export function apply(ctx, config) {
  // Diagnostics log. Kept out of the package (and out of the repo) by
  // defaulting to the OS temp dir; override with `config.reportDir`.
  const reportDir = String(config?.reportDir ?? join(tmpdir(), 'dsh-look-bilibili'))
  const reportFile = `${reportDir}/player.jsonl`
  const control = { rev: 0, cmd: null }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bili-player/report',
    handler: (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (req.method === 'GET') {
        readFile(reportFile, 'utf8').then(
          (text) => {
            res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(text)
          },
          () => {
            res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('no reports yet\n')
          },
        )
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, CORS)
        res.end()
        return
      }
      void readBody(req, 262144).then((body) => mkdir(reportDir, { recursive: true })
        .then(() => appendFile(reportFile, `${body.trim()}\n`, 'utf8'))
        .catch(() => {})
        .then(() => {
          res.writeHead(204, CORS)
          res.end()
        }))
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bili-player/resolve',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      let text = ''
      if (req.method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        text = url.searchParams.get('text') ?? ''
      } else if (req.method === 'POST') {
        const body = await readBody(req)
        try {
          const parsed = JSON.parse(body || '{}')
          text = String(parsed.text ?? parsed.input ?? '')
        } catch {
          text = body.trim()
        }
      } else {
        res.writeHead(405, CORS)
        res.end()
        return
      }
      try {
        const result = await describe(text)
        json(res, 200, { ...result, input: text.slice(0, 300) })
      } catch (error) {
        json(res, 200, { ok: false, error: `解析异常：${String((error && error.message) || error)}` })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bili-player/control',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (req.method === 'GET') {
        json(res, 200, { rev: control.rev, cmd: control.cmd })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, CORS)
        res.end()
        return
      }
      const body = await readBody(req)
      let parsed
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        json(res, 400, { ok: false, error: 'body 必须是 JSON' })
        return
      }
      control.rev += 1
      control.cmd = { ...parsed, rev: control.rev }
      json(res, 200, { ok: true, rev: control.rev })
    },
  }))

  // Boot animation: shipped as a file inside this package so the Client half
  // can play it from the GUI origin (same origin = no CORS, no file:// block).
  const splashFile = fileURLToPath(new URL('./assets/splash.mp4', import.meta.url))

  // Win32 input injection into the app window, used to drive the Bilibili embed
  // player (hide its chrome, toggle pause). DSH host plugins run in an
  // ELECTRON_RUN_AS_NODE process, which cannot reach `webContents.sendInputEvent`,
  // so a persistent PowerShell helper posts the messages instead. Posting does
  // not move the real cursor.
  const pointerScript = fileURLToPath(new URL('./pointer.ps1', import.meta.url))
  const pointer = createPointerBridge({
    scriptPath: pointerScript,
    log: (line) => console.log(`[bili-player] ${line}`),
  })
  ctx.effect(() => () => pointer.dispose())
  void pointer.warm()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bili-player/pointer',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (req.method === 'GET') {
        try {
          json(res, 200, await pointer.send({ action: 'info' }))
        } catch (error) {
          json(res, 200, { ok: false, error: String((error && error.message) || error) })
        }
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, CORS)
        res.end()
        return
      }
      const body = await readBody(req)
      let payload
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        json(res, 200, { ok: false, error: 'body 必须是 JSON' })
        return
      }
      const action = String(payload.action || '')
      if (!['info', 'activate', 'move', 'click', 'drag', 'wheel', 'reset'].includes(action)) {
        json(res, 200, { ok: false, error: `不支持的 action：${action}` })
        return
      }
      try {
        const started = Date.now()
        const result = await pointer.send(payload, action === 'info' ? 45000 : 15000)
        json(res, 200, { ...result, ms: Date.now() - started })
      } catch (error) {
        json(res, 200, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bili-player/splash',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, CORS)
        res.end()
        return
      }
      let info
      try {
        info = await stat(splashFile)
      } catch {
        res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('splash.mp4 missing\n')
        return
      }
      const total = info.size
      const headers = {
        ...CORS,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(total),
      }
      const match = String(req.headers.range || '').match(/bytes=(\d*)-(\d*)/)
      if (match) {
        const start = match[1] ? Number(match[1]) : 0
        const end = match[2] ? Number(match[2]) : total - 1
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
          res.writeHead(416, { ...CORS, 'Content-Range': `bytes */${total}` })
          res.end()
          return
        }
        res.writeHead(206, {
          ...headers,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        createReadStream(splashFile, { start, end }).on('error', () => res.destroy()).pipe(res)
        return
      }
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(splashFile).on('error', () => res.destroy()).pipe(res)
    },
  }))
}
