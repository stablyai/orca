import { join } from 'node:path'
import { expect, it } from 'vitest'
import { clearPaneCacheState } from '../../listener-state'
import {
  launch,
  launchFailure,
  paneKey,
  setupAntigravityChildLifecycle
} from './antigravity-child-lifecycle.test-fixture'

const fixture = setupAntigravityChildLifecycle()
const { descriptor, hook, invokeResult, launchResult, poll, transcript } = fixture

it.each([
  ['PreToolUse', 'PostToolUse', true],
  ['PostToolUse', 'PreToolUse', true],
  ['PreToolUse', 'PostToolUse', false],
  ['PostToolUse', 'PreToolUse', false]
] as const)(
  'settles two cached ERROR replays before polling after %s then %s (result before pairing: %s)',
  async (first, late, resultBeforePair) => {
    const oldLaunch = { ...launch(5), prompt: 'Earlier task', modelName: 'model-a' }
    const parallelLaunch = { ...launch(6), prompt: 'Earlier task', modelName: 'model-a' }
    expect(hook('root', first, oldLaunch)?.payload).toMatchObject({
      toolName: 'invoke_subagent',
      antigravitySpawnPending: true
    })
    expect(hook('root', first, oldLaunch)).toBeNull()
    hook('root', first, parallelLaunch)
    hook('root', late, parallelLaunch)
    launchResult(6, launchFailure, 'ERROR')
    if (resultBeforePair) {
      launchResult(5, launchFailure, 'ERROR')
      expect((await poll())?.payload.antigravitySpawnPending).toBeUndefined()
      expect(hook('root', first, oldLaunch)).toBeNull()
    }

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
    expect(fixture.row.payload).toMatchObject(waiting)
    if (!resultBeforePair) {
      expect(hook('root', late, oldLaunch)).toBeNull()
      launchResult(5, launchFailure, 'ERROR')
      expect((await poll())?.payload).toMatchObject(waiting)
      expect(fixture.row.payload.antigravitySpawnPending).toBeUndefined()
    }

    const replays = [oldLaunch, parallelLaunch].map((replay) => hook('root', late, replay))
    expect(replays).toEqual([null, null])
    expect((await poll())?.payload).toMatchObject(waiting)
    expect(fixture.row.payload.antigravitySpawnPending).toBeUndefined()
    for (const replay of [oldLaunch, parallelLaunch]) {
      expect(hook('root', late, replay)).toBeNull()
      expect(hook('root', first, replay)).toBeNull()
    }

    expect(hook('root', 'PostToolUse', question)?.payload.state).toBe('working')
    expect(hook('root', 'Stop', { fullyIdle: true })?.payload.state).toBe('done')
    hook('root', 'PreInvocation', { prompt: 'Current task', modelName: 'model-b' })
    transcript('foreign')
    expect(hook('foreign', 'PreToolUse', { ...question, stepIdx: 1000 })).toBeNull()
    expect(hook('root', first, launch(8))?.payload).toMatchObject({
      state: 'working',
      toolName: 'invoke_subagent',
      model: 'model-b'
    })
    if (resultBeforePair) {
      launchResult(8, launchFailure, 'ERROR')
      expect((await poll())?.payload.antigravitySpawnPending).toBeUndefined()
    }
    const currentPhase = hook('root', late, { ...launch(8), modelName: 'model-c' })
    if (late === 'PostToolUse') {
      expect(currentPhase?.payload).toMatchObject({ toolName: 'invoke_subagent', model: 'model-c' })
    } else {
      expect(currentPhase).toBeNull()
      expect(fixture.row.payload.model).toBe('model-b')
    }
  }
)

it.each([
  ['mismatched tool', launch(6)],
  [
    'mismatched Swarm arity',
    {
      stepIdx: 6,
      toolCall: { id: 'swarm-6', name: 'swarm', args: { action: 'add', tasks: ['a'] } }
    }
  ]
] as const)(
  'applies cached parallel successes in the poll and holds a replay with %s',
  async (_, invalidReplay) => {
    const swarm = {
      stepIdx: 6,
      toolCall: { id: 'swarm-6', name: 'swarm', args: { action: 'add', tasks: ['a', 'b'] } }
    }
    const question = {
      stepIdx: 7,
      modelName: 'model-b',
      toolCall: { id: 'question-7', name: 'ask_question', args: { question: 'Continue?' } }
    }
    hook('root', 'PreInvocation', { prompt: 'Current task', modelName: 'auto' })
    invokeResult('worker')
    launchResult(
      6,
      JSON.stringify({ status: 'added', names: ['a', 'b'], conversation_ids: ['a', 'b'] })
    )
    expect((await poll())?.payload.antigravitySpawnPending).toBeUndefined()
    expect(hook('root', 'PreToolUse', question)?.payload.state).toBe('waiting')
    for (const id of ['worker', 'a', 'b']) {
      descriptor(id)
    }
    const waiting = {
      state: 'waiting',
      prompt: 'Current task',
      model: 'model-b',
      toolName: 'ask_question',
      toolInput: 'Continue?'
    }
    expect(hook('root', 'PreToolUse', launch(5))?.payload).toMatchObject({
      ...waiting,
      antigravitySpawnPending: true
    })
    expect(hook('root', 'PostToolUse', swarm)).toBeNull()
    expect(hook('root', 'PostToolUse', launch(5))).toBeNull()
    expect(hook('root', 'PreToolUse', swarm)).toBeNull()
    expect((await poll())?.payload).toMatchObject({ ...waiting, antigravitySpawnPending: true })
    expect(fixture.row.payload.subagents).toBeUndefined()

    transcript('worker')
    expect(hook('worker', 'PreToolUse', question)).toBeNull()
    expect(fixture.row.payload.subagents).toBeUndefined()
    await poll()
    expect(fixture.row.payload.antigravitySpawnPending).toBeUndefined()
    expect(fixture.row.payload.subagents).toHaveLength(3)
    expect(fixture.row.payload.subagents).toContainEqual(
      expect.objectContaining({ id: 'worker', state: 'waiting' })
    )

    expect(hook('root', 'PostToolUse', launch(5))).toBeNull()
    expect(hook('root', 'PreToolUse', swarm)).toBeNull()
    expect(hook('root', 'PreToolUse', launch(5))).toBeNull()
    expect(hook('root', 'PostToolUse', swarm)).toBeNull()
    expect(fixture.row.payload).toMatchObject(waiting)
    expect(fixture.row.payload.antigravitySpawnPending).toBeUndefined()

    const held = { ...waiting, antigravitySpawnPending: true }
    expect(hook('root', 'PostToolUse', invalidReplay)?.payload).toMatchObject(held)
    expect((await poll())?.payload).toMatchObject(held)
  }
)

it('requires the hook transcript to match before settling a cached replay at admission', async () => {
  hook('root', 'PreToolUse', launch(5))
  hook('root', 'PostToolUse', launch(5))
  launchResult(5, launchFailure, 'ERROR')
  await poll()
  hook('root', 'PreToolUse', {
    stepIdx: 6,
    toolCall: { name: 'ask_question', args: { question: 'Continue?' } }
  })
  expect(hook('root', 'PostToolUse', launch(5))).toBeNull()
  expect(hook('root', 'PreToolUse', launch(5))).toBeNull()

  const otherPath = join(fixture.dir, 'root', '.system_generated', 'logs', 'transcript_full.jsonl')
  const waiting = { state: 'waiting', toolName: 'ask_question', toolInput: 'Continue?' }
  expect(
    hook('root', 'PostToolUse', { ...launch(5), transcriptPath: otherPath })?.payload
  ).toMatchObject({ ...waiting, antigravitySpawnPending: true })
  expect((await poll())?.payload).toMatchObject(waiting)
  expect(fixture.row.payload.antigravitySpawnPending).toBeUndefined()
})

it.each([
  ['root named as a child', 'root'],
  ['conflicting transcript results', 'worker']
] as const)('keeps an older launch held for %s alongside a settled replay', async (_, child) => {
  hook('root', 'PreInvocation', { modelName: 'auto' })
  invokeResult(child)
  if (child === 'worker') {
    launchResult(5, launchFailure, 'ERROR')
  }
  launchResult(6, launchFailure, 'ERROR')
  await poll()
  hook('root', 'PreToolUse', {
    stepIdx: 7,
    toolCall: { name: 'ask_question', args: { question: 'Continue?' } }
  })

  expect(hook('root', 'PostToolUse', launch(6))).toBeNull()
  expect(hook('root', 'PostToolUse', launch(5))?.payload).toMatchObject({
    state: 'waiting',
    antigravitySpawnPending: true
  })
  expect((await poll())?.payload.antigravitySpawnPending).toBe(true)
  expect(fixture.row.payload.subagents).toBeUndefined()

  clearPaneCacheState(fixture.state, paneKey)
  hook('root', 'PreInvocation', { prompt: 'New root task', modelName: 'model-c' })
  expect(hook('root', 'PreToolUse', launch(6))?.payload).toMatchObject({
    state: 'working',
    prompt: 'New root task',
    toolName: 'invoke_subagent',
    antigravitySpawnPending: true
  })
})
