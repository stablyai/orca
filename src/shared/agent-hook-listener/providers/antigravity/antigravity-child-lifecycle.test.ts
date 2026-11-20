import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import {
  pollAntigravityTranscriptStatus,
  readAntigravityTranscriptPoll
} from './antigravity-transcript-poll'
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
function spawn(): void {
  hook('root', 'PreToolUse', { toolCall: { name: 'invoke_subagent', args: { Role: 'Research' } } })
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-child-lifecycle-'))
  state = createHookListenerState()
  transcript('root', true)
  hook('root', 'PreInvocation', { lastUserInput: 'Task', modelName: 'model-a' })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('wakes a retired child again and releases its command hold when disk reports it killed', async () => {
  transcript('child')
  descriptor('child')
  spawn()
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
  expect((await poll())?.payload.subagents).toBeUndefined()
  writeMember('mentions')
  await poll()
  hook('worker', 'PreInvocation')
  expect((await poll())?.payload.subagents?.[0]?.id).toBe('worker')
  expect((await poll())?.payload.subagents?.[0]?.id).toBe('worker')
  hook('root', 'Stop', { fullyIdle: true })
  hook('root', 'PreInvocation', { lastUserInput: 'Next task' })
  hook('root', 'PreToolUse', { toolCall: { name: 'swarm_wait' } })
  expect((await poll())?.payload.subagents).toBeUndefined()
})

it('keeps waiting for a new child when a prior child descriptor remains on disk', async () => {
  transcript('old')
  descriptor('old')
  spawn()
  hook('old', 'PreInvocation')
  await poll()
  hook('old', 'Stop', { fullyIdle: true })
  spawn()
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
  spawn()
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
  spawn()
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

it('keeps a root command monitoring after its child finishes', async () => {
  transcript('child')
  descriptor('child')
  hook('root', 'PreToolUse', {
    stepIdx: 4,
    toolCall: { name: 'run_command', args: { CommandLine: 'long-task' } }
  })
  spawn()
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
  transcript('helper')
  spawn()
  hook('helper', 'PreInvocation')
  hook('helper', 'PreToolUse', { toolCall: { name: 'ask_question', args: {} } })
  expect((await poll())?.payload).toMatchObject({ state: 'working', subagents: undefined })
  descriptor('helper')
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
  spawn()
  spawn()
  hook('first', 'PreInvocation')
  await poll()
  hook('root', 'Stop', { fullyIdle: false })
  hook('first', 'Stop', { fullyIdle: true })
  expect(
    hook('root', 'PostToolUse', { stepIdx: 5, toolCall: { name: 'run_command' } })?.payload.state
  ).toBe('done')
  descriptor('second')
  hook('second', 'PreInvocation')
  hook('second', 'PreToolUse', { toolCall: { name: 'ask_question', args: {} } })
  expect((await poll())?.payload).toMatchObject({
    state: 'waiting',
    subagents: [{ id: 'second', state: 'waiting' }]
  })
  hook('second', 'Stop', { fullyIdle: true })
  expect((await poll())?.payload.subagents).toBeUndefined()
})

it('ignores a child that wakes after the root finished', async () => {
  transcript('child')
  descriptor('child')
  spawn()
  hook('child', 'PreInvocation')
  await poll()
  expect(hook('root', 'Stop', { fullyIdle: true })?.payload.state).toBe('done')
  expect(hook('child', 'PreInvocation')).toBeNull()
  expect((await poll())?.payload.state ?? row.payload.state).toBe('done')
  hook('root', 'PreInvocation', { lastUserInput: 'Next' })
  spawn()
  hook('child', 'PreInvocation')
  expect((await poll())?.payload.subagents?.map((child) => child.id)).toEqual(['child'])
})

it('lists a subagent killed before its first poll once, then clears it', async () => {
  transcript('child')
  descriptor('child', true)
  spawn()
  hook('child', 'PreInvocation')
  hook('root', 'Stop', { fullyIdle: false })
  expect((await poll())?.payload.subagents?.map((child) => child.id)).toEqual(['child'])
  expect((await poll())?.payload.subagents).toBeUndefined()
})

it('releases the parent when agy reports the spawn failed', () => {
  spawn()
  hook('root', 'PostToolUse', {
    toolCall: { name: 'invoke_subagent' },
    error: 'subagent "x" not found or not allowed to be invoked'
  })
  expect(hook('root', 'Stop', { fullyIdle: false })?.payload.state).toBe('done')
})

it('counts only a swarm add as a spawn that holds the parent', async () => {
  transcript('child')
  descriptor('child')
  spawn()
  hook('child', 'PreInvocation')
  await poll()
  const swarm = (action: string) =>
    hook('root', 'PreToolUse', { toolCall: { name: 'swarm', args: { action } } })?.payload
  expect(swarm('status')?.antigravitySpawnPending).toBeUndefined()
  expect(swarm('add')?.antigravitySpawnPending).toBe(true)
})

it('retries proving a stopped subagent while its spawn is pending', async () => {
  transcript('child')
  spawn()
  hook('child', 'PreInvocation')
  hook('root', 'Stop', { fullyIdle: false })
  hook('child', 'Stop', { fullyIdle: true })
  expect((await poll())?.payload.subagents).toBeUndefined()
  descriptor('child')
  expect((await poll())?.payload.subagents?.map((child) => child.id)).toEqual(['child'])
})

it('holds the parent for a proven subagent woken again by a message', async () => {
  transcript('child')
  descriptor('child')
  spawn()
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
