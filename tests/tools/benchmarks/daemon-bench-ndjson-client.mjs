/**
 * Minimal NDJSON client for benchmarks that talk to a self-spawned Orca
 * terminal daemon: control + stream hello handshake, id-matched RPC with
 * per-request timeouts, and close/error handling that rejects every pending
 * request so a daemon crash can never strand an await (STA-3515 harness
 * finding #2).
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'

export const HELLO_TIMEOUT_MS = 10_000
export const RPC_TIMEOUT_MS = 30_000

export function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function connectSocket(path, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`daemon socket connect timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolvePromise(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

export class BenchDaemonClient {
  constructor(socketPath, tokenPath, protocolVersion, onSessionOutputChars) {
    this.socketPath = socketPath
    this.tokenPath = tokenPath
    this.protocolVersion = protocolVersion
    this.onSessionOutputChars = onSessionOutputChars
    this.clientId = randomUUID()
    this.controlSocket = null
    this.streamSocket = null
    this.pending = new Map()
    this.requestCounter = 0
  }

  async connect() {
    this.controlSocket = await connectSocket(this.socketPath, HELLO_TIMEOUT_MS)
    await this.hello(this.controlSocket, 'control')
    this.attachNdjsonReader(this.controlSocket, (message) => this.settleResponse(message))
    // A stream socket mirrors the real client shape: PTY output leaves the
    // daemon instead of accumulating solely because nothing is attached. Its
    // data events also PROVE each cycle's output actually flowed.
    this.streamSocket = await connectSocket(this.socketPath, HELLO_TIMEOUT_MS)
    await this.hello(this.streamSocket, 'stream')
    this.attachNdjsonReader(this.streamSocket, (message) => {
      if (message.type === 'event' && message.event === 'data') {
        this.onSessionOutputChars?.(message.sessionId, message.payload?.data?.length ?? 0)
      }
    })
    const rejectAll = (reason) => () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(reason))
        this.pending.delete(id)
      }
    }
    this.controlSocket.on('close', rejectAll('daemon control socket closed'))
    this.controlSocket.on('error', rejectAll('daemon control socket errored'))
  }

  hello(socket, role) {
    const token = readFileSync(this.tokenPath, 'utf8').trim()
    return withTimeout(
      new Promise((resolvePromise, reject) => {
        let buffer = ''
        const onData = (chunk) => {
          buffer += chunk.toString('utf8')
          const newline = buffer.indexOf('\n')
          if (newline === -1) {
            return
          }
          socket.off('data', onData)
          socket.off('close', onClose)
          try {
            const response = JSON.parse(buffer.slice(0, newline))
            if (response.ok) {
              resolvePromise()
            } else {
              reject(new Error(`hello rejected: ${response.error ?? 'unknown'}`))
            }
          } catch (error) {
            reject(error)
          }
        }
        const onClose = () => reject(new Error('daemon closed socket before hello response'))
        socket.on('data', onData)
        socket.once('close', onClose)
        socket.write(
          `${JSON.stringify({ type: 'hello', version: this.protocolVersion, token, clientId: this.clientId, role })}\n`
        )
      }),
      HELLO_TIMEOUT_MS,
      `daemon ${role} hello`
    )
  }

  attachNdjsonReader(socket, onMessage) {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) {
          continue
        }
        try {
          onMessage(JSON.parse(line))
        } catch {
          // tolerate partial/foreign lines; the daemon owns the framing
        }
      }
    })
  }

  settleResponse(message) {
    const pending = message.id ? this.pending.get(message.id) : undefined
    if (pending) {
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) {
        pending.resolve(message.payload)
      } else {
        pending.reject(new Error(message.error ?? 'daemon request failed'))
      }
    }
  }

  request(type, payload, timeoutMs = RPC_TIMEOUT_MS) {
    return new Promise((resolvePromise, reject) => {
      const id = `bench-${++this.requestCounter}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`daemon request ${type} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      try {
        this.controlSocket.write(
          `${JSON.stringify({ id, type, ...(payload !== undefined ? { payload } : {}) })}\n`
        )
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  destroy() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('client destroyed'))
      this.pending.delete(id)
    }
    this.controlSocket?.destroy()
    this.streamSocket?.destroy()
  }
}
