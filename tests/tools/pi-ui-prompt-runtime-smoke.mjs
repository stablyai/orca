// Run with: node tests/tools/pi-ui-prompt-runtime-smoke.mjs /path/to/pi-coding-agent
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import ts from 'typescript-api'

const piRoot = process.argv[2]
assert.ok(piRoot, 'Pass the installed pi-coding-agent package directory (Pi >= 0.84.4)')
const cwd = process.cwd()
const require = createRequire(join(cwd, 'package.json'))
const scratch = await mkdtemp(join(tmpdir(), 'orca-pi-ui-prompt-'))

try {
  const bundle = join(scratch, 'orca-status.cjs')
  await build({
    stdin: {
      contents: [
        "export { getPiAgentStatusExtensionSource } from './src/main/pi/agent-status-extension-source';",
        "export { normalizeHookPayload } from './src/shared/agent-hook-listener';",
        "export { createHookListenerState } from './src/shared/agent-hook-listener/listener-state';"
      ].join('\n'),
      resolveDir: cwd
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    packages: 'external'
  })
  const {
    getPiAgentStatusExtensionSource,
    normalizeHookPayload,
    createHookListenerState
  } = require(bundle)
  const { ExtensionRunner } = await import(
    pathToFileURL(resolve(piRoot, 'dist/core/extensions/runner.js')).href
  )
  const handlers = new Map()
  const state = createHookListenerState()
  const snapshots = []
  const errors = []
  const module = { exports: {} }
  const source = ts.transpileModule(getPiAgentStatusExtensionSource('pi'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  runInNewContext(source, {
    module,
    exports: module.exports,
    require,
    process: {
      pid: 4242,
      title: 'pi',
      argv: ['node', 'pi'],
      env: {
        ORCA_PANE_KEY: 'tab-1:11111111-1111-4111-8111-111111111111',
        ORCA_AGENT_HOOK_PORT: '4321',
        ORCA_AGENT_HOOK_TOKEN: 'test',
        ORCA_AGENT_HOOK_ENV: 'production'
      }
    },
    fetch: async (_url, init) => {
      const result = normalizeHookPayload(state, 'pi', JSON.parse(init.body), 'production')
      snapshots.push(result?.payload)
      return { ok: true }
    },
    console,
    Promise,
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout
  })
  module.exports.default({ on: (name, handler) => handlers.set(name, [handler]) })
  const runner = new ExtensionRunner([{ path: 'orca-status', handlers }], {}, cwd, {}, {})
  runner.onError((error) => errors.push(error))
  let idle = false
  runner.isIdleFn = () => idle
  const flush = async () => {
    for (let i = 0; i < 80; i++) {
      await Promise.resolve()
    }
  }
  const last = () => snapshots.at(-1)?.state
  let checks = 0

  // Only UI promises are controlled; the real Pi runner must produce the lifecycle events.
  for (const kind of ['select', 'confirm', 'input', 'editor', 'custom']) {
    for (const ending of ['answer', 'cancel', 'error']) {
      for (const wasIdle of [false, true]) {
        idle = wasIdle
        let finish, fail
        const pending = new Promise((yes, no) => {
          finish = yes
          fail = no
        })
        runner.setUIContext({ [kind]: () => pending }, 'interactive')
        const promise = runner.getUIContext()[kind]('Sensitive title', [], {})
        const observed = promise.catch(() => undefined)
        await flush()
        assert.equal(last(), 'waiting', `${kind}/${ending}/idle=${idle}: start`)
        await runner.emit({ type: 'tool_execution_end', toolName: 'bash' })
        await flush()
        assert.equal(last(), 'waiting', 'Unrelated work must not clear the modal')
        if (ending === 'error') {
          fail(new Error('UI fixture failure'))
        } else {
          finish(ending === 'cancel' ? undefined : 'answer')
        }
        await observed
        await flush()
        assert.equal(last(), idle ? 'done' : 'working', `${kind}/${ending}/idle=${idle}: end`)
        checks++
      }
    }
  }

  let finishA, finishB
  runner.setUIContext(
    {
      custom: () =>
        new Promise((done) => {
          finishA = done
        }),
      input: () =>
        new Promise((done) => {
          finishB = done
        })
    },
    'interactive'
  )
  const a = runner.getUIContext().custom(() => {})
  const b = runner.getUIContext().input('Input')
  await flush()
  assert.equal(last(), 'waiting')
  finishA()
  await a
  await flush()
  assert.equal(last(), 'waiting', 'The remaining prompt still needs input')
  finishB()
  await b
  await flush()
  assert.equal(last(), 'done')
  checks++
  assert.deepEqual(errors, [])
  const { version } = JSON.parse(await readFile(resolve(piRoot, 'package.json'), 'utf8'))
  console.log(`PASS: Pi ${version}, ${checks} scenarios, ${snapshots.length} status snapshots`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
