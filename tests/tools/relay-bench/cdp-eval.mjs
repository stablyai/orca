// usage: node cdp-eval.mjs <port> <js-expression-returning-promise>
import WebSocket from 'ws'
import { requirePort } from './relay-bench-invocation.mjs'

const USAGE = 'node cdp-eval.mjs <port> <js-expression-returning-promise>'
const RENDERER_ORIGIN = 'http://localhost:5173'
const OPEN_TIMEOUT_MS = 5_000

function findRendererPage(list) {
  return list.find((p) => p.type === 'page' && p.url.startsWith(RENDERER_ORIGIN))
}

function describePages(list) {
  return list.length ? list.map((p) => `${p.type} ${p.url}`).join(', ') : 'none'
}
const [rawPort, expr] = process.argv.slice(2)
// Why not interpolate directly: URL parsing reads '80@attacker.example' as userinfo, so the
// fetch would leave the loopback DevTools endpoint for an attacker-named host.
const port = requirePort(rawPort, 'devtools port', USAGE)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = findRendererPage(list)
if (!page) {
  console.error(
    `no renderer page at ${RENDERER_ORIGIN} on devtools port ${port}; pages: ${describePages(list)}`
  )
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
  setTimeout(
    () => reject(new Error(`devtools socket did not open within ${OPEN_TIMEOUT_MS} ms`)),
    OPEN_TIMEOUT_MS
  ).unref()
})
ws.on('error', (err) => {
  console.error(`devtools socket error: ${err.message}`)
  process.exit(1)
})
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
