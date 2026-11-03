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
const root = await mkdtemp(join(resolve('.tmp'), 'omp-cli-copy-'))
const cwd = join(root, 'workspace')
const account = join(root, 'agent')
const sessions = join(account, 'sessions', '-workspace')
await mkdir(cwd, { recursive: true })
await mkdir(sessions, { recursive: true })
await runProcess({ program: 'git', args: ['init', '--quiet'], cwd })
const bundle = join(root, 'copy.cjs')
await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `export {OmpRpcSessionAdapter} from './src/main/omp/rpc-session-adapter';
      export {buildOmpRpcLaunch,resolveOmpRpcResume} from './src/main/omp/rpc-launch';
      export {openOmpRpcConnection} from './src/main/omp/rpc-connection';
      export {piRpcSessionlessEnvironment} from './src/main/pi/rpc-launch';
      export {OMP_RPC_AGENT} from './src/main/omp/rpc-agent-definition';
      export {StructuredAgentRegistry} from './src/main/native-chat/agent-session-wire/structured-agent-registry';
      export {StructuredAgentSessionAdapterRouter} from './src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router';`
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: bundle
})
const {
  OmpRpcSessionAdapter,
  buildOmpRpcLaunch,
  openOmpRpcConnection,
  resolveOmpRpcResume,
  piRpcSessionlessEnvironment,
  OMP_RPC_AGENT,
  StructuredAgentRegistry,
  StructuredAgentSessionAdapterRouter
} = createRequire(import.meta.url)(bundle)
const id = randomUUID()
const source = join(sessions, `2026-11-03T00-00-00-000Z_${id}.jsonl`)
const content = [
  { type: 'session', version: 3, id, timestamp: '2026-11-03T00:00:00.000Z', cwd },
  {
    type: 'message',
    id: 'user-1',
    parentId: null,
    timestamp: '2026-11-03T00:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Saved conversation fixture.' }],
      timestamp: 1793664001000
    }
  }
]
  .map(JSON.stringify)
  .join('\n')
await writeFile(source, `${content}\n`)
const artifacts = source.slice(0, -'.jsonl'.length)
await mkdir(artifacts)
await writeFile(join(artifacts, 'output.txt'), 'Saved tool output')
const config = join(root, 'source.yml')
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
  PI_CONFIG_DIR: '.omp'
}
await mkdir(env.TEMP, { recursive: true })
const launch = {
  command: resolve(process.argv[2]),
  cwd,
  fullAccess: true,
  ...piRpcSessionlessEnvironment(env),
  extraArgs: [
    '--no-extensions',
    '--no-tools',
    '--provider',
    'openai',
    '--model',
    'gpt-4o',
    '--api-key',
    'isolated-no-network-key',
    '--config',
    config
  ]
}
const live = openOmpRpcConnection(buildOmpRpcLaunch({ ...launch, sessionFile: source }), {})
const diagnostics = []
let adapter
try {
  const state = await live.request('get_state')
  assert.equal(state.sessionId, id)
  let goal = false
  try {
    await live.request('goal', {
      op: 'create',
      objective: 'Preserve the native Goal in a copy',
      token_budget: 1000
    })
    goal = true
  } catch (error) {
    assert.equal(error.message, 'Unknown command: goal')
  }
  await live.request('get_state')
  const original = await readFile(source, 'utf8')
  const messages = await live.request('get_messages')
  for (const transport of ['jsonl-rpc', 'acp']) {
    const previous = {
      linkId: 'original',
      origin: 'created',
      mintedAtFence: 1,
      observedAt: 1,
      handle: { agent: 'omp', transport, nativeId: transport === 'acp' ? id : source }
    }
    adapter = new OmpRpcSessionAdapter({
      resolveLaunch: async () => ({
        ...launch,
        previous,
        ...(await resolveOmpRpcResume({ previous, cwd, env }))
      }),
      onLifecycle: () => {},
      onSettled: () => {},
      logger: {
        warn: (message) => diagnostics.push(message),
        error: (message) => diagnostics.push(message)
      }
    })
    const router = new StructuredAgentSessionAdapterRouter(
      new StructuredAgentRegistry([{ definition: OMP_RPC_AGENT, adapter }]),
      () => adapter.closeAll()
    )
    const copy = await router.copyConversation({
      identity: {
        sessionId: 'copy-smoke',
        agent: 'omp',
        hostId: 'local',
        workspaceId: 'folder',
        providerHandle: previous.handle
      },
      providerSessionId: previous.handle.nativeId,
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: account }
    })
    assert.notEqual(copy.sessionId, id)
    assert.notEqual(copy.filePath, source)
    assert.equal(await readFile(source, 'utf8'), original)
    assert.equal(
      await readFile(join(copy.filePath.slice(0, -'.jsonl'.length), 'output.txt'), 'utf8'),
      'Saved tool output'
    )
    assert.equal(live.closed, false)
    const reopened = openOmpRpcConnection(
      buildOmpRpcLaunch({ ...launch, sessionFile: copy.filePath }),
      {}
    )
    try {
      const resumed = await reopened.request('get_state')
      assert.equal(resumed.sessionId, copy.sessionId)
      assert.equal(resumed.isSettled, true)
      assert.deepEqual(await reopened.request('get_messages'), messages)
      if (goal) {
        const copiedGoal = await reopened.request('goal', { op: 'get' })
        assert.equal(copiedGoal.goal.objective, 'Preserve the native Goal in a copy')
        assert.equal(copiedGoal.goal.tokenBudget, 1000)
      }
    } finally {
      assert.equal((await reopened.close()).root, 'exited')
    }
    await adapter.closeAll()
    console.log(
      JSON.stringify({
        transport,
        copied: true,
        resumed: true,
        sourceUnchanged: true,
        artifacts: true,
        goal
      })
    )
  }
  assert.deepEqual(diagnostics, [])
} finally {
  await adapter?.closeAll()
  assert.equal((await live.close()).root, 'exited')
}
