import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const [binary, directory] = process.argv.slice(2)
const legacyUi = process.argv.includes('--legacy-ui')
assert.ok(binary && directory, 'Pass the OMP executable and an isolated validation directory')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const root = resolve(directory)
assert.ok(
  process.env.PI_CODING_AGENT_DIR?.startsWith(root),
  'Set PI_CODING_AGENT_DIR inside the validation directory'
)
assert.ok(
  process.env.USERPROFILE?.startsWith(root),
  'Set USERPROFILE inside the validation directory'
)
assert.ok(process.env.HOME?.startsWith(root), 'Set HOME inside the validation directory')
await mkdir(root, { recursive: true })
const bundle = join(root, 'omp-rpc-smoke.cjs')
await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `export {OmpRpcSessionAdapter} from './src/main/omp/rpc-session-adapter'; export {ompRpcLaunchPart} from './src/main/omp/rpc-launch'; export {OMP_RPC_AGENT} from './src/main/omp/rpc-agent-definition'; export {composeStructuredLaunch} from './src/main/runtime/structured-agent-launch-composition'; export {foundAgentSessionRecord} from './src/main/runtime/agent-session-record-founding'; export {openProviderTimelineRig, closeProviderTimelineRigs} from './src/main/native-chat/agent-session-timeline/provider-timeline-assembler-test-support';`
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: bundle
})
const {
  OmpRpcSessionAdapter,
  ompRpcLaunchPart,
  OMP_RPC_AGENT,
  composeStructuredLaunch,
  foundAgentSessionRecord,
  openProviderTimelineRig,
  closeProviderTimelineRigs
} = createRequire(import.meta.url)(bundle)
const rig = await openProviderTimelineRig(
  { agent: 'omp', sessionId: 'session-timeline' },
  { agent: 'omp', providerHandle: null }
)
const lifecycle = [],
  diagnostics = [],
  settled = []
let previous = null,
  fence = 1
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined)
)
const adapter = new OmpRpcSessionAdapter({
  resolveLaunch: async (request) => {
    const cwd = join(root, 'workspace')
    const record = foundAgentSessionRecord(
      {
        sessionId: 'session-timeline',
        provider: 'omp',
        accountHome: { variable: 'PI_CODING_AGENT_DIR', path: env.PI_CODING_AGENT_DIR },
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'isolated-folder',
          workspaceKind: 'folder'
        },
        launchArgs: [
          '--provider',
          'tbt-openai',
          '--model',
          'gpt-6.1-sol',
          '-e',
          join(root, 'interaction-extension.mjs')
        ]
      },
      { claimKeyId: 'smoke', now: Date.now() }
    )
    record.providerHandleChain = previous ? [previous] : []
    return composeStructuredLaunch(
      OMP_RPC_AGENT,
      {
        store: {
          selectWritableRecord: () => ({ kind: 'writable', record }),
          requireWritableRecord: () => record,
          pinLaunchDirectory: async () => record
        },
        resolveWorkspacePath: async () => cwd,
        resolveBaseEnvironment: async () => env,
        resolveAgentEnvironment: async () => env,
        resolveCommandSettings: () => ({ agentCmdOverrides: { omp: resolve(binary) } })
      },
      ompRpcLaunchPart(root)
    )(request)
  },
  onLifecycle: (event) => lifecycle.push(event),
  onSettled: (event) => settled.push(event),
  logger: {
    warn: (message, fields) =>
      diagnostics.push({ message, scope: fields.scope, error: fields.error?.message }),
    error: (message, fields) =>
      diagnostics.push({ message, scope: fields.scope, error: fields.error?.message })
  }
})
const wait = async (description, check, ms = 120000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) {
      return
    }
    await delay(25)
  }
  throw new Error(`Timed out: ${description}`)
}
const open = async () => {
  const acquired = await adapter.acquire({
    identity: {
      sessionId: 'session-timeline',
      agent: 'omp',
      providerHandle: previous?.handle ?? null,
      hostId: 'local',
      workspaceId: 'isolated-folder'
    },
    fence,
    spawnToken: 'smoke-spawn',
    events: rig.eventSink
  })
  const result = await adapter.open({
    sessionId: 'session-timeline',
    fence,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  previous = result.link
  assert.equal(previous.handle.agent, 'omp')
  if (previous.handle.transport === 'jsonl-rpc') {
    assert.ok(previous.handle.nativeId.startsWith(root))
  } else {
    assert.equal(previous.handle.transport, 'acp')
  }
}
const send = async (id, text) => {
  const result = await adapter.dispatch({
    sessionId: 'session-timeline',
    fence,
    clientMessageId: id,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  })
  assert.equal(result.state, 'admitted')
}
try {
  await writeFile(
    join(root, 'interaction-extension.mjs'),
    `export default function(pi){
      pi.registerCommand('orca-rpc-check',{description:'Verify standard RPC dialog',handler:async(args,ctx)=>{const answer=await ctx.ui.confirm('OMP RPC confirmation','Verify the Orca approval card');ctx.ui.notify(answer?'OMP RPC approval accepted':'OMP RPC approval refused','info')}});
      pi.registerCommand('orca-rpc-large',{description:'Verify unchunked input',handler:async(args,ctx)=>{ctx.ui.notify('OMP_LARGE_INPUT '+args.length,'info')}});
      pi.registerCommand('orca-rpc-forms',{description:'Verify standard forms',handler:async(args,ctx)=>{
        const selected=await ctx.ui.select('Smoke select',['Alpha','Beta']);
        const input=await ctx.ui.input('Smoke input');
        const editor=await ctx.ui.editor('Smoke editor','prefilled');
        const ask=${legacyUi ? "'legacy-select-editor'" : "await ctx.ui.askDialog([{id:'multi',question:'Smoke multiple',multi:true,options:[{label:'A'},{label:'B'}]},{id:'text',question:'Smoke text',options:[]}])"};
        ctx.ui.notify('OMP_FORMS_RESULT '+JSON.stringify({selected,input,editor,ask}),'info');
      }});
      pi.registerCommand('orca-rpc-timed',{description:'Verify timed Ask refusal',handler:async(args,ctx)=>{
        const answer=await ctx.ui.askDialog([{id:'timed',question:'Timed smoke',options:[{label:'Yes'},{label:'No'}],recommended:0}],{timeout:1000});
        ctx.ui.notify(answer===undefined?'OMP_TIMED_CANCELLED':'OMP_TIMED_AUTOANSWER','info');
      }});
    }`
  )
  await open()
  await wait('dynamic extension command', () =>
    adapter.readCommands('session-timeline')?.some((command) => command.name === 'orca-rpc-check')
  )
  console.log('PASS real RPC startup, session handle, dynamic extension discovery')
  await send('confirm', '/orca-rpc-check')
  let card
  await wait('approval card', async () => {
    card = (await rig.rows()).find((row) => row.body.kind === 'approval')
    return card
  })
  await adapter.answerPrompt({
    sessionId: 'session-timeline',
    fence,
    itemId: card.itemId,
    kind: 'approval',
    response: { kind: 'option', optionId: 'yes' },
    commit: async () => {}
  })
  await wait('approval result', async () =>
    (await rig.rows()).some(
      (row) => row.body.kind === 'status' && row.body.text?.includes('OMP RPC approval accepted')
    )
  )
  console.log('PASS real extension confirmation through Orca approval card')
  await send('forms', '/orca-rpc-forms')
  const answerQuestion = async (title, answers) => {
    let question
    await wait(title, async () => {
      question = (await rig.rows()).find(
        (row) => row.body.kind === 'question' && row.body.question === title
      )
      return question
    })
    await adapter.answerPrompt({
      sessionId: 'session-timeline',
      fence,
      itemId: question.itemId,
      kind: 'question',
      response: { kind: 'answers', answers: answers(question.body) },
      commit: async () => {}
    })
  }
  await answerQuestion('Smoke select', (body) => [
    { questionId: String(body.freeTextQuestionId ?? 'select'), optionIds: ['option-1'] }
  ])
  await answerQuestion('Smoke input', (body) => [
    { questionId: body.freeTextQuestionId, optionIds: [], other: 'ORCA_INPUT_OK' }
  ])
  await answerQuestion('Smoke editor', (body) => [
    { questionId: body.freeTextQuestionId, optionIds: [], other: 'ORCA_EDITOR_OK\nsecond line' }
  ])
  if (!legacyUi) {
    await answerQuestion('Smoke multiple', () => [
      { questionId: 'multi', optionIds: ['option-0', 'option-1'] },
      { questionId: 'text', optionIds: [], other: 'ORCA_ASK_OK' }
    ])
  }
  await wait('real form answers', async () =>
    (await rig.rows()).some(
      (row) =>
        row.body.kind === 'status' &&
        [
          'OMP_FORMS_RESULT',
          'Beta',
          'ORCA_INPUT_OK',
          'ORCA_EDITOR_OK',
          legacyUi ? 'legacy-select-editor' : 'ORCA_ASK_OK'
        ].every((value) => row.body.text?.includes(value))
    )
  )
  console.log(
    legacyUi
      ? 'PASS real legacy Select, Input and multiline Editor'
      : 'PASS real Select, Input, multiline Editor and grouped multi/text Ask'
  )
  if (!legacyUi) {
    await send('timed', '/orca-rpc-timed')
    await wait('real timed Ask cancellation', async () =>
      (await rig.rows()).some(
        (row) => row.body.kind === 'status' && row.body.text === 'OMP_TIMED_CANCELLED'
      )
    )
    assert.ok(
      !(await rig.rows()).some(
        (row) => row.body.kind === 'status' && row.body.text === 'OMP_TIMED_AUTOANSWER'
      )
    )
    console.log('PASS real timed extension Ask explicitly cancelled before upstream deadline')
  }
  await send('large-input', `/orca-rpc-large ${'x'.repeat(1_200_000)}`)
  await wait('large input delivered without unsupported stdin chunks', async () =>
    (await rig.rows()).some(
      (row) => row.body.kind === 'status' && row.body.text === 'OMP_LARGE_INPUT 1200000'
    )
  )
  console.log('PASS real 1.2 MB unchunked input command')
  assert.ok(
    !adapter
      .readCommands('session-timeline')
      .some((command) => ['move', 'wt', 'worktree'].includes(command.name))
  )
  await send('relocation-refused', '/move forbidden-relocation')
  await wait('safe relocation refusal', () =>
    settled.some(
      (event) =>
        event.clientMessageId === 'relocation-refused' && event.outcome.state === 'rejected'
    )
  )
  console.log('PASS builtin relocation commands safely refused')
  await send('model', 'Reply with exactly ORCA_OMP_RPC_OK. Do not use tools.')
  await wait('real model output', async () =>
    (await rig.rows()).some(
      (row) =>
        row.body.kind === 'message' &&
        row.body.role === 'assistant' &&
        row.body.blocks.some(
          (block) => block.type === 'text' && block.text.includes('ORCA_OMP_RPC_OK')
        )
    )
  )
  await wait('real model settlement', async () =>
    (await rig.turns()).some((turn) => turn.state === 'completed')
  )
  console.log('PASS tbt-openai/gpt-6.1-sol streaming and settlement')
  assert.ok(
    !(await rig.rows()).some(
      (row) => row.body.kind === 'status' && row.body.text === 'Goal cleared'
    )
  )
  const fastBefore = await adapter.readOptions({ sessionId: 'session-timeline', fence })
  assert.equal(fastBefore.fastModeSupport?.supported, true)
  try {
    await adapter.setOption({
      sessionId: 'session-timeline',
      fence,
      key: 'fastMode',
      value: String(!fastBefore.current.fastMode)
    })
    const fastAfter = await adapter.readOptions({ sessionId: 'session-timeline', fence })
    assert.equal(fastAfter.current.fastMode, !fastBefore.current.fastMode)
    assert.equal(fastAfter.current.fastModeState, fastBefore.current.fastMode ? 'off' : 'on')
  } finally {
    await adapter.setOption({
      sessionId: 'session-timeline',
      fence,
      key: 'fastMode',
      value: String(fastBefore.current.fastMode)
    })
  }
  console.log('PASS no initial Goal cleared notice and real Fast mode toggle/readback')
  await adapter.setOption({ sessionId: 'session-timeline', fence, key: 'effort', value: 'low' })
  assert.equal(
    (await adapter.readOptions({ sessionId: 'session-timeline', fence })).current.effort,
    'low'
  )
  console.log('PASS real Thinking switch')
  await adapter.closeAll()
  await adapter.drainObservedExits()
  adapter.acknowledgeSessionRelease('session-timeline')
  fence++
  const rpcSessionFile = previous.handle.nativeId
  const header = (await readFile(rpcSessionFile, 'utf8'))
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((entry) => entry?.type === 'session')
  assert.ok(header?.id)
  previous = { ...previous, handle: { agent: 'omp', transport: 'acp', nativeId: header.id } }
  await open()
  assert.equal(previous.handle.transport, 'acp')
  assert.equal(previous.handle.nativeId, header.id)
  await wait(
    'resumed model catalog',
    async () =>
      (await adapter.readOptions({ sessionId: 'session-timeline', fence })).models.length > 1
  )
  const resumedOptions = await adapter.readOptions({ sessionId: 'session-timeline', fence })
  assert.ok(resumedOptions.models.some((model) => model.label !== model.id))
  await send(
    'resume',
    'What exact marker did you return in your last assistant reply? Return only that marker, and use no tools.'
  )
  await wait(
    'resumed model output',
    async () =>
      (await rig.rows()).filter(
        (row) =>
          row.body.kind === 'message' &&
          row.body.role === 'assistant' &&
          row.body.blocks.some(
            (block) => block.type === 'text' && block.text.includes('ORCA_OMP_RPC_OK')
          )
      ).length >= 2
  )
  await writeFile(
    join(root, 'adapter-evidence.json'),
    JSON.stringify(
      {
        model: 'tbt-openai/gpt-6.1-sol',
        session: previous.handle.nativeId,
        lifecycle,
        settled,
        diagnostics,
        rows: await rig.rows()
      },
      null,
      2
    )
  )
  console.log(
    'PASS legacy ACP handle resumes the same session over RPC with retained model context through production admission'
  )
  await adapter.setOption({
    sessionId: 'session-timeline',
    fence,
    key: 'model',
    value: 'tbt-openai/gpt-6.1-sol'
  })
  assert.equal(
    (await adapter.readOptions({ sessionId: 'session-timeline', fence })).current.model,
    'tbt-openai/gpt-6.1-sol'
  )
  console.log('PASS real model selection')
  await wait(
    'resumed turn settlement',
    async () => (await rig.turns()).filter((turn) => turn.state === 'completed').length >= 2
  )
  await writeFile(join(root, 'workspace', 'rpc-read-check.txt'), 'ORCA_OMP_TOOL_OK')
  await send(
    'tool',
    'Use the read tool to read rpc-read-check.txt, then reply with the file contents.'
  )
  await wait('real tool result', async () =>
    (await rig.rows()).some(
      (row) =>
        row.body.kind === 'tool-call' && JSON.stringify(row.body).includes('ORCA_OMP_TOOL_OK')
    )
  )
  await wait(
    'tool turn settlement',
    async () => (await rig.turns()).filter((turn) => turn.state === 'completed').length >= 3
  )
  console.log('PASS real OMP tool execution and result projection')
  await send(
    'native-ask',
    'Use the native ask tool once to ask me to choose Alpha or Beta. Do not guess my answer. After I respond, repeat my chosen answer and stop. Do not use any other tools.'
  )
  let nativeAsk
  await wait('model-issued native Ask', async () => {
    nativeAsk = (await rig.rows()).find(
      (row) => row.body.kind === 'question' && row.body.resolution.state === 'pending'
    )
    return nativeAsk
  })
  const fields = nativeAsk.body.questions ?? [
    { id: nativeAsk.body.freeTextQuestionId, options: nativeAsk.body.options }
  ]
  await adapter.answerPrompt({
    sessionId: 'session-timeline',
    fence,
    itemId: nativeAsk.itemId,
    kind: 'question',
    response: {
      kind: 'answers',
      answers: fields.map((field) => ({ questionId: field.id, optionIds: [field.options[0].id] }))
    },
    commit: async () => {}
  })
  await wait('native Ask tool completion', async () =>
    (await rig.rows()).some(
      (row) =>
        row.body.kind === 'tool-call' && row.body.name === 'ask' && row.body.state === 'completed'
    )
  )
  await wait(
    'native Ask turn settlement',
    async () => (await rig.turns()).filter((turn) => turn.state === 'completed').length >= 4
  )
  console.log('PASS real native Ask tool, answer and turn settlement')
  if (legacyUi) {
    const unavailable = await adapter.changeThreadGoal({
      sessionId: 'session-timeline',
      fence,
      change: { kind: 'set', objective: 'Unsupported Goal must be rejected' }
    })
    assert.equal(unavailable.ok, false)
    assert.match(unavailable.rejected, /does not expose native Goal/)
    console.log('PASS absent native Goal explicitly rejected without affecting chat')
  } else {
    const goal = async (change) => {
      const result = await adapter.changeThreadGoal({
        sessionId: 'session-timeline',
        fence,
        change
      })
      assert.equal(result.ok, true, result.rejected)
    }
    await goal({
      kind: 'set',
      objective:
        'Wait for the user to supply the missing test requirement. Ask for it once and do not invent it.'
    })
    await goal({ kind: 'status', status: 'paused' })
    await adapter.cancelTurn({ sessionId: 'session-timeline', fence })
    await wait('paused native Goal', async () =>
      (await rig.rows()).some(
        (row) => row.body.kind === 'status' && row.body.threadGoal?.goal?.status === 'paused'
      )
    )
    await goal({ kind: 'status', status: 'active' })
    await adapter.cancelTurn({ sessionId: 'session-timeline', fence })
    await goal({ kind: 'clear' })
    await wait('cleared native Goal', async () =>
      (await rig.rows()).some(
        (row) => row.body.kind === 'status' && row.body.threadGoal?.state === 'cleared'
      )
    )
    console.log('PASS real native Goal create, pause, resume, abort and drop')
  }
  await writeFile(
    join(root, 'adapter-evidence.json'),
    JSON.stringify(
      {
        model: 'tbt-openai/gpt-6.1-sol',
        session: previous.handle.nativeId,
        lifecycle,
        settled,
        diagnostics,
        rows: await rig.rows()
      },
      null,
      2
    )
  )
} finally {
  await writeFile(join(root, 'runtime-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
  await adapter.closeAll()
  await adapter.drainObservedExits()
  adapter.acknowledgeSessionRelease('session-timeline')
  await closeProviderTimelineRigs()
}
