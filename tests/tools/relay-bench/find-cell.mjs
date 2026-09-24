import { createRequire } from 'node:module'
const WebSocket = createRequire(import.meta.url)('ws')
const hostId = process.argv[2]
const bogus = 'A'.repeat(43)
const probe = (cell) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`wss://${cell}.relay.onorca.dev/v1/connect/${hostId}`, {
      perMessageDeflate: false
    })
    const t0 = performance.now()
    const done = (r) => {
      try {
        ws.terminate()
      } catch {}
      resolve({ cell, ms: Math.round(performance.now() - t0), ...r })
    }
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: bogus }))
    )
    ws.on('message', (m) => done({ hello: JSON.parse(m.toString()).code }))
    ws.on('error', (e) => done({ error: e.code ?? e.message }))
    ws.on('close', (c) => done({ close: c }))
    setTimeout(() => done({ error: 'timeout' }), 8000)
  })
const cells = Array.from({ length: 30 }, (_, i) => `c${i + 1}`)
const results = await Promise.all(cells.map(probe))
for (const r of results) {
  if (r.hello !== 4409 || process.argv[3]) {
    console.log(JSON.stringify(r))
  }
}
console.log('probed', results.length, 'wrong-cell:', results.filter((r) => r.hello === 4409).length)
