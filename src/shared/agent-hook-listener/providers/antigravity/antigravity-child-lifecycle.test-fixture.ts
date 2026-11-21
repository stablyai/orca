import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import {
  pollAntigravityTranscriptStatus,
  readAntigravityTranscriptPoll
} from './antigravity-transcript-poll'
import type { AgentHookEventPayload } from '../../listener-event'

export const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
export const launchFailure =
  'Encountered error in step execution: subagent "x" not found or not allowed to be invoked'

export function launch(stepIdx = 5): Record<string, unknown> {
  return { stepIdx, toolCall: { id: `invoke-${stepIdx}`, name: 'invoke_subagent', args: {} } }
}

export function swarmAdd(stepIdx: number, name = 'qa16worker') {
  return {
    stepIdx,
    toolCall: {
      id: `swarm-${stepIdx}`,
      name: 'swarm',
      args: { action: 'add', name, tasks: ['First task', 'Second task'] }
    }
  }
}

export function swarmDuplicateError(name = 'qa16worker-1'): string {
  return `Encountered error in step execution: the swarm already has a member named "${name}"`
}

export function setupAntigravityChildLifecycle() {
  let dir: string
  let state: ReturnType<typeof createHookListenerState>
  let row: AgentHookEventPayload

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
  function launchResult(
    step: number,
    content: string,
    status = 'DONE',
    conversation = 'root'
  ): void {
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
  function resetState(): void {
    state = createHookListenerState()
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-child-lifecycle-'))
    resetState()
    transcript('root', true)
    hook('root', 'PreInvocation', { lastUserInput: 'Task', modelName: 'model-a' })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  return {
    get dir() {
      return dir
    },
    get row() {
      return row
    },
    get state() {
      return state
    },
    resetState,
    transcript,
    descriptor,
    hook,
    poll,
    launchResult,
    invokeResult,
    spawn
  }
}
