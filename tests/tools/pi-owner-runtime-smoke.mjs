// Run: node tests/tools/pi-owner-runtime-smoke.mjs /path/to/pi-coding-agent
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const piRoot = resolve(process.argv[2] || '')
assert.ok(process.argv[2], 'Pass an installed pi-coding-agent package directory')
const scratch = await mkdtemp(join(tmpdir(), 'orca-pi-owner-'))
const received = []
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) {
    body += chunk
  }
  received.push(JSON.parse(body))
  response.end('{}')
})
try {
  const bundle = join(scratch, 'orca.cjs')
  await build({
    stdin: {
      contents: [
        "export { getPiAgentStatusExtensionSource } from './src/main/pi/agent-status-extension-source';",
        "export { runProcess } from './src/shared/child-process/run-process';"
      ].join('\n'),
      resolveDir: process.cwd()
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    packages: 'external'
  })
  const { getPiAgentStatusExtensionSource, runProcess } = createRequire(import.meta.url)(bundle)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const dead = await runProcess({
    program: process.execPath,
    args: ['-e', 'console.log(process.pid)']
  })
  assert.equal(dead.code, 0)
  const deadPid = Number(dead.stdout.trim())
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' })
  const worker = join(scratch, 'worker.mjs')
  const moduleUrl = (file) => JSON.stringify(pathToFileURL(join(piRoot, file)).href)
  await writeFile(
    worker,
    `
    import assert from 'node:assert/strict'
    import { loadExtensions } from ${moduleUrl('dist/core/extensions/loader.js')}
    import { ExtensionRunner } from ${moduleUrl('dist/core/extensions/runner.js')}
    import { SessionManager } from ${moduleUrl('dist/core/session-manager.js')}
    const loaded = await loadExtensions([process.argv[2]], process.cwd())
    assert.deepEqual(loaded.errors, [])
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), SessionManager.inMemory(process.cwd()), undefined)
    const errors = []
    runner.onError(error => errors.push(error))
    await runner.emit({ type: 'agent_start' })
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({pid: process.pid, owner: process.env[process.argv[3]], handlers: loaded.extensions[0].handlers.size}))
  `
  )
  const results = []
  for (const kind of ['pi', 'omp', 'prime-agent']) {
    const ownerKey =
      kind === 'prime-agent' ? 'ORCA_PRIME_AGENT_STATUS_OWNED' : 'ORCA_PI_STATUS_OWNED'
    for (const scenario of ['baseline-dead', 'fixed-dead', 'fixed-live']) {
      let source = getPiAgentStatusExtensionSource(kind)
      if (scenario === 'baseline-dead') {
        const guard = 'if (ownerPid && ownerPid !== selfPid && isStatusOwnerAlive(ownerPid)) return'
        assert.ok(
          source.includes(guard),
          'Baseline mutation must replace the actual ownership guard'
        )
        source = source.replace(guard, 'if (ownerPid && ownerPid !== selfPid) return')
      }
      const extension = join(scratch, `${kind}-${scenario}.ts`)
      await writeFile(extension, source)
      const before = received.length
      const owner = scenario === 'fixed-live' ? process.pid : deadPid
      const child = await runProcess({
        program: process.execPath,
        args: [worker, extension, ownerKey],
        cwd: scratch,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_PANE_KEY: 'owner-proof',
          ORCA_AGENT_HOOK_PORT: String(server.address().port),
          ORCA_AGENT_HOOK_TOKEN: 'isolated-proof-token',
          ORCA_AGENT_HOOK_ENV: 'proof',
          ORCA_AGENT_HOOK_ENDPOINT: '',
          ORCA_PI_STATUS_OWNED: '',
          ORCA_PRIME_AGENT_STATUS_OWNED: '',
          PRIME_AGENT_INTERNAL_DAEMON_WORKER: kind === 'prime-agent' ? '1' : '',
          [ownerKey]: String(owner)
        },
        timeoutMs: 15000
      })
      assert.equal(child.code, 0, child.stderr)
      const observation = JSON.parse(child.stdout.trim().split('\n').at(-1))
      const shouldReport = scenario === 'fixed-dead'
      assert.equal(
        received.length - before,
        shouldReport ? 1 : 0,
        `${kind}/${scenario}: HTTP delivery`
      )
      assert.equal(observation.owner, String(shouldReport ? observation.pid : owner))
      assert.equal(observation.handlers > 0, shouldReport)
      if (shouldReport) {
        assert.equal(received.at(-1).payload.hook_event_name, 'agent_start')
      }
      results.push({ kind, scenario, posts: received.length - before, ...observation })
    }
  }
  console.log(JSON.stringify({ platform: process.platform, results }, null, 2))
} finally {
  server.closeAllConnections()
  server.close()
  await rm(scratch, { recursive: true, force: true })
}
