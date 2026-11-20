import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  expect((await poll())?.payload.subagents?.[0]?.id).toBe('child')
  expect(hook('child', 'Stop', { fullyIdle: true })?.payload).toMatchObject({
    state: 'working',
    subagents: undefined
  })
  expect(hook('root', 'Stop', { fullyIdle: false })?.payload.state).toBe('working')
  await poll()
  expect(hook('child', 'PreInvocation')?.payload.subagents?.[0]?.id).toBe('child')
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
  expect((await poll())?.payload.subagents?.[0]?.id).toBe('worker')
  hook('worker', 'Stop', { fullyIdle: true })
  expect((await poll())?.payload.subagents).toBeUndefined()
  writeMember('mentions')
  await poll()
  expect(hook('worker', 'PreInvocation')?.payload.subagents?.[0]?.id).toBe('worker')
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
  await poll()
  hook('old', 'Stop', { fullyIdle: true })
  spawn()
  hook('root', 'Stop', { fullyIdle: false })
  expect((await poll())?.payload.state).toBe('working')
  transcript('new')
  descriptor('new')
  expect((await poll())?.payload.subagents?.map((child) => child.id)).toEqual(['new'])
})
