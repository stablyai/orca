// Measures the infrastructure floor of a phone→relay connect with throwaway credentials:
// director /v1/resolve (DB lookup path) and cell WebSocket open → relay-hello. Needs no pairing,
// because a cell answers a bogus credential without ever reaching a desktop.
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import {
  LIVE_ENV_VAR,
  parseArgs,
  requireBoundedInteger,
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
// Without this a director that accepts the connection and never answers stalls the whole run loop.
const RESOLVE_TIMEOUT_MS = 10_000
const MAX_RUNS = 1000

async function timeResolve(director, relayHostId) {
  const started = performance.now()
  try {
    const res = await fetch(`${director}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId, resumeToken: BOGUS_CREDENTIAL }),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
    })
    const body = await res.text()
    return {
      ms: Math.round(performance.now() - started),
      status: res.status,
      body: body.slice(0, 80)
    }
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError'
    return {
      ms: Math.round(performance.now() - started),
      status: null,
      error: timedOut ? `timeout after ${RESOLVE_TIMEOUT_MS} ms` : err.message
    }
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
    let settled = false
    const done = (extra) => {
      // One-shot: a socket normally emits close after error, and an uncleared timer keeps Node
      // alive for the full CELL_TIMEOUT_MS after the last run.
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      ws.terminate()
      resolve({
        // openedAt stays 0 when error or close beat open; reporting the difference would be a
        // large negative number, not a measurement.
        openMs: openedAt === 0 ? null : Math.round(openedAt - started),
        totalMs: Math.round(performance.now() - started),
        ...extra
      })
    }
    const timer = setTimeout(() => done({ error: 'timeout' }), CELL_TIMEOUT_MS)
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
  })
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2))
  requireLiveRun(USAGE)
  const director = requireDirector(options, USAGE)
  const cell = requireOrigin(options.get('--cell'), 'cell origin (--cell=<origin>)', USAGE)
  const relayHostId = options.get('--host') ?? UNROUTABLE_HOST_ID
  const runs = requireBoundedInteger(options.get('--runs'), '--runs', USAGE, {
    min: 1,
    max: MAX_RUNS,
    fallback: 5
  })

  for (let run = 0; run < runs; run++) {
    const resolve = await timeResolve(director, relayHostId)
    const cellHello = await timeCellHello(cell, relayHostId)
    console.log(JSON.stringify({ run, resolve, cell: cellHello }))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
