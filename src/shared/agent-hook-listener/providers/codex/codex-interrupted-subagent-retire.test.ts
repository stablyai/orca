// Paginated-history Codex rollouts write subagent activity only as item_completed/SubAgentActivity items.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import { upsertBoundedAgentHookStatus } from '../../state/agent-hook-status-cache'
import { upsertCodexSubagent, type CodexSubagentRoster } from './codex-subagent-roster'
import {
  createCodexSubagentTranscriptState,
  hasTrackedCodexTranscriptSubagents,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'

const CHILD_ID = '019a8f4b-2c1d-7e00-9a00-000000000001'
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const directories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function jsonl(records: object[]): string {
  return records.map((value) => `${JSON.stringify(value)}\n`).join('')
}

function eventMsg(payload: Record<string, unknown>): object {
  return { type: 'event_msg', payload }
}

function subAgentActivity(kind: string): object {
  return eventMsg({
    type: 'item_completed',
    thread_id: '019a8f4b-2c1d-7e00-9a00-000000000000',
    turn_id: 'turn-lead',
    item: {
      type: 'SubAgentActivity',
      model: null,
      reasoning_effort: null,
      id: `call-${kind}`,
      kind,
      agent_thread_id: CHILD_ID,
      agent_path: '/root/researcher'
    },
    started_at_ms: 1_700_000_000_000,
    completed_at_ms: 1_700_000_000_000
  })
}

function rollouts(parent: object[], child: object[]): { parentPath: string; childPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'codex-interrupted-subagent-'))
  directories.push(directory)
  const parentPath = join(directory, 'rollout-2026-11-25T00-00-00-parent.jsonl')
  const childPath = join(directory, `rollout-2026-11-25T00-00-01-${CHILD_ID}.jsonl`)
  writeFileSync(parentPath, jsonl(parent))
  writeFileSync(childPath, jsonl(child))
  return { parentPath, childPath }
}

const childTurn = eventMsg({ type: 'task_started', turn_id: 'turn-child' })
const childInterrupted = eventMsg({
  type: 'turn_aborted',
  turn_id: 'turn-child',
  reason: 'interrupted'
})

/** A hook-known child working in its own turn, then interrupted by the lead. */
function interruptedChild(): {
  parentPath: string
  childPath: string
  roster: CodexSubagentRoster
  state: ReturnType<typeof createCodexSubagentTranscriptState>
} {
  const paths = rollouts([], [childTurn])
  const roster: CodexSubagentRoster = new Map()
  upsertCodexSubagent(roster, CHILD_ID, { state: 'working' }, Date.now())
  const state = createCodexSubagentTranscriptState()
  reconcileCodexSubagentTranscript(state, roster, paths.parentPath)
  // The child's abort can be read a poll before the parent's interrupt item.
  appendFileSync(paths.childPath, jsonl([childInterrupted]))
  reconcileCodexSubagentTranscript(state, roster, paths.parentPath)
  appendFileSync(paths.parentPath, jsonl([subAgentActivity('interrupted')]))
  reconcileCodexSubagentTranscript(state, roster, paths.parentPath)
  expect(roster.size).toBe(0)
  return { ...paths, roster, state }
}

it('retires a hook-known child the parent rollout reports as an interrupted item', () => {
  // A forked child's rollout ends its copied history with an interrupted turn_aborted boundary.
  const { parentPath } = rollouts(
    [eventMsg({ type: 'task_started', turn_id: 'turn-lead' }), subAgentActivity('started')],
    [
      eventMsg({ type: 'task_started', turn_id: 'turn-lead' }),
      eventMsg({ type: 'turn_aborted', turn_id: 'turn-lead', reason: 'interrupted' })
    ]
  )
  const roster: CodexSubagentRoster = new Map()
  upsertCodexSubagent(roster, CHILD_ID, { state: 'working' }, Date.now())
  const state = createCodexSubagentTranscriptState()
  reconcileCodexSubagentTranscript(state, roster, parentPath)
  expect([...roster.keys()]).toEqual([CHILD_ID])

  appendFileSync(parentPath, jsonl([subAgentActivity('interrupted')]))
  reconcileCodexSubagentTranscript(state, roster, parentPath)

  expect(roster.size).toBe(0)
})

it('does not re-add children from paginated started or interacted items', () => {
  // A resume rereads the parent tail; a child killed mid-turn never wrote a closing event.
  const { parentPath } = rollouts(
    [subAgentActivity('started'), subAgentActivity('interrupted'), subAgentActivity('interacted')],
    [childTurn]
  )
  const roster: CodexSubagentRoster = new Map()
  reconcileCodexSubagentTranscript(createCodexSubagentTranscriptState(), roster, parentPath)

  expect(roster.size).toBe(0)
})

it('shows an interrupted child working again once a follow-up starts its next turn', () => {
  const { parentPath, childPath, roster, state } = interruptedChild()
  appendFileSync(childPath, jsonl([childTurn]))
  appendFileSync(parentPath, jsonl([subAgentActivity('interacted')]))
  reconcileCodexSubagentTranscript(state, roster, parentPath)
  expect(roster.get(CHILD_ID)?.state).toBe('working')

  appendFileSync(childPath, jsonl([eventMsg({ type: 'task_complete', turn_id: 'turn-child' })]))
  reconcileCodexSubagentTranscript(state, roster, parentPath)
  expect(roster.size).toBe(0)
})

it('keeps an interrupted child retired when a queued message starts no turn', () => {
  const { parentPath, childPath, roster, state } = interruptedChild()
  appendFileSync(parentPath, jsonl([subAgentActivity('interacted')]))
  reconcileCodexSubagentTranscript(state, roster, parentPath)
  expect(roster.size).toBe(0)
  // Still read for a late task_started, but it must not keep the transcript poll alive.
  expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)

  // A later follow-up still finds the child that the queued message re-added and retired.
  appendFileSync(childPath, jsonl([childTurn]))
  appendFileSync(parentPath, jsonl([subAgentActivity('interacted')]))
  reconcileCodexSubagentTranscript(state, roster, parentPath)
  expect(roster.get(CHILD_ID)?.state).toBe('working')
})

it('keeps a re-tasked child whose hook arrived before the interrupt was read', () => {
  const { parentPath, childPath } = rollouts([], [childTurn])
  const roster: CodexSubagentRoster = new Map()
  upsertCodexSubagent(roster, CHILD_ID, { state: 'working' }, Date.now())
  const state = createCodexSubagentTranscriptState()
  reconcileCodexSubagentTranscript(state, roster, parentPath)

  appendFileSync(childPath, jsonl([childInterrupted, childTurn]))
  appendFileSync(
    parentPath,
    jsonl([subAgentActivity('interrupted'), subAgentActivity('interacted')])
  )
  reconcileCodexSubagentTranscript(state, roster, parentPath)

  expect(roster.get(CHILD_ID)?.state).toBe('working')
})

it('shows a re-tasked child again when a WSL hook reads the follow-up before its new turn', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_700_000_000_000)
  const { parentPath, childPath } = rollouts([], [childTurn])
  const state = createHookListenerState()
  // The WSL guest normalizes each hook with no prefetch scope, so rollouts are reread synchronously.
  const post = (payload: Record<string, unknown>) => {
    const row = normalizeHookPayload(
      state,
      'codex',
      { paneKey: PANE_KEY, env: 'env-1', payload: JSON.stringify(payload) },
      'env-1'
    )
    if (row) {
      upsertBoundedAgentHookStatus(state, row)
    }
    return row?.payload.subagents ?? []
  }
  const lead = { session_id: 'lead', turn_id: 'turn-lead', transcript_path: parentPath }
  post({ ...lead, hook_event_name: 'UserPromptSubmit', prompt: 'go' })
  post({ hook_event_name: 'PreToolUse', agent_id: CHILD_ID, tool_name: 'Bash' })
  appendFileSync(childPath, jsonl([childInterrupted]))
  appendFileSync(parentPath, jsonl([subAgentActivity('interrupted')]))
  expect(post({ ...lead, hook_event_name: 'PostToolUse', tool_name: 'interrupt_agent' })).toEqual(
    []
  )

  vi.setSystemTime(1_700_000_060_000)
  appendFileSync(parentPath, jsonl([subAgentActivity('interacted')]))
  // The child's rollout still ends on the interrupted turn, so its row waits for the new turn.
  expect(post({ ...lead, hook_event_name: 'PostToolUse', tool_name: 'followup_task' })).toEqual([])

  vi.setSystemTime(1_700_000_061_000)
  appendFileSync(childPath, jsonl([childTurn]))
  expect(post({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'wait_agent' })).toMatchObject([
    { id: CHILD_ID, state: 'working', startedAt: 1_700_000_060_000 }
  ])
})

it('stops reading a re-tasked child that started no turn within the grace', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { parentPath, childPath, roster, state } = interruptedChild()
  appendFileSync(parentPath, jsonl([subAgentActivity('interacted')]))
  reconcileCodexSubagentTranscript(state, roster, parentPath)
  vi.advanceTimersByTime(5_000)
  reconcileCodexSubagentTranscript(state, roster, parentPath)
  expect(state.subagents.size).toBe(0)

  // Only a later follow-up shows it again.
  appendFileSync(childPath, jsonl([childTurn]))
  reconcileCodexSubagentTranscript(state, roster, parentPath)
  expect(roster.size).toBe(0)
  appendFileSync(parentPath, jsonl([subAgentActivity('interacted')]))
  reconcileCodexSubagentTranscript(state, roster, parentPath)
  expect(roster.get(CHILD_ID)?.state).toBe('working')
})
