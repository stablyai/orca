// Measures the infrastructure floor of a phone→relay connect with throwaway credentials:
// director /v1/resolve (DB lookup path) and cell WebSocket open → relay-hello.
// usage: node relay-hop-latency.mjs [relayHostId] [cellOrigin] [runs]
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const relayHostId = process.argv[2] ?? 'AAAAAAAAAAAAAAAA'
const cell = process.argv[3] ?? 'https://relay-c8.onorca.dev'
const runs = Number(process.argv[4] ?? 5)
const director = 'https://relay.onorca.dev'
const bogus = 'A'.repeat(43)

async function timeResolve() {
  const t0 = performance.now()
  const res = await fetch(`${director}/v1/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, relayHostId, resumeToken: bogus })
  })
  const body = await res.text()
  return { ms: Math.round(performance.now() - t0), status: res.status, body: body.slice(0, 80) }
}

function timeCellHello() {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let tOpen = 0
    const ws = new WebSocket(`${cell.replace('https', 'wss')}/v1/connect/${relayHostId}`, {
      perMessageDeflate: false
    })
    const done = (extra) => {
      ws.terminate()
      resolve({
        openMs: Math.round(tOpen - t0),
        totalMs: Math.round(performance.now() - t0),
        ...extra
      })
    }
    ws.on('open', () => {
      tOpen = performance.now()
      ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: bogus }))
    })
    ws.on('message', (m) => done({ hello: m.toString().slice(0, 80) }))
    ws.on('close', (code, reason) => done({ close: code, reason: reason.toString() }))
    ws.on('error', (e) => done({ error: e.message }))
    setTimeout(() => done({ error: 'timeout' }), 15000)
  })
}

for (let i = 0; i < runs; i++) {
  const r = await timeResolve()
  const c = await timeCellHello()
  console.log(JSON.stringify({ run: i, resolve: r, cell: c }))
}
