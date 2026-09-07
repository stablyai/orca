// Measures the infrastructure floor of a phone→relay connect with throwaway credentials:
// director /v1/resolve (DB lookup path) and cell WebSocket open → relay-hello. Needs no pairing,
// because a cell answers a bogus credential without ever reaching a desktop.
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import {
  LIVE_ENV_VAR,
  parseArgs,
  requireDirector,
  requireLiveRun,
  requireOrigin
} from './relay-bench-invocation.mjs'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const USAGE = `${LIVE_ENV_VAR}=1 node relay-hop-latency.mjs --cell=<origin> --director=<origin> [--host=<relayHostId>] [--runs=N]`

// A 16-character base64url id that no desktop owns, so the probe stops at the cell.
const UNROUTABLE_HOST_ID = 'AAAAAAAAAAAAAAAA'
const BOGUS_CREDENTIAL = 'A'.repeat(43)
const CELL_TIMEOUT_MS = 15_000

async function timeResolve(director, relayHostId) {
  const started = performance.now()
  const res = await fetch(`${director}/v1/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, relayHostId, resumeToken: BOGUS_CREDENTIAL })
  })
  const body = await res.text()
  return {
    ms: Math.round(performance.now() - started),
    status: res.status,
    body: body.slice(0, 80)
  }
}

function timeCellHello(cell, relayHostId) {
  return new Promise((resolve) => {
    const started = performance.now()
    let openedAt = 0
    const url = new URL(cell)
    url.protocol = 'wss:'
    url.pathname = `/v1/connect/${encodeURIComponent(relayHostId)}`
    const ws = new WebSocket(url.toString(), { perMessageDeflate: false })
    const done = (extra) => {
      ws.terminate()
      resolve({
        openMs: Math.round(openedAt - started),
        totalMs: Math.round(performance.now() - started),
        ...extra
      })
    }
    ws.on('open', () => {
      openedAt = performance.now()
      ws.send(
        JSON.stringify({
          type: 'relay-auth',
          v: 1,
          mode: 'connect',
          credential: BOGUS_CREDENTIAL
        })
      )
    })
    ws.on('message', (message) => done({ hello: message.toString().slice(0, 80) }))
    ws.on('close', (code, reason) => done({ close: code, reason: reason.toString() }))
    ws.on('error', (err) => done({ error: err.message }))
    setTimeout(() => done({ error: 'timeout' }), CELL_TIMEOUT_MS)
  })
}

const { options } = parseArgs(process.argv.slice(2))
requireLiveRun(USAGE)
const director = requireDirector(options, USAGE)
const cell = requireOrigin(options.get('--cell'), 'cell origin (--cell=<origin>)', USAGE)
const relayHostId = options.get('--host') ?? UNROUTABLE_HOST_ID
const runs = Number(options.get('--runs') ?? 5)

for (let run = 0; run < runs; run++) {
  const resolve = await timeResolve(director, relayHostId)
  const cellHello = await timeCellHello(cell, relayHostId)
  console.log(JSON.stringify({ run, resolve, cell: cellHello }))
}
