import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.ok(process.argv[2], 'Pass the OMP executable; all test data stays in .tmp')
await mkdir(resolve('.tmp'), { recursive: true })
const root = await mkdtemp(join(resolve('.tmp'), 'omp-model-recovery-'))
const cwd = join(root, 'workspace')
const account = join(root, 'agent')
await mkdir(cwd, { recursive: true })
await mkdir(account, { recursive: true })
await runProcess({ program: 'git', args: ['init', '--quiet'], cwd })
const bundle = join(root, 'recovery.cjs')
await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `export {OmpRpcSessionAdapter} from './src/main/omp/rpc-session-adapter';
      export {piRpcSessionlessEnvironment} from './src/main/pi/rpc-launch';
      export {createDeferredStructuredAgentSessionEventSink} from './src/main/native-chat/agent-session-wire/structured-agent-session-event-sink';
      export {JournalHostDatabase} from './src/main/native-chat/agent-session-journal/journal-host-database';
      export {openAgentSessionJournal} from './src/main/native-chat/agent-session-journal/journal-store-factory';`
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: bundle
})
const {
  OmpRpcSessionAdapter,
  piRpcSessionlessEnvironment,
  createDeferredStructuredAgentSessionEventSink,
  JournalHostDatabase,
  openAgentSessionJournal
} = createRequire(import.meta.url)(bundle)
const id = randomUUID()
const source = join(root, `2026-11-03T00-00-00-000Z_${id}.jsonl`)
const rows = [
  { type: 'session', version: 3, id, timestamp: '2026-11-03T00:00:00.000Z', cwd },
  {
    type: 'model_change',
    id: 'old-model',
    parentId: null,
    timestamp: '2026-11-03T00:00:01.000Z',
    model: 'openai-codex/gpt-6.1-sol'
  },
  {
    type: 'message',
    id: 'saved-user',
    parentId: 'old-model',
    timestamp: '2026-11-03T00:00:02.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Keep this conversation.' }],
      timestamp: 1793664002000
    }
  }
]
const original = `${rows.map(JSON.stringify).join('\n')}\n`
const config = join(root, 'no-continuation.yml')
await writeFile(config, 'goal:\n  continuationModes: []\n')
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  PI_CODING_AGENT_DIR: account,
  APPDATA: join(root, 'appdata'),
  LOCALAPPDATA: join(root, 'localappdata'),
  TEMP: join(root, 'tmp'),
  TMP: join(root, 'tmp'),
  TMPDIR: join(root, 'tmp'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'),
  OMP_PROFILE: '',
  PI_PROFILE: '',
  PI_CONFIG_DIR: '.omp',
  OPENAI_API_KEY: 'isolated-no-network-key'
}
await mkdir(env.TEMP, { recursive: true })
for (const key of Object.keys(env)) {
  if (/CODEX|TOKEN|API_KEY|ANTHROPIC_AUTH/i.test(key) && key !== 'OPENAI_API_KEY') {
    delete env[key]
  }
}
for (const replacement of [false, true]) {
  const deadline = setTimeout(() => {
    throw new Error('Model recovery exceeded 45 seconds')
  }, 45_000)
  await writeFile(source, original)
  const events = createDeferredStructuredAgentSessionEventSink({
    sessionId: 'recovery',
    logger: { warn: () => {}, error: () => {} }
  })
  const controller = new AbortController()
  let startupFailure
  const database = JournalHostDatabase.open(join(root, `journal-${replacement}`))
  const journal = await openAgentSessionJournal({
    database,
    identity: {
      sessionId: 'recovery',
      agent: 'omp',
      hostId: 'local',
      workspaceId: 'folder',
      providerHandle: null
    }
  })
  events.bind({ journal, fence: 1, publish: () => {} })
  const adapter = new OmpRpcSessionAdapter({
    resolveLaunch: async () => ({
      command: resolve(process.argv[2]),
      cwd,
      fullAccess: true,
      ...piRpcSessionlessEnvironment(env),
      sessionFile: source,
      previous: null,
      extraArgs: [
        '--no-extensions',
        '--no-tools',
        '--config',
        config,
        ...(replacement ? ['--provider', 'openai-codex', '--model', 'gpt-6.1-sol'] : [])
      ]
    }),
    onLifecycle: (event) => {
      if (event.type === 'ended') {
        startupFailure = event.failure?.detail?.text
        controller.abort(new Error(startupFailure ?? event.reason))
      }
    },
    onSettled: () => {},
    logger: { warn: () => {}, error: () => {} }
  })
  try {
    const acquired = await adapter.acquire({
      identity: {
        sessionId: 'recovery',
        agent: 'omp',
        hostId: 'local',
        workspaceId: 'folder',
        providerHandle: null
      },
      fence: 1,
      spawnToken: 'recovery',
      events: events.sink,
      ...(replacement ? { options: { model: 'openai/gpt-4o' } } : {})
    })
    const opened = await adapter.open({
      sessionId: 'recovery',
      fence: 1,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: controller.signal
    })
    if (!replacement) {
      console.log(
        JSON.stringify({ selectedReplacement: false, nativeFallback: opened.reportedOptions.model })
      )
      continue
    }
    assert.equal(opened.reportedOptions.model, 'openai/gpt-4o')
    assert.equal(opened.link.handle.nativeId, source)
    assert.ok((await readFile(source, 'utf8')).includes('Keep this conversation.'))
    assert.ok(
      journal
        .snapshot()
        .items.some(
          (row) =>
            row.body.kind === 'message' &&
            row.body.blocks.some(
              (block) => block.type === 'text' && block.text === 'Keep this conversation.'
            )
        )
    )
    console.log(
      JSON.stringify({
        selectedReplacement: true,
        resumed: true,
        model: opened.reportedOptions.model,
        historyPreserved: true
      })
    )
  } catch (error) {
    if (replacement) {
      throw error
    }
    const native = await runProcess(
      {
        program: resolve(process.argv[2]),
        args: [
          '--mode',
          'rpc-ui',
          '--session',
          source,
          '--no-extensions',
          '--no-tools',
          '--config',
          config
        ],
        cwd,
        env
      },
      'tail'
    )
    assert.match(native.stderr, /SessionModelRestoreError/)
    console.log(
      JSON.stringify({
        selectedReplacement: false,
        startupRejected: true,
        reason: 'SessionModelRestoreError'
      })
    )
  } finally {
    await adapter.closeAll()
    events.close()
    await journal.close()
    await database.close()
    clearTimeout(deadline)
  }
}
