import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createHookListenerState, seedLegacyAgentStatusForTests } from './listener-state'
import type { AgentHookEventPayload } from './listener-event'
import {
  createCodexSubagentTranscriptState,
  reconcileCodexSubagentTranscript
} from '../codex-subagent-transcript'
import { terminalUsageLimitGuard } from './terminal-usage-limit-guard'

it('requires an identified completed source root and rechecks its current native identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-quota-cut-'))
  try {
    const path = join(dir, 'rollout.jsonl')
    const line = (payload: unknown) => `${JSON.stringify({ type: 'event_msg', payload })}\n`
    writeFileSync(
      path,
      line({ type: 'task_started', turn_id: 'root' }) +
        line({
          type: 'task_complete',
          turn_id: 'root',
          error: { codex_error_info: 'usage_limit_exceeded' }
        })
    )
    const state = createHookListenerState()
    const transcript = createCodexSubagentTranscriptState()
    reconcileCodexSubagentTranscript(transcript, new Map(), path)
    state.codexSubagentTranscriptByPaneKey.set('pane', transcript)
    const cut = { sessionId: 'session', turnEndedAt: 100 }
    const row: AgentHookEventPayload = {
      paneKey: 'pane',
      connectionId: null,
      source: 'codex',
      providerSession: { id: 'session', key: 'session_id', transcriptPath: path },
      turnEndedAt: 100,
      turnEndDisposition: 'identified',
      hostTurn: {
        owner: 'codex:session',
        currentTurnKey: 'turn:root',
        completed: { turnKey: 'turn:root', endedAt: 100 }
      },
      payload: {
        state: 'done',
        prompt: 'Finish',
        agentType: 'codex',
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1, usageLimit: {} }
      }
    }
    const seed = (next: AgentHookEventPayload) => seedLegacyAgentStatusForTests(state, next)
    seed(row)
    const guard = terminalUsageLimitGuard(state, 'pane', cut)!
    expect(guard()).toBe(true)
    for (const next of [
      { ...row, turnEndDisposition: 'ambiguous' as const },
      { ...row, payload: { ...row.payload, state: 'working' as const } },
      { ...row, hostTurn: { ...row.hostTurn!, currentTurnKey: 'turn:new' } },
      { ...row, hostTurn: { ...row.hostTurn!, completed: { turnKey: 'turn:other', endedAt: 100 } } }
    ]) {
      seed(next)
      expect(terminalUsageLimitGuard(state, 'pane', cut)).toBeNull()
      expect(guard()).toBe(false)
    }
    seed(row)
    expect(guard()).toBe(true)
    appendFileSync(path, line({ type: 'task_started', turn_id: 'native-new-root' }))
    expect(guard()).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
