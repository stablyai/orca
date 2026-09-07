// usage: node cdp-eval.mjs <port> <js-expression-returning-promise>
import WebSocket from 'ws'
import { requirePort } from './relay-bench-invocation.mjs'

const USAGE = 'node cdp-eval.mjs <port> <js-expression-returning-promise>'
const [rawPort, expr] = process.argv.slice(2)
// Why not interpolate directly: URL parsing reads '80@attacker.example' as userinfo, so the
// fetch would leave the loopback DevTools endpoint for an attacker-named host.
const port = requirePort(rawPort, 'devtools port', USAGE)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((p) => p.type === 'page' && p.url.startsWith('http://localhost:5173'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.once('open', r))
ws.send(
  JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: expr, awaitPromise: true, returnByValue: true }
  })
)
ws.on('message', (m) => {
  const d = JSON.parse(m.toString())
  if (d.id === 1) {
    console.log(JSON.stringify(d.result?.result?.value ?? d.result ?? d.error))
    ws.close()
  }
})
