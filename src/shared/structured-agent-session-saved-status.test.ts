import { describe, expect, it } from 'vitest'
import type {
  AgentJournalDispatchState,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { projectStructuredAgentSessionStatusSummary } from './structured-agent-session-projection'
import {
  isSavableStructuredAgentSessionProjection,
  parseStructuredAgentSessionSavedProjection,
  STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION
} from './structured-agent-session-saved-status'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence * 1_000, body }
}

function submission(
  clientMessageId: string,
  fence: number,
  dispatchState: AgentJournalDispatchState
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence,
    payloadFingerprint: clientMessageId,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: fence * 1_000,
    resolvedAt: dispatchState === 'pending' ? null : fence * 1_000 + 1
  }
}

const settledTurn: AgentJournalRenderItem[] = [
  item('user-1', 1, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Fix it' }] }),
  item('turn-1', 2, {
    kind: 'turn',
    turnId: 'turn-1',
    state: 'completed',
    startedAt: 2_000,
    completedAt: 5_000
  }),
  item('reply-1', 3, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Fixed.' }]
  })
]

describe('saved chat status', () => {
  // A saved copy is trusted across builds only while this output is unchanged. If this fails,
  // bump STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION, then update the snapshot (C14).
  it('pins what a settled chat projects under the current projection version', () => {
    expect({
      version: STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION,
      projection: projectStructuredAgentSessionStatusSummary(settledTurn)
    }).toMatchInlineSnapshot(`
      {
        "projection": {
          "lastAssistantMessage": "Fixed.",
          "latestPrompt": "Fix it",
          "status": "idle",
          "statusStartedAt": 5000,
        },
        "version": 1,
      }
    `)
  })

  // What makes a saved copy fence-free: a settled projection can only stay settled as the fence
  // rises, because a higher fence only stops older sends from counting (C9).
  it('keeps every idle or no-turn projection unchanged as the fence rises', () => {
    const states: AgentJournalDispatchState[] = ['pending', 'accepted', 'rejected', 'unknown']
    const histories: AgentJournalRenderItem[][] = [[], settledTurn]
    let checked = 0
    for (const items of histories) {
      for (const first of states) {
        for (const second of states) {
          for (const firstFence of [1, 2, 3]) {
            const submissions = [
              submission('send-1', firstFence, first),
              submission('send-2', 1, second)
            ]
            for (const fence of [1, 2, 3]) {
              const settled = projectStructuredAgentSessionStatusSummary(items, submissions, fence)
              if (!isSavableStructuredAgentSessionProjection(settled)) {
                continue
              }
              checked += 1
              for (const later of [fence + 1, fence + 5]) {
                expect(
                  projectStructuredAgentSessionStatusSummary(items, submissions, later)
                ).toEqual(settled)
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('round-trips a settled projection and refuses anything a saved copy never holds', () => {
    const settled = projectStructuredAgentSessionStatusSummary(settledTurn)
    expect(parseStructuredAgentSessionSavedProjection(JSON.stringify(settled))).toEqual(settled)
    expect(
      parseStructuredAgentSessionSavedProjection(JSON.stringify({ status: null, latestPrompt: '' }))
    ).toEqual({ status: null, latestPrompt: '' })
    for (const unsaved of [
      { ...settled, status: 'working' },
      { ...settled, toolName: 'Read' },
      { ...settled, turnOutcome: 'not-an-outcome' },
      { status: 'idle' }
    ]) {
      expect(parseStructuredAgentSessionSavedProjection(JSON.stringify(unsaved))).toBeNull()
    }
    expect(parseStructuredAgentSessionSavedProjection('{not json')).toBeNull()
  })
})
