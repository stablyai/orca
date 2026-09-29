// Run with Bun and a read-only OMP checkout path as the first argument.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const reference = process.argv[2]
assert.ok(reference, 'Pass the read-only oh-my-pi source checkout path')
const source = (path) =>
  pathToFileURL(join(resolve(reference), 'packages/coding-agent/src', path)).href
const { loadExtensions } = await import(source('extensibility/extensions/loader.ts'))
const { ExtensionRunner } = await import(source('extensibility/extensions/runner.ts'))
const { EventBus } = await import(source('utils/event-bus.ts'))
const { SessionManager } = await import(source('session/session-manager.ts'))
const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-child-status-'))
const posts = []
const errors = []
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const server = createServer(async (request, response) => {
  try {
    let body = ''
    for await (const chunk of request) {
      body += chunk
    }
    posts.push(JSON.parse(body).payload)
    response.writeHead(200).end()
  } catch (error) {
    errors.push(error)
    response.writeHead(500).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  await build({
    entryPoints: ['src/main/pi/agent-status-extension-source.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(scratch, 'generator.mjs')
  })
  const { getPiAgentStatusExtensionSource } = await import(
    pathToFileURL(join(scratch, 'generator.mjs')).href
  )
  const extensionPath = join(scratch, 'orca-agent-status.ts')
  await writeFile(extensionPath, getPiAgentStatusExtensionSource('omp'))
  process.env.ORCA_PANE_KEY = 'test-parent-pane'
  process.env.ORCA_AGENT_LAUNCH_TOKEN = 'test-parent-launch'
  process.env.ORCA_AGENT_HOOK_PORT = String(server.address().port)
  process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
  delete process.env.ORCA_AGENT_HOOK_ENDPOINT
  delete process.env.ORCA_PI_STATUS_OWNED
  const load = async (manager) => {
    const result = await loadExtensions([extensionPath], scratch, new EventBus())
    assert.deepEqual(result.errors, [])
    assert.equal(result.extensions.length, 1)
    // These lifecycle handlers never query models or invoke agent actions.
    const runner = new ExtensionRunner(result.extensions, result.runtime, scratch, manager, {})
    runner.onError((error) => errors.push(error))
    return runner
  }
  const emit = async (runner, type, expectedCount) => {
    await runner.emit({ type })
    if (expectedCount !== undefined) {
      const deadline = Date.now() + 2000
      while (posts.length < expectedCount && errors.length === 0 && Date.now() < deadline) {
        await delay(10)
      }
      assert.equal(posts.length, expectedCount, `HTTP delivery after ${type}`)
    }
    assert.deepEqual(errors, [])
  }
  const assertQuiet = async (expectedCount) => {
    // Suppressed events have no completion callback; allow local HTTP dispatch to settle.
    await delay(100)
    assert.deepEqual(errors, [])
    assert.equal(posts.length, expectedCount, 'child lifecycle must not post pane status')
  }
  const rootManager = SessionManager.create(scratch, join(scratch, 'sessions'))
  const childManager = SessionManager.inMemory(scratch)
  const root = await load(rootManager)
  await emit(root, 'session_start')
  await emit(root, 'agent_start', 1)
  const child = await load(childManager)
  assert.notEqual(root, child)
  assert.notEqual(rootManager, childManager)
  await emit(child, 'session_start')
  await emit(child, 'agent_start')
  await emit(child, 'agent_end')
  await assertQuiet(1)
  await emit(root, 'agent_end', 2)
  await writeFile(extensionPath, `${getPiAgentStatusExtensionSource('omp')}\n// Reloaded module\n`)
  const reloaded = await load(rootManager)
  await emit(reloaded, 'session_start')
  const previousId = rootManager.getSessionId()
  await rootManager.newSession()
  assert.notEqual(rootManager.getSessionId(), previousId)
  await emit(reloaded, 'agent_start', 3)
  await emit(reloaded, 'agent_end', 4)
  assert.equal(posts.at(-1).session_id, rootManager.getSessionId())

  const resumedPath = join(scratch, 'resume-target.jsonl')
  await writeFile(
    resumedPath,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'runtime-resume-target',
      timestamp: new Date().toISOString(),
      cwd: scratch
    })}\n`
  )
  // Resume/reopen the transcript through the same manager.
  for (const expectedCount of [5, 7]) {
    await rootManager.setSessionFile(resumedPath)
    assert.equal(rootManager.getSessionId(), 'runtime-resume-target')
    await emit(reloaded, 'session_switch')
    await emit(reloaded, 'agent_start', expectedCount)
    await emit(reloaded, 'agent_end', expectedCount + 1)
    assert.equal(posts.at(-1).session_id, 'runtime-resume-target')
  }
  await emit(reloaded, 'session_shutdown')
  await emit(child, 'agent_start')
  await emit(child, 'agent_end')
  await emit(child, 'session_shutdown')
  await assertQuiet(8)
  assert.deepEqual(
    posts.map((post) => post.hook_event_name),
    Array.from({ length: 4 }, () => ['agent_start', 'agent_end']).flat()
  )
  console.log(
    JSON.stringify({
      platform: process.platform,
      posts: posts.map((post) => post.hook_event_name),
      distinctManagers: rootManager !== childManager,
      scope:
        'Actual OMP loader, ExtensionRunner and SessionManager; controlled lifecycle order; real native HTTP'
    })
  )
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(scratch, { recursive: true, force: true })
}
