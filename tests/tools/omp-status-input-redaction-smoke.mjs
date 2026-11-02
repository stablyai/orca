// Bun; argv[2] is a read-only OMP checkout. Synthetic events, no model calls.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPiAgentStatusExtensionSource } from '../../src/main/pi/agent-status-extension-source.ts'

assert.ok(process.argv[2], 'Pass a read-only OMP checkout path')
const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-input-redaction-'))
process.env.HOME = join(scratch, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.XDG_CONFIG_HOME = join(scratch, 'config')
process.env.XDG_DATA_HOME = join(scratch, 'data')
process.env.XDG_STATE_HOME = join(scratch, 'state')
process.env.XDG_CACHE_HOME = join(scratch, 'cache')
for (const key of [
  'OMP_CODING_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CONFIG_DIR',
  'OMP_PROFILE',
  'PI_PROFILE',
  'PI_CONFIG_FILES',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_PI_STATUS_OWNED'
]) {
  delete process.env[key]
}
await mkdir(process.env.HOME, { recursive: true })
const source = (path) =>
  pathToFileURL(join(resolve(process.argv[2]), 'packages/coding-agent/src', path)).href
const { loadExtensions } = await import(source('extensibility/extensions/loader.ts'))
const { EventBus } = await import(source('utils/event-bus.ts'))
const { SessionManager } = await import(source('session/session-manager.ts'))
const posts = []
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) {
    body += chunk
  }
  posts.push(JSON.parse(body).payload)
  response.writeHead(200).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const manager = SessionManager.inMemory(scratch)
try {
  process.env.ORCA_PANE_KEY = 'redaction-test-pane'
  process.env.ORCA_AGENT_HOOK_PORT = String(server.address().port)
  process.env.ORCA_AGENT_HOOK_TOKEN = 'synthetic-test-token'
  const extensionPath = join(scratch, 'orca-agent-status.ts')
  await writeFile(extensionPath, getPiAgentStatusExtensionSource('omp'))
  const loaded = await loadExtensions([extensionPath], scratch, new EventBus())
  assert.deepEqual(loaded.errors, [])
  const extension = loaded.extensions[0]
  let serializerCalls = 0
  const cases = [
    { input: { command: 'cat ~/.ssh/id_rsa' }, expected: { redacted: true } },
    {
      input: {
        path: '/tmp/safe',
        toJSON() {
          serializerCalls++
          return { path: '~/.ssh/id_rsa' }
        }
      },
      expected: { redacted: true }
    },
    { input: { questions: [{ question: 'Choose', options: ['one', 'two'] }] } }
  ]
  for (const [index, entry] of cases.entries()) {
    for (const handler of extension.handlers.get('tool_call') ?? []) {
      await handler(
        { type: 'tool_call', toolName: 'custom', input: entry.input },
        { sessionManager: manager, hasUI: false }
      )
    }
    const deadline = Date.now() + 2000
    while (posts.length <= index && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(posts.length, index + 1)
    assert.deepEqual(posts[index].tool_input, entry.expected ?? entry.input)
  }
  assert.equal(serializerCalls, 0)
  console.log(
    JSON.stringify({
      actualOmpLoader: true,
      actualHttpPosts: posts.length,
      sensitiveInputsRedacted: 2,
      ordinaryQuestionsPreserved: true,
      serializerCalls,
      modelCalls: 0
    })
  )
} finally {
  await manager.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(scratch, { recursive: true, force: true })
}
