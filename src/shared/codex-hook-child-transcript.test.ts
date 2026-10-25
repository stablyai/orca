import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from './agent-hook-listener/listener-state'
import { pollCodexTranscriptStatus } from './agent-hook-listener/providers/codex-transcript-poll'
import { shouldPollHookTranscript } from './agent-hook-listener/transcript-poll-policy'
import { makePaneKey } from './stable-pane-id'

const PANE = makePaneKey('tab', '11111111-1111-4111-8111-111111111111')
const CHILD = '01a16839-7f84-7ed3-aebf-ea51e50330cf'
const line = (type: string): string =>
  `${JSON.stringify({ type: 'event_msg', payload: { type } })}\n`

describe('Codex hook-only child transcript reconciliation', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true })
    }
    directories.length = 0
  })

  function fixture(completed: boolean) {
    const directory = mkdtempSync(join(tmpdir(), 'codex-hook-child-'))
    directories.push(directory)
    const parentPath = join(directory, 'rollout-parent.jsonl')
    const childPath = join(directory, `rollout-child-${CHILD}.jsonl`)
    writeFileSync(parentPath, line('task_complete'))
    writeFileSync(childPath, line('task_started') + (completed ? line('task_complete') : ''))
    const state = createHookListenerState()
    const rootBody = {
      paneKey: PANE,
      payload: {
        hook_event_name: 'Stop',
        session_id: 'root',
        transcript_path: parentPath
      }
    }
    const root = normalizeHookPayload(state, 'codex', rootBody, 'production')
    if (!root) {
      throw new Error('Root hook was rejected')
    }
    const childBody = {
      paneKey: PANE,
      payload: {
        hook_event_name: 'SubagentStart',
        agent_id: CHILD,
        session_id: CHILD,
        transcript_path: childPath
      }
    }
    return { state, root, childBody, childPath }
  }

  it('keeps a live hook-only child working, then settles without a SubagentStop hook', () => {
    const { state, childBody, childPath } = fixture(false)
    const started = normalizeHookPayload(state, 'codex', childBody, 'production')
    if (!started) {
      throw new Error('Child hook was rejected')
    }
    expect(started.payload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [{ id: CHILD, state: 'working' }]
    })
    expect(shouldPollHookTranscript(state, 'codex', started)).toBe(true)
    appendFileSync(childPath, line('task_complete'))
    const settled = pollCodexTranscriptStatus(state, started, childBody, 'production')
    expect(settled?.payload.state).toBe('done')
    expect(settled?.payload.subagents).toBeUndefined()
    if (!settled) {
      throw new Error('No completion status')
    }
    expect(shouldPollHookTranscript(state, 'codex', settled)).toBe(false)
  })

  it('does not resurrect a completed child when a delayed start hook arrives', () => {
    const { state, childBody } = fixture(true)
    const delayed = normalizeHookPayload(state, 'codex', childBody, 'production')
    expect(delayed?.payload.state).toBe('done')
    expect(delayed?.payload.subagents).toBeUndefined()
  })

  it('reconciles a child using the retained root path after clearing transcript state', () => {
    const { state, root, childBody } = fixture(true)
    seedLegacyAgentStatusForTests(state, root)
    state.codexSubagentTranscriptByPaneKey.clear()
    const delayed = normalizeHookPayload(state, 'codex', childBody, 'production')
    expect(delayed?.payload.state).toBe('done')
    expect(delayed?.payload.subagents).toBeUndefined()
    expect(state.codexSubagentTranscriptByPaneKey.get(PANE)?.parent.filePath).toBe(
      root.providerSession?.transcriptPath
    )
  })

  it('honors an explicit stop even before the child transcript has flushed its completion', () => {
    const { state, childBody } = fixture(false)
    normalizeHookPayload(state, 'codex', childBody, 'production')
    const stopped = normalizeHookPayload(
      state,
      'codex',
      { ...childBody, payload: { ...childBody.payload, hook_event_name: 'SubagentStop' } },
      'production'
    )
    expect(stopped?.payload.state).toBe('done')
    expect(stopped?.payload.subagents).toBeUndefined()
    if (!stopped) {
      throw new Error('Child stop was rejected')
    }
    expect(shouldPollHookTranscript(state, 'codex', stopped)).toBe(false)
  })
})
