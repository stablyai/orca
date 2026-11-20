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
})
