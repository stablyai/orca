// usage: node cdp-eval.mjs <port> <js-expression-returning-promise>
import WebSocket from 'ws'
import { requirePort } from './relay-bench-invocation.mjs'

const USAGE = 'node cdp-eval.mjs <port> <js-expression-returning-promise>'
// Why any port: `pnpm dev` picks a per-worktree renderer port (see the ORCA_DEV_INSTANCE line).
const RENDERER_ORIGIN = /^http:\/\/localhost:\d+\//
const OPEN_TIMEOUT_MS = 5_000

function findRendererPage(list) {
  return list.find((p) => p.type === 'page' && RENDERER_ORIGIN.test(p.url))
}

function describePages(list) {
  return list.length ? list.map((p) => `${p.type} ${p.url}`).join(', ') : 'none'
}
const [rawPort, expr] = process.argv.slice(2)
// Validate ports: URL parsing treats 80@attacker.example as userinfo and would leave loopback.
const port = requirePort(rawPort, 'devtools port', USAGE)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = findRendererPage(list)
if (!page) {
  console.error(
    `no localhost renderer page on devtools port ${port}; pages: ${describePages(list)}`
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
