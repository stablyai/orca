import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeAndAccept, PANE_KEY } from '../../agent-hook-listener-test-harness'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from '../listener-state'
import { pollCodexTranscriptStatus } from './codex-transcript-poll'
import { transcriptPollUpdate } from '../transcript-poll-policy'

describe('Codex compaction status', () => {
  let state: HookListenerState
  let directory: string
  let transcriptPath: string

  beforeEach(() => {
    state = createHookListenerState()
    directory = mkdtempSync(join(tmpdir(), 'codex-compaction-'))
    transcriptPath = join(directory, 'rollout.jsonl')
    writeFileSync(transcriptPath, event('task_started'))
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function event(type: string): string {
    return `${JSON.stringify({ type: 'event_msg', payload: { type, turn_id: 'turn-1' } })}\n`
  }

  function hook(payload: Record<string, unknown>) {
    return normalizeAndAccept(state, 'codex', {
      session_id: 'session-1',
      transcript_path: transcriptPath,
      ...payload
    })
  }

  it.each([undefined, 'turn-1'])(
    'keeps a finished turn done when compact carries turn %s',
    (turnId) => {
      hook({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'Do work' })
      appendFileSync(transcriptPath, event('task_complete'))
      const done = hook({ hook_event_name: 'Stop', turn_id: 'turn-1' })

      expect(
        hook({ hook_event_name: 'SessionStart', source: 'compact', turn_id: turnId })
      ).toBeNull()
      expect(state.lastStatusByPaneKey.get(PANE_KEY)).toBe(done)
      expect(state.codexLeadStateByPaneKey.get(PANE_KEY)).toMatchObject({
        state: 'done',
        turnId: 'turn-1'
      })

      expect(
        hook({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2', prompt: 'Next' })?.payload
      ).toMatchObject({ state: 'working', prompt: 'Next' })
    }
  )

  it('keeps a compacted parent and live child until their own completions', () => {
    hook({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'Do work' })
    const original = hook({ hook_event_name: 'SubagentStart', agent_id: 'child-1' })
    if (!original) {
      throw new Error('Expected a working status')
    }
    const lead = state.codexLeadStateByPaneKey.get(PANE_KEY)
    const transcript = state.codexSubagentTranscriptByPaneKey.get(PANE_KEY)
    const roster = state.codexSubagentRosterByPaneKey.get(PANE_KEY)

    expect(hook({ hook_event_name: 'SessionStart', source: 'compact' })).toBeNull()
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)).toBe(lead)
    expect(state.codexSubagentTranscriptByPaneKey.get(PANE_KEY)).toBe(transcript)
    expect(state.codexSubagentRosterByPaneKey.get(PANE_KEY)).toBe(roster)
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'child-1', state: 'working' })
    ])

    appendFileSync(transcriptPath, event('task_complete'))
    const polled = pollCodexTranscriptStatus(state, original, { paneKey: PANE_KEY }, 'production')
    if (!polled) {
      throw new Error('Expected transcript completion')
    }
    expect(transcriptPollUpdate('codex', original, polled)).toMatchObject({
      hookEventName: 'Stop',
      payload: {
        state: 'working',
        prompt: 'Do work',
        mainAgent: { state: 'done' },
        subagents: [{ id: 'child-1', state: 'working' }]
      }
    })
    seedLegacyAgentStatusForTests(state, polled)
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)).toMatchObject({
      state: 'done',
      turnId: 'turn-1'
    })
    const stopped = hook({ hook_event_name: 'SubagentStop', agent_id: 'child-1' })
    expect(stopped?.payload).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    expect(stopped?.payload.subagents).toBeUndefined()
    expect(
      hook({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2', prompt: 'Next' })?.payload
    ).toMatchObject({ state: 'working', prompt: 'Next', mainAgent: { state: 'working' } })
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)?.turnId).toBe('turn-2')
  })

  it('preserves a pending human question across compaction', () => {
    hook({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'Do work' })
    const waiting = hook({
      hook_event_name: 'PreToolUse',
      turn_id: 'turn-1',
      tool_name: 'request_user_input',
      tool_input: { questions: [{ id: 'choice', question: 'Which option?' }] }
    })
    expect(waiting?.payload.state).toBe('waiting')
    expect(hook({ hook_event_name: 'SessionStart', source: 'compact' })).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toBe(waiting)
  })
})
