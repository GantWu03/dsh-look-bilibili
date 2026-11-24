/**
 * Host-side bridge to the persistent Win32 input helper (`pointer.ps1`).
 *
 * The helper is a long-lived PowerShell process: the first call pays the
 * `Add-Type` compile cost (~1-3s), every call after that is a single JSON line
 * in and out (~5-20ms). It is started lazily and restarted if it dies.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export function createPointerBridge(options) {
  const scriptPath = String(options?.scriptPath ?? '')
  const log = typeof options?.log === 'function' ? options.log : () => {}

  let child = null
  let reader = null
  let seq = 0
  let disposed = false
  let spawns = 0
  const waiting = new Map()

  function rejectAll(reason) {
    for (const [, entry] of waiting) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    waiting.clear()
  }

  function start() {
    if (disposed) throw new Error('pointer bridge disposed')
    if (child && child.exitCode === null && !child.killed) return
    spawns += 1
    child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    child.on('error', (error) => {
      log(`pointer helper spawn error: ${String((error && error.message) || error)}`)
      rejectAll('pointer helper spawn error')
      child = null
    })
    child.on('exit', (code, signal) => {
      log(`pointer helper exited (code=${code} signal=${signal} spawns=${spawns})`)
      rejectAll(`pointer helper exited (code=${code})`)
      child = null
      reader = null
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log(`pointer stderr: ${text.slice(0, 500)}`)
    })

    reader = createInterface({ input: child.stdout })
    reader.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let message
      try {
        message = JSON.parse(text)
      } catch {
        log(`pointer non-json: ${text.slice(0, 300)}`)
        return
      }
      const entry = waiting.get(message.id)
      if (!entry) return
      waiting.delete(message.id)
      clearTimeout(entry.timer)
      entry.resolve(message)
    })
  }

  function send(payload, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      try {
        start()
      } catch (error) {
        reject(error)
        return
      }
      const id = ++seq
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`pointer helper timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      waiting.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`)
      } catch (error) {
        clearTimeout(timer)
        waiting.delete(id)
        reject(error)
      }
    })
  }

  // Pay the compile cost once, off the interaction path.
  function warm() {
    return send({ action: 'info' }, 45000).catch((error) => {
      log(`pointer warm failed: ${String((error && error.message) || error)}`)
      return null
    })
  }

  function dispose() {
    disposed = true
    rejectAll('pointer bridge disposed')
    try { child?.stdin?.end() } catch {}
    try { child?.kill() } catch {}
    child = null
    reader = null
  }

  return { send, warm, dispose, get spawns() { return spawns } }
}
