/**
 * Ephemeral-port, pid-verifiable inspector session for daemon benchmarks.
 *
 * The target daemon is spawned with `--inspect=0`; `waitForInspectorUrl` reads
 * the advertised ws:// URL from the child's OWN stderr, so the port is never
 * guessed or shared and the target is the spawned process by construction
 * (STA-3515 harness finding #1 — a fixed port can attach to an unrelated
 * process). Callers must still assert `evaluateJson('process.pid')` equals the
 * spawned child's pid before measuring.
 */
import { withTimeout } from './daemon-bench-ndjson-client.mjs'

export const INSPECTOR_TIMEOUT_MS = 10_000

export class InspectorSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.pending = new Map()
    this.messageCounter = 0
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await withTimeout(
      new Promise((resolvePromise, reject) => {
        this.ws.addEventListener('open', () => resolvePromise(), { once: true })
        this.ws.addEventListener('error', () => reject(new Error('inspector websocket error')), {
          once: true
        })
      }),
      INSPECTOR_TIMEOUT_MS,
      'inspector websocket connect'
    )
    this.ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      const pending = message.id !== undefined ? this.pending.get(message.id) : undefined
      if (pending) {
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) {
          pending.reject(new Error(`inspector ${pending.method}: ${message.error.message}`))
        } else {
          pending.resolve(message.result)
        }
      }
    })
    this.ws.addEventListener('close', () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error('inspector websocket closed'))
        this.pending.delete(id)
      }
    })
  }

  send(method, params) {
    return new Promise((resolvePromise, reject) => {
      const id = ++this.messageCounter
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`inspector ${method} timed out after ${INSPECTOR_TIMEOUT_MS}ms`))
      }, INSPECTOR_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolvePromise, reject, timer, method })
      this.ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }))
    })
  }

  async evaluateJson(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `JSON.stringify(${expression})`,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(`inspector evaluate threw: ${result.exceptionDetails.text}`)
    }
    return JSON.parse(result.result.value)
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // already closed
    }
  }
}

export function waitForInspectorUrl(child) {
  return withTimeout(
    new Promise((resolvePromise, reject) => {
      let buffer = ''
      const onData = (chunk) => {
        buffer += chunk.toString('utf8')
        const match = /Debugger listening on (ws:\/\/[^\s]+)/.exec(buffer)
        if (match) {
          child.stderr.off('data', onData)
          resolvePromise(match[1])
        }
      }
      child.stderr.on('data', onData)
      child.once('exit', () => reject(new Error('daemon exited before advertising inspector')))
    }),
    INSPECTOR_TIMEOUT_MS,
    'inspector url discovery'
  )
}
