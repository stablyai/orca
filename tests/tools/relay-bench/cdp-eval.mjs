// usage: node cdp-eval.mjs <port> <js-expression-returning-promise>
import WebSocket from 'ws'
const [port, expr] = process.argv.slice(2)
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
