// Standalone plain-Node client: token plus control/stream hello with one clientId, then create/write on control and read stream data.
// Mirror daemon-server.ts without importing Electron/source.

import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

function encodeNdjson(msg) {
  return `${JSON.stringify(msg)}\n`
}

function makeLineReader(onMessage) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk.toString('utf8')
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.length > 0) {
        onMessage(JSON.parse(line))
      }
      idx = buffer.indexOf('\n')
    }
  }
}

function connectSocket(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`connect timeout after ${timeoutMs}ms: ${socketPath}`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function handshake(socket, hello) {
  return new Promise((resolve, reject) => {
    const read = makeLineReader((msg) => {
      if (msg.type === 'hello') {
        if (msg.ok) {
          resolve(read)
        } else {
          reject(new Error(`hello rejected: ${msg.error}`))
        }
      }
    })
    socket.on('data', read)
    socket.write(encodeNdjson(hello))
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Strip VT escapes interleaved by ConPTY so executed-marker matching sees plain output.
const ANSI_ESCAPE = /\[[0-9;?]*[ -/]*[@-~]|\][^]*?|[@-Z\\-_]/g

function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE, '')
}

// Bound RPC waits so a dead daemon cannot wedge the failure path until CI timeout.
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Connect, create, submit command+CR and await expectRe; always close sockets.
// Return output/diagnostics or attach both to errors, distinguishing no session, silent session and unmatched output.
export async function runPtyEcho(options) {
  const {
    socketPath,
    tokenPath,
    protocolVersion,
    command,
    expectRe,
    shellOverride,
    connectTimeoutMs = 5000,
    ioTimeoutMs = 20000,
    // Allow PowerShell/PSReadLine startup after attach before submitting input.
    writeDelayMs = 400
  } = options

  const token = readFileSync(tokenPath, 'utf8').trim()
  const clientId = randomUUID()
  const sessionId = `spike-${randomUUID()}`

  // Record failure-path evidence so logs identify the broken ConPTY phase.
  const diagnostics = {
    createResponse: null,
    ourDataFrames: 0,
    otherDataFrames: 0,
    exitEvents: [],
    rawSample: '',
    sessionsAtTimeout: null
  }

  const control = await connectSocket(socketPath, connectTimeoutMs)
  const stream = await connectSocket(socketPath, connectTimeoutMs)
  const teardown = () => {
    control.destroy()
    stream.destroy()
  }

  try {
    const controlRead = await handshake(control, {
      type: 'hello',
      version: protocolVersion,
      token,
      clientId,
      role: 'control'
    })
    await handshake(stream, {
      type: 'hello',
      version: protocolVersion,
      token,
      clientId,
      role: 'stream'
    })

    const pending = new Map()
    control.removeAllListeners('data')
    control.on(
      'data',
      makeLineReader((msg) => {
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.ok) {
            resolve(msg.payload)
          } else {
            reject(new Error(msg.error))
          }
        }
      })
    )
    void controlRead

    const rpc = (type, payload) => {
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        control.write(encodeNdjson({ id, type, payload }))
      })
    }

    return await new Promise((resolve, reject) => {
      let output = ''
      let settled = false

      const rejectWith = (err) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        err.diagnostics = diagnostics
        err.output = output
        reject(err)
      }

      const timer = setTimeout(() => {
        // On timeout, query session liveness to distinguish failed create/early exit from a live silent PTY.
        withTimeout(rpc('listSessions'), 2000, 'listSessions')
          .then((payload) => {
            diagnostics.sessionsAtTimeout = payload?.sessions ?? payload
          })
          .catch((err) => {
            diagnostics.sessionsAtTimeout = `listSessions error: ${err.message}`
          })
          .finally(() => {
            rejectWith(new Error(`pty echo timeout after ${ioTimeoutMs}ms`))
          })
      }, ioTimeoutMs)

      stream.removeAllListeners('data')
      stream.on(
        'data',
        makeLineReader((msg) => {
          if (msg.type === 'event' && msg.event === 'data') {
            const data = msg.payload?.data ?? ''
            if (diagnostics.rawSample.length < 500) {
              diagnostics.rawSample = (diagnostics.rawSample + data).slice(0, 500)
            }
            if (msg.sessionId === sessionId) {
              diagnostics.ourDataFrames++
              output += data
              // Match ANSI-stripped output because ConPTY interleaves cursor/SGR codes.
              if (expectRe.test(stripAnsi(output)) && !settled) {
                settled = true
                clearTimeout(timer)
                resolve({ output, diagnostics })
              }
            } else {
              diagnostics.otherDataFrames++
            }
          } else if (msg.type === 'event' && msg.event === 'exit') {
            diagnostics.exitEvents.push({ sessionId: msg.sessionId, code: msg.payload?.code })
          }
        })
      )

      const createPayload = { sessionId, cols: 120, rows: 30 }
      if (shellOverride) {
        createPayload.shellOverride = shellOverride
      }
      rpc('createOrAttach', createPayload)
        .then((payload) => {
          diagnostics.createResponse = payload
          return delay(writeDelayMs)
        })
        // Submit lone CR: PSReadLine treats CRLF as soft newline and leaves the command unexecuted.
        .then(() => rpc('write', { sessionId, data: `${command}\r` }))
        .catch((err) => {
          rejectWith(err instanceof Error ? err : new Error(String(err)))
        })
    })
  } finally {
    teardown()
  }
}
