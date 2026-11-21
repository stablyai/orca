import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import {
  pollAntigravityTranscriptStatus,
  readAntigravityTranscriptPoll
} from './antigravity-transcript-poll'
import { ANTIGRAVITY_PARENT_WAKE_GRACE_MS } from './antigravity-event-rules'
import type { AgentHookEventPayload } from '../../listener-event'

let dir: string
let state: ReturnType<typeof createHookListenerState>
let row: AgentHookEventPayload
const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

function transcript(id: string, root = false): string {
  const logs = join(dir, id, '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  const path = join(logs, 'transcript.jsonl')
  writeFileSync(
    path,
    `${JSON.stringify({
      source: root ? 'USER_EXPLICIT' : 'SYSTEM',
      type: root ? 'USER_INPUT' : 'SYSTEM_MESSAGE',
      content: root ? 'Task' : 'sender=root'
    })}\n`
  )
  return path
}
function descriptor(id: string, killed = false): void {
  const descriptors = join(dir, 'root', '.system_generated', 'subagents')
  mkdirSync(descriptors, { recursive: true })
  writeFileSync(
    join(descriptors, `${id}.json`),
    JSON.stringify({
      conversationId: id,
      state: killed ? 'SUBAGENT_STATE_KILLED' : 'SUBAGENT_STATE_ALIVE',
      subagentDescriptor: { role: 'Research' }
    })
  )
}
function hook(
  id: string,
  name: string,
  extra: Record<string, unknown> = {}
): AgentHookEventPayload | null {
  const event = normalizeHookPayload(
    state,
    'antigravity',
    {
      paneKey,
      payload: {
        hook_event_name: name,
        conversationId: id,
        transcriptPath: join(dir, id, '.system_generated', 'logs', 'transcript.jsonl'),
        ...extra
      }
    },
    'production'
  )
  if (event) {
    row = event
  }
  return event
}
async function poll(): Promise<AgentHookEventPayload | undefined> {
  const event = pollAntigravityTranscriptStatus(
    state,
    row,
    await readAntigravityTranscriptPoll(state, paneKey)
  )
  if (event) {
    row = event
  }
  return event
}
function launch(stepIdx = 5): Record<string, unknown> {
  return { stepIdx, toolCall: { id: `invoke-${stepIdx}`, name: 'invoke_subagent', args: {} } }
}
function launchResult(step: number, content: string, status = 'DONE', conversation = 'root'): void {
  appendFileSync(
    join(dir, conversation, '.system_generated', 'logs', 'transcript.jsonl'),
    `${JSON.stringify({ step_index: step, type: 'GENERIC', source: 'MODEL', status, content })}\n`
  )
}
function invokeResult(id: string, step = 5): void {
  launchResult(
    step,
    `Created At: 2026-11-20T03:06:21-08:00\nCompleted At: 2026-11-20T03:06:23-08:00\nCreated the following subagent:\n${JSON.stringify({ conversationId: id })}\nThe subagent will send you a message when it has completed its task or requires guidance. There is no need to poll for its response.`
  )
}
function spawn(id?: string, step = 5): void {
  hook('root', 'PreToolUse', launch(step))
  if (id) {
    invokeResult(id, step)
  }
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-child-lifecycle-'))
  state = createHookListenerState()
  transcript('root', true)
  hook('root', 'PreInvocation', { lastUserInput: 'Task', modelName: 'model-a' })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('keeps the owned sibling listed when one of two subagents stops with an unreadable root transcript', async () => {
  state = createHookListenerState()
  rmSync(join(dir, 'root', '.system_generated', 'logs', 'transcript.jsonl'))
  hook('root', 'PreInvocation', { lastUserInput: 'Task', modelName: 'model-a' })
  for (const id of ['first', 'second']) {
    transcript(id)
    descriptor(id)
    hook(id, 'PreInvocation')
  }
  await poll()
  expect(row.payload.subagents).toHaveLength(2)
  expect(hook('first', 'Stop', { fullyIdle: true })).toBeNull()
  await poll()
  expect(row.payload.subagents?.map((child) => child.id)).toEqual(['second'])
  expect(row.payload.state).toBe('working')
})

it('wakes a retired child again and releases its command hold when disk reports it killed', async () => {
  transcript('child')
  descriptor('child')
  spawn('child')
  hook('child', 'PreInvocation')
  expect((await poll())?.payload.subagents?.[0]?.id).toBe('child')
  hook('child', 'Stop', { fullyIdle: true })
  expect((await poll())?.payload).toMatchObject({ state: 'working', subagents: undefined })
  expect(hook('root', 'Stop', { fullyIdle: false })?.payload.state).toBe('working')
  await poll()
  hook('child', 'PreInvocation')
  expect((await poll())?.payload.subagents?.[0]?.id).toBe('child')
  hook('child', 'PreToolUse', {
    stepIdx: 7,
    toolCall: { name: 'run_command', args: { CommandLine: 'long-task' } }
  })
  descriptor('child', true)
  const killed = await poll()
  expect(killed?.payload.subagents).toBeUndefined()
  expect(killed?.payload.workingMode).not.toBe('monitoring')
  expect(hook('root', 'Stop', { fullyIdle: true })?.payload.state).toBe('done')
  expect(hook('child', 'PostToolUse', { stepIdx: 7, toolCall: { name: 'run_command' } })).toBeNull()
})

it('uses fresh worker hooks ahead of cached wake modes and keeps stopped workers retired', async () => {
  transcript('worker')
  const swarm = join(dir, 'root', '.system_generated', 'swarm')
  mkdirSync(swarm, { recursive: true })
  const members = join(swarm, 'members.json')
  const writeMember = (wake: string): void =>
    writeFileSync(
      members,
      JSON.stringify({
        members: { worker: { conversation_id: 'worker', phase: 'RUNNING', wake_mode: wake } }
      })
    )
  writeMember('working')
  hook('root', 'PreToolUse', { toolCall: { name: 'swarm_wait' } })
  hook('worker', 'PreInvocation')
  expect((await poll())?.payload.subagents?.[0]?.id).toBe('worker')
  hook('worker', 'Stop', { fullyIdle: true })
  await poll()
  expect(row.payload.subagents).toBeUndefined()
  writeMember('mentions')
  await poll()
  hook('worker', 'PreInvocation')
  expect((await poll())?.payload.subagents?.[0]?.id).toBe('worker')
  hook('worker', 'Stop', { fullyIdle: true })
  hook('root', 'Stop', { fullyIdle: true })
  hook('root', 'PreInvocation', { lastUserInput: 'Next task' })
  hook('root', 'PreToolUse', { toolCall: { name: 'swarm_wait' } })
  await poll()
  expect(row.payload.subagents).toBeUndefined()
})

it('keeps waiting for a new child when a prior child descriptor remains on disk', async () => {
  transcript('old')
  descriptor('old')
  spawn('old')
  hook('old', 'PreInvocation')
  await poll()
  hook('old', 'Stop', { fullyIdle: true })
  spawn(undefined, 6)
  hook('root', 'Stop', { fullyIdle: false })
  expect((await poll())?.payload.state).toBe('working')
  transcript('new')
  descriptor('new')
  hook('new', 'PreInvocation')
  expect((await poll())?.payload.subagents?.map((child) => child.id)).toEqual(['new'])
})

it('refuses another root child and fences a delayed kill read against a fresh invocation', async () => {
  transcript('child')
  descriptor('child')
  spawn('child')
  hook('child', 'PreInvocation')
  await poll()
  descriptor('child', true)
  const reads = await readAntigravityTranscriptPoll(state, paneKey)
  hook('child', 'PreToolUse', { toolCall: { name: 'read_file', args: { path: 'src/current.ts' } } })
  const stale = pollAntigravityTranscriptStatus(state, row, reads)
  expect(stale?.payload.subagents?.[0]).toMatchObject({ id: 'child', toolInput: 'src/current.ts' })
  transcript('unrelated')
  hook('unrelated', 'PreInvocation')
  expect(
    (await poll())?.payload.subagents?.some((child) => child.id === 'unrelated') ?? false
  ).toBe(false)
})

it('keeps unverified child commands and Stops from reopening a finished root', async () => {
  transcript('unrelated')
  hook('root', 'Stop', { fullyIdle: true })
  hook('unrelated', 'PreToolUse', {
    stepIdx: 7,
    toolCall: { name: 'run_command', args: { CommandLine: 'long-task' } }
  })
  expect((await poll())?.payload.state).toBe('done')
  hook('unrelated', 'Stop', { fullyIdle: true })
  expect((await poll())?.payload.state).toBe('done')
})

it('resolves automatic models from transcripts and preserves them across automatic hooks', async () => {
  transcript('child')
  descriptor('child')
  spawn('child')
  hook('child', 'PreInvocation', { modelName: 'auto' })
  appendFileSync(
    join(dir, 'child', '.system_generated', 'logs', 'transcript.jsonl'),
    '{"type":"PLANNER_RESPONSE","model":"model-b"}\n'
  )
  expect((await poll())?.payload.subagents?.[0]?.model).toBe('model-b')
  hook('child', 'PreToolUse', {
    modelName: 'auto',
    toolCall: { name: 'read_file', args: { path: 'src/current.ts' } }
  })
  const next = await poll()
  expect(next?.payload.subagents?.[0]).toMatchObject({
    model: 'model-b',
    toolInput: 'src/current.ts'
  })
  expect(
    hook('root', 'PreToolUse', { modelName: 'auto', toolCall: { name: 'read_file' } })?.payload
      .model
  ).toBe('model-a')
  appendFileSync(
    join(dir, 'child', '.system_generated', 'logs', 'transcript.jsonl'),
    '{"type":"PLANNER_RESPONSE","model":"model-c"}\n'
  )
  expect((await poll())?.payload.subagents?.[0]?.model).toBe('model-c')
})

it('follows the automatic model a later turn resolves', async () => {
  hook('root', 'Stop', { fullyIdle: true })
  hook('root', 'PreInvocation', { lastUserInput: 'Next', modelName: 'auto' })
  const rootTranscript = join(dir, 'root', '.system_generated', 'logs', 'transcript.jsonl')
  appendFileSync(rootTranscript, '{"type":"PLANNER_RESPONSE","model":"model-b"}\n')
  expect((await poll())?.payload.model ?? row.payload.model).toBe('model-a')
  appendFileSync(
    rootTranscript,
    `${JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'model-c', created_at: '2999-01-01T00:00:00Z' })}\n`
  )
  expect((await poll())?.payload.model).toBe('model-c')
})

it('takes an automatic model only from its own turn when agy stamps whole seconds', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const rootTranscript = join(dir, 'root', '.system_generated', 'logs', 'transcript.jsonl')
  const response = (model: string, step: number) =>
    appendFileSync(
      rootTranscript,
      `${JSON.stringify({ step_index: step, type: 'PLANNER_RESPONSE', model, created_at: '2030-01-01T12:00:00Z' })}\n`
    )
  try {
    vi.setSystemTime(Date.parse('2030-01-01T12:00:00.600Z'))
    hook('root', 'Stop', { fullyIdle: true })
    response('model-z', 5)
    hook('root', 'PreInvocation', { lastUserInput: 'Next', modelName: 'auto', initialNumSteps: 6 })
    expect((await poll())?.payload.model ?? row.payload.model).toBe('model-a')
    response('model-c', 7)
    expect((await poll())?.payload.model).toBe('model-c')
  } finally {
    vi.useRealTimers()
  }
})

it.each([false, true])(
  'keeps observing an automatic turn without step indices (cold=%s)',
  async (cold) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.parse('2030-01-01T12:00:00.600Z'))
      if (cold) {
        state = createHookListenerState()
      }
      const path = join(dir, 'root', '.system_generated', 'logs', 'transcript.jsonl')
      appendFileSync(path, '{"model":"old-model","created_at":"2030-01-01T12:00:00Z"}\n')
      hook('root', 'PreInvocation', { lastUserInput: 'Next', modelName: 'auto' })
      await poll()
      expect(row.payload.model).toBe(cold ? undefined : 'model-a')
      appendFileSync(path, '{"model":"new-model","created_at":"2030-01-01T12:00:01Z"}\n')
      await poll()
      expect(row.payload.model).toBe('new-model')
    } finally {
      vi.useRealTimers()
    }
  }
)

it('keeps a root command monitoring after its child finishes', async () => {
  transcript('child')
  descriptor('child')
  hook('root', 'PreToolUse', {
    stepIdx: 4,
    toolCall: { name: 'run_command', args: { CommandLine: 'long-task' } }
  })
  spawn('child')
  hook('child', 'PreInvocation')
  await poll()
  hook('root', 'Stop', { fullyIdle: false })
  hook('child', 'Stop', { fullyIdle: true })
  expect((await poll())?.payload).toMatchObject({
    state: 'working',
    workingMode: 'monitoring',
    subagents: undefined
  })
  expect(hook('root', 'Stop', { fullyIdle: false })?.payload.workingMode).toBe('monitoring')
  expect(
    hook('root', 'PostToolUse', { stepIdx: 4, toolCall: { name: 'run_command' } })?.payload.state
  ).toBe('done')
})

it('keeps a Swarm worker without a RUNNING phase listed', async () => {
  transcript('worker')
  const swarm = join(dir, 'root', '.system_generated', 'swarm')
  mkdirSync(swarm, { recursive: true })
  writeFileSync(
    join(swarm, 'members.json'),
    JSON.stringify({ members: { worker: { conversation_id: 'worker', phase: 'STARTING' } } })
  )
  hook('root', 'PreToolUse', { toolCall: { name: 'swarm' } })
  hook('worker', 'PreInvocation')
  expect((await poll())?.payload.subagents?.map((child) => child.id)).toEqual(['worker'])
})

it('shows a waiting child only once the root is proven its parent', async () => {
  state = createHookListenerState()
  hook('root', 'PreInvocation', { transcriptPath: undefined, lastUserInput: 'Task' })
  transcript('helper')
  hook('root', 'PreToolUse', { ...launch(), transcriptPath: undefined })
  hook('helper', 'PreInvocation')
  hook('helper', 'PreToolUse', { toolCall: { name: 'ask_question', args: {} } })
  expect((await poll())?.payload).toMatchObject({ state: 'working', subagents: undefined })
  descriptor('helper')
  hook('root', 'PostInvocation')
  expect((await poll())?.payload).toMatchObject({
    state: 'waiting',
    subagents: [{ id: 'helper', state: 'waiting' }]
  })
})

it('tracks a child that first reports after a background command finished the root', async () => {
  transcript('first')
  transcript('second')
  descriptor('first')
  hook('root', 'PreToolUse', {
    stepIdx: 5,
    toolCall: { name: 'run_command', args: { CommandLine: 'long-task' } }
  })
  spawn('first', 6)
  spawn('second', 7)
  hook('first', 'PreInvocation')
  await poll()
  hook('root', 'Stop', { fullyIdle: false })
  hook('first', 'Stop', { fullyIdle: true })
  expect(
    hook('root', 'PostToolUse', { stepIdx: 5, toolCall: { name: 'run_command' } })?.payload
  ).toMatchObject({ state: 'working', antigravitySpawnPending: true })
  descriptor('second')
  hook('second', 'PreInvocation')
  hook('second', 'PreToolUse', { toolCall: { name: 'ask_question', args: {} } })
  expect((await poll())?.payload).toMatchObject({
    state: 'waiting',
    subagents: [{ id: 'second', state: 'waiting' }]
  })
  hook('second', 'Stop', { fullyIdle: true })
  await poll()
  expect(row.payload.subagents).toBeUndefined()
})

it('finishes the run when the only hook received from a subagent is its final Stop', async () => {
  transcript('child')
  spawn('child')
  expect(hook('root', 'Stop', { fullyIdle: false })?.payload.antigravitySpawnPending).toBe(true)
  hook('child', 'Stop', { fullyIdle: true })
  const polled = await poll()
  expect(polled?.payload.antigravitySpawnPending).toBeUndefined()
  expect(polled?.payload.mainAgent?.state).toBe('done')
})

it('keeps parallel launches and their live siblings across a root wake and an idle Stop', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    spawn(undefined, 5)
    spawn(undefined, 6)
    // The first result wakes the root with the original input and invocation number.
    hook('root', 'PreInvocation', { lastUserInput: 'Task', invocationNum: 0 })
    for (const id of ['short', 'long']) {
      transcript(id)
      descriptor(id)
      hook(id, 'PreInvocation')
    }
    invokeResult('short', 5)
    await poll()
    expect(row.payload.antigravitySpawnPending).toBe(true)
    expect(row.payload.subagents).toHaveLength(2)
    invokeResult('long', 6)
    await poll()
    expect(row.payload.antigravitySpawnPending).toBeUndefined()
    hook('root', 'Stop', { fullyIdle: true, terminationReason: 'TERMINAL_CUSTOM_HOOK' })
    hook('short', 'Stop', { fullyIdle: true })
    hook('long', 'PreToolUse', { toolCall: { name: 'ask_question', args: {} } })
    expect((await poll())?.payload).toMatchObject({
      state: 'waiting',
      subagents: [{ id: 'long', state: 'waiting' }]
    })
    hook('long', 'Stop', { fullyIdle: true })
    expect((await poll())?.payload).toMatchObject({ state: 'working', subagents: undefined })
    vi.advanceTimersByTime(2001)
    expect((await poll())?.payload.state).toBe('done')
    hook('long', 'PreInvocation')
    expect((await poll())?.payload.state).toBe('done')
  } finally {
    vi.useRealTimers()
  }
})

it('lists a subagent killed before its first poll once, then clears it', async () => {
  transcript('child')
  descriptor('child', true)
  spawn('child')
  hook('child', 'PreInvocation')
  hook('root', 'Stop', { fullyIdle: false })
  expect((await poll())?.payload.subagents?.map((child) => child.id)).toEqual(['child'])
  await poll()
  expect(row.payload.subagents).toBeUndefined()
})

it('retires a quiet Swarm member when its previously missing descriptor reports a kill', async () => {
  const swarm = join(dir, 'root', '.system_generated', 'swarm')
  mkdirSync(swarm, { recursive: true })
  writeFileSync(
    join(swarm, 'members.json'),
    JSON.stringify({ members: { worker: { conversation_id: 'child', model: 'model-c' } } })
  )
  transcript('child')
  hook('child', 'PreInvocation', { modelName: 'model-c' })
  expect((await poll())?.payload.subagents?.map(({ id }) => id)).toEqual(['child'])
  await poll()
  descriptor('child', true)
  expect((await poll())?.payload.subagents).toBeUndefined()
})

it('settles only the launch whose root result reports a failure', async () => {
  spawn(undefined, 5)
  const failedInvoke = 'subagent "x" not found or not allowed to be invoked'
  hook('root', 'PostToolUse', {
    ...launch(6),
    error: failedInvoke
  })
  expect(row.payload.antigravitySpawnPending).toBe(true)
  const error = `Encountered error in step execution: ${failedInvoke}`
  launchResult(6, error, 'ERROR')
  expect((await poll())?.payload.antigravitySpawnPending).toBe(true)
  launchResult(5, error, 'ERROR')
  expect((await poll())?.payload.antigravitySpawnPending).toBeUndefined()
  expect(hook('root', 'Stop', { fullyIdle: true })?.payload.state).toBe('done')
  expect(hook('root', 'PreToolUse', launch(6))).toBeNull()
  expect(hook('root', 'PostToolUse', launch(5))).toBeNull()
  expect(row.payload.state).toBe('done')
  expect(row.payload.antigravitySpawnPending).toBeUndefined()
})

it.each([
  ['PreToolUse', 'PostToolUse'],
  ['PostToolUse', 'PreToolUse']
])(
  'keeps the root question visible after a settled launch delivers %s then %s',
  async (first, late) => {
    const oldLaunch = { ...launch(5), prompt: 'Earlier task', modelName: 'model-a' }
    const failure =
      'Encountered error in step execution: subagent "x" not found or not allowed to be invoked'
    hook('root', first, oldLaunch)
    launchResult(5, failure, 'ERROR')
    expect((await poll())?.payload.antigravitySpawnPending).toBeUndefined()

    hook('root', 'PreInvocation', { prompt: 'Current task', modelName: 'model-b' })
    const question = {
      stepIdx: 7,
      toolCall: { id: 'question-7', name: 'ask_question', args: { question: 'Continue?' } }
    }
    const waiting = {
      state: 'waiting',
      toolName: 'ask_question',
      toolInput: 'Continue?',
      prompt: 'Current task',
      model: 'model-b'
    }
    expect(hook('root', 'PreToolUse', question)?.payload).toMatchObject(waiting)
    expect(hook('root', late, oldLaunch)).toBeNull()
    expect(row.payload).toMatchObject(waiting)

    expect(hook('root', 'PostToolUse', question)?.payload.state).toBe('working')
    spawn(undefined, 8)
    launchResult(8, failure, 'ERROR')
    expect((await poll())?.payload.antigravitySpawnPending).toBeUndefined()
    expect(
      hook('root', 'PostToolUse', { ...launch(8), modelName: 'model-c' })?.payload
    ).toMatchObject({
      state: 'working',
      toolName: 'invoke_subagent',
      model: 'model-c'
    })
  }
)

it('keeps a newer root question visible after a late PostToolUse from a pending launch', async () => {
  const previousLaunch = { ...launch(300), prompt: 'Earlier task', modelName: 'model-a' }
  expect(hook('root', 'PreToolUse', previousLaunch)?.payload.antigravitySpawnPending).toBe(true)

  hook('root', 'PreInvocation', { prompt: 'Current task', modelName: 'model-b' })
  const swarm = {
    stepIdx: 301,
    toolCall: { id: 'swarm-301', name: 'swarm', args: { action: 'add', tasks: ['worker'] } }
  }
  hook('root', 'PreToolUse', swarm)
  expect(hook('root', 'PreToolUse', previousLaunch)).toBeNull()
  expect(hook('root', 'PostToolUse', swarm)?.payload).toMatchObject({
    state: 'working',
    toolName: 'swarm',
    prompt: 'Current task',
    model: 'model-b'
  })

  const waiting = {
    state: 'waiting',
    toolName: 'ask_question',
    toolInput: 'Continue?',
    prompt: 'Current task',
    model: 'model-b',
    mainAgent: { state: 'waiting' }
  }
  expect(
    hook('root', 'PreToolUse', {
      stepIdx: 302,
      toolCall: { id: 'question-302', name: 'ask_question', args: { question: 'Continue?' } }
    })?.payload
  ).toMatchObject({ ...waiting, antigravitySpawnPending: true })
  expect(hook('root', 'PostToolUse', previousLaunch)).toBeNull()
  expect(hook('root', 'PostToolUse', previousLaunch)).toBeNull()
  expect(row.payload).toMatchObject({ ...waiting, antigravitySpawnPending: true })

  launchResult(
    300,
    'Encountered error in step execution: subagent "x" not found or not allowed to be invoked',
    'ERROR'
  )
  expect((await poll())?.payload).toMatchObject({ ...waiting, antigravitySpawnPending: true })

  transcript('worker')
  expect(hook('worker', 'Stop', { fullyIdle: true })).toBeNull()
  launchResult(301, JSON.stringify({ status: 'added', name: 'worker', conversation_id: 'worker' }))
  const settled = await poll()
  expect(settled?.payload).toMatchObject(waiting)
  expect(settled?.payload.antigravitySpawnPending).toBeUndefined()
})

it('holds an old first-delivered phase through a newer question until its matching root result', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const failure =
      'Encountered error in step execution: subagent "x" not found or not allowed to be invoked'
    for (let step = 10; step <= 266; step++) {
      spawn(undefined, step)
      launchResult(step, failure, 'ERROR')
    }
    expect(row.payload).toMatchObject({ state: 'working', antigravitySpawnPending: true })
    await poll()
    expect(row.payload.state).toBe('working')
    expect(row.payload).not.toHaveProperty('antigravitySpawnPending')

    hook('root', 'PreInvocation', { prompt: 'Current task', modelName: 'model-b' })
    const question = {
      stepIdx: 270,
      toolCall: { id: 'question-270', name: 'ask_question', args: { question: 'Continue?' } }
    }
    const waiting = {
      state: 'waiting',
      toolName: 'ask_question',
      toolInput: 'Continue?',
      prompt: 'Current task',
      model: 'model-b',
      mainAgent: { state: 'waiting' }
    }
    expect(hook('root', 'PreToolUse', question)?.payload).toMatchObject(waiting)
    expect(hook('root', 'PostToolUse', launch(11))).toBeNull()
    const oldLaunch = { ...launch(5), prompt: 'Earlier task', modelName: 'model-a' }
    expect(hook('root', 'PreToolUse', oldLaunch)?.payload).toMatchObject({
      ...waiting,
      antigravitySpawnPending: true
    })
    expect(hook('root', 'PostToolUse', oldLaunch)).toBeNull()
    expect(row.payload).toMatchObject(waiting)

    expect(hook('root', 'PostToolUse', question)?.payload.state).toBe('working')
    const held = {
      state: 'working',
      mainAgent: { state: 'done' },
      antigravitySpawnPending: true
    }
    expect(hook('root', 'Stop', { fullyIdle: true })?.payload).toMatchObject(held)

    transcript('foreign')
    launchResult(5, failure, 'ERROR', 'foreign')
    expect(hook('foreign', 'PreInvocation')).toBeNull()
    launchResult(6, failure, 'ERROR')
    expect((await poll())?.payload).toMatchObject(held)

    launchResult(5, failure, 'ERROR')
    expect((await poll())?.antigravityHelpersDrained).toBe(true)
    expect(row.payload).not.toHaveProperty('antigravitySpawnPending')
    vi.advanceTimersByTime(ANTIGRAVITY_PARENT_WAKE_GRACE_MS + 1)
    expect((await poll())?.payload.state).toBe('done')
  } finally {
    vi.useRealTimers()
  }
})

it('counts only a swarm add as a spawn that holds the parent', async () => {
  transcript('child')
  descriptor('child')
  spawn('child')
  hook('child', 'PreInvocation')
  await poll()
  const swarm = (action: string) =>
    hook('root', 'PreToolUse', { toolCall: { name: 'swarm', args: { action } } })?.payload
  expect(swarm('status')?.antigravitySpawnPending).toBeUndefined()
  expect(swarm('add')?.antigravitySpawnPending).toBe(true)
})

it('holds the root for every worker named by one Swarm result, including workers whose hooks have not arrived', async () => {
  const swarm = join(dir, 'root', '.system_generated', 'swarm')
  mkdirSync(swarm, { recursive: true })
  hook('root', 'PostToolUse', {
    stepIdx: 8,
    toolCall: {
      id: 'call-swarm',
      name: 'swarm',
      args: { action: 'add', tasks: ['first', 'second'] }
    }
  })
  launchResult(
    8,
    JSON.stringify({
      status: 'added',
      names: ['victim-1', 'victim-2'],
      conversation_ids: ['killed', 'running']
    })
  )
  hook('root', 'Stop', { fullyIdle: true })
  await poll()
  expect(row.payload).toMatchObject({ state: 'working', antigravitySpawnPending: true })
  writeFileSync(
    join(swarm, 'members.json'),
    JSON.stringify({
      members: { 'victim-1': { conversation_id: 'killed', phase: 'KILLED' } }
    })
  )
  transcript('foreign')
  hook('foreign', 'PreToolUse', { toolCall: { name: 'ask_question', args: {} } })
  await poll()
  await poll()
  expect(row.payload).toMatchObject({
    state: 'working',
    antigravitySpawnPending: true,
    subagents: undefined
  })
  descriptor('running')
  transcript('running')
  hook('running', 'PreInvocation')
  await poll()
  expect(row.payload.subagents?.map(({ id }) => id)).toEqual(['running'])
  expect(row.payload.antigravitySpawnPending).toBeUndefined()
})

it('keeps an ambiguous step held even when a root result names a child at that step', async () => {
  spawn(undefined, 5)
  hook('root', 'PostToolUse', {
    stepIdx: 5,
    toolCall: { id: 'another-call', name: 'invoke_subagent' }
  })
  invokeResult('child')
  descriptor('child')
  transcript('child')
  hook('child', 'PreInvocation')
  await poll()
  hook('child', 'Stop', { fullyIdle: true })
  hook('root', 'Stop', { fullyIdle: true })
  await poll()
  expect(row.payload).toMatchObject({ state: 'working', antigravitySpawnPending: true })
})

it('retries proving a stopped subagent while its spawn is pending', async () => {
  transcript('child')
  spawn()
  hook('child', 'PreInvocation')
  hook('root', 'Stop', { fullyIdle: false })
  hook('child', 'Stop', { fullyIdle: true })
  await poll()
  expect(row.payload.subagents).toBeUndefined()
  descriptor('child')
  expect((await poll())?.payload.subagents?.map((child) => child.id)).toEqual(['child'])
})

it('holds the parent for a proven subagent woken again by a message', async () => {
  transcript('child')
  descriptor('child')
  spawn('child')
  hook('child', 'PreInvocation')
  await poll()
  hook('child', 'Stop', { fullyIdle: true })
  hook('root', 'PreToolUse', { toolCall: { name: 'send_message', args: {} } })
  hook('child', 'PreInvocation')
  expect(
    hook('root', 'Stop', { fullyIdle: false })?.payload.subagents?.map((child) => child.id)
  ).toEqual(['child'])
})

it('finishes the lead once a subagent woken after its busy Stop is proven', async () => {
  transcript('child')
  descriptor('child')
  hook('root', 'PreToolUse', { toolCall: { name: 'send_message', args: {} } })
  expect(hook('root', 'Stop', { fullyIdle: false })?.payload.mainAgent?.state).toBe('working')
  hook('child', 'PreInvocation')
  const polled = await poll()
  expect(polled?.payload.subagents?.map((child) => child.id)).toEqual(['child'])
  expect(polled?.payload.mainAgent?.state).toBe('done')
})

it('keeps a lead model a hook reports while an older transcript read runs', async () => {
  hook('root', 'Stop', { fullyIdle: true })
  hook('root', 'PreInvocation', { lastUserInput: 'Next', modelName: 'auto' })
  appendFileSync(
    join(dir, 'root', '.system_generated', 'logs', 'transcript.jsonl'),
    `${JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'model-c', created_at: '2999-01-01T00:00:00Z' })}\n`
  )
  const reads = readAntigravityTranscriptPoll(state, paneKey)
  hook('root', 'PreToolUse', { modelName: 'model-d', toolCall: { name: 'read_file' } })
  expect(pollAntigravityTranscriptStatus(state, row, await reads)?.payload.model).toBe('model-d')
})
