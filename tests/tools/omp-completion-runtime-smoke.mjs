import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build, transform } from 'esbuild'

const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-completion-'))
const received = []
let rejectCompletion = true
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) {
    body += chunk
  }
  const payload = JSON.parse(body).payload
  const event = payload.hook_event_name
  received.push(payload)
  const reject = event === 'agent_end' && rejectCompletion
  if (reject) {
    rejectCompletion = false
  }
  response.writeHead(reject ? 503 : 204)
  response.end()
})

async function waitForRequests(count) {
  const deadline = Date.now() + 5000
  while (received.length < count && Date.now() < deadline) {
    await delay(10)
  }
  assert.equal(received.length, count, 'Hook requests did not arrive before the deadline')
}

try {
  const bundle = join(scratch, 'source.cjs')
  await build({
    entryPoints: ['src/main/pi/agent-status-extension-source.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const require = createRequire(import.meta.url)
  const { getPiAgentStatusExtensionSource } = require(bundle)
  const generated = await transform(getPiAgentStatusExtensionSource('omp'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node24'
  })
  const extension = join(scratch, 'extension.cjs')
  await writeFile(extension, generated.code)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  Object.assign(process.env, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_PANE_KEY: 'completion-proof',
    ORCA_TAB_ID: 'proof-tab',
    ORCA_AGENT_HOOK_PORT: String(server.address().port),
    ORCA_AGENT_HOOK_TOKEN: 'isolated-proof-token',
    ORCA_AGENT_HOOK_ENDPOINT: '',
    ORCA_PI_STATUS_OWNED: '',
    WSL_DISTRO_NAME: ''
  })
  const handlers = new Map()
  require(extension).default({ on: (event, handler) => handlers.set(event, handler) })
  let sessionId = 'A'
  const context = {
    isIdle: () => false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(scratch, `${sessionId}.jsonl`)
    }
  }
  const emit = async (event, payload = {}) => {
    assert.ok(handlers.has(event), `Missing lifecycle handler: ${event}`)
    await handlers.get(event)(payload, context)
  }
  await emit('agent_start')
  await waitForRequests(1)
  await emit('agent_end')
  await waitForRequests(3)
  assert.deepEqual(
    received.map((event) => event.hook_event_name),
    ['agent_start', 'agent_end', 'agent_end']
  )
  const recovered = [...received]

  received.length = 0
  rejectCompletion = true
  await emit('agent_start')
  await waitForRequests(1)
  await emit('agent_end')
  await waitForRequests(2)
  await emit('agent_start')
  await delay(600)
  assert.equal(
    received.filter((event) => event.hook_event_name === 'agent_end').length,
    1,
    'An obsolete completion retried after the next turn started'
  )

  for (const boundary of ['session_switch', 'session_shutdown']) {
    received.length = 0
    rejectCompletion = true
    sessionId = 'A'
    await emit('agent_start')
    await waitForRequests(1)
    await emit('agent_end')
    await waitForRequests(2)
    sessionId = 'B'
    await emit(boundary, { reason: 'new' })
    await emit('agent_start')
    await waitForRequests(4)
    await delay(600)
    const completions = received.filter((event) => event.hook_event_name === 'agent_end')
    assert.equal(completions.length, 2, `Unsent completion was lost at ${boundary}`)
    assert.ok(completions.every((event) => event.session_id === 'A'))
    assert.equal(received.at(-1).hook_event_name, 'agent_start')
    assert.equal(received.at(-1).session_id, 'B', 'Old completion overwrote the new session')
  }
  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      recovered,
      cancelledAt: ['agent_start'],
      preservedAt: ['session_switch', 'session_shutdown'],
      scope: 'Generated OMP extension, real native HTTP 503, synthetic lifecycle callbacks'
    })
  )
} finally {
  server.closeAllConnections()
  server.close()
  await rm(scratch, { recursive: true, force: true })
}
