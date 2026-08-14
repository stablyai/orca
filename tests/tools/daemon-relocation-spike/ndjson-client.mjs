// Minimal purpose-built NDJSON client for the daemon wire protocol.
//
// Deliberately standalone (no electron / src imports) so the spike runs under
// plain node. Mirrors the handshake in src/main/daemon/daemon-server.ts:
//   1. read the token the server wrote to <tokenPath> after it began listening
//   2. control socket: send hello {role:'control'}, await {type:'hello',ok:true}
//   3. stream socket:  send hello {role:'stream'} with the SAME clientId
//   4. createOrAttach on control, then write() input, read 'data' events on stream

import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

function encodeNdjson(msg) {
  return `${JSON.stringify(msg)}\n`
}

// Split incoming bytes on newlines and dispatch each complete JSON line.
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

// Send a hello and resolve once the server accepts (or reject on rejection).
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

// Strip CSI / OSC / two-char VT escapes so the marker regex can match executed
// PTY output that ConPTY interleaves with cursor-move and SGR color codes.
// eslint-disable-next-line no-control-regex -- ANSI escapes are control chars by definition
const ANSI_ESCAPE = /\[[0-9;?]*[ -/]*[@-~]|\][^]*?|[@-Z\\-_]/g

function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE, '')
}

// Race a promise against a timeout so a dead daemon can't wedge the failure
// path (an unanswered RPC would otherwise hang until the CI job limit).
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Connect a control+stream client, create a session, submit `command` + CR, and
 * resolve once `expectRe` matches the accumulated PTY output (or reject on
 * timeout). Returns { output, diagnostics } on success. On timeout/error the
 * rejected Error carries `.diagnostics` and `.output` so the caller can tell
 * "no session created" vs "session created but no output" vs "output arrived
 * but the regex did not match". Always tears down its sockets.
 */
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
    // Why: PowerShell/PSReadLine needs a beat to initialize before it echoes
    // typed input; writing the command the instant createOrAttach returns can
    // race the shell's own startup so the keystrokes land before the prompt.
    writeDelayMs = 400
  } = options

  const token = readFileSync(tokenPath, 'utf8').trim()
  const clientId = randomUUID()
  const sessionId = `spike-${randomUUID()}`

  // Everything we learn on the failure path, so the CI log can pinpoint where
  // the ConPTY round-trip broke.
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

    // Route control RPC responses by id.
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
    // The initial controlRead consumed only the hello; discard it now.
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
        // On timeout, ask the daemon what sessions it thinks exist — this
        // distinguishes "session never created / already exited" from "session
        // alive but silent".
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
              // Test against the ANSI-stripped stream: ConPTY interleaves the
              // executed marker with cursor-move / SGR codes.
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
        // Submit with a lone CR: PSReadLine treats CRLF as a soft newline
        // (multiline continuation) and leaves the command typed but unexecuted;
        // a bare CR is Enter.
        .then(() => rpc('write', { sessionId, data: `${command}\r` }))
        .catch((err) => {
          rejectWith(err instanceof Error ? err : new Error(String(err)))
        })
    })
  } finally {
    teardown()
  }
}
