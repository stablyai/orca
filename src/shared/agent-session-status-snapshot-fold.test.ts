import { expect, it } from 'vitest'
import type { AgentSessionStatusSummary } from './agent-session-wire'
import {
  foldAgentSessionStatusEvent,
  revokeAgentSessionStatusLive
} from './agent-session-status-snapshot-fold'

const summary: AgentSessionStatusSummary = {
  sessionId: 'a',
  workspaceId: 'folder',
  agent: 'codex',
  status: 'idle',
  latestPrompt: 'Continue',
  updatedAt: 1
}

it.each(['queued', 'starting', 'continued', 'refused', 'unconfirmed', 'skipped'] as const)(
  'folds %s progress and revokes it on contact loss, even without a provider child',
  (phase) => {
    const snapshot = foldAgentSessionStatusEvent(new Map(), {
      type: 'snapshot',
      sessions: [{ ...summary, restartResume: { phase } }]
    })
    expect(snapshot.get('a')?.restartResume?.phase).toBe(phase)
    const disconnected = revokeAgentSessionStatusLive(snapshot)
    expect(disconnected.get('a')).toEqual(summary)
    expect(revokeAgentSessionStatusLive(disconnected)).toBe(disconnected)
  }
)

it('a clearing frame removes progress rather than merging the previous optional field', () => {
  const snapshot = new Map([['a', { ...summary, restartResume: { phase: 'continued' as const } }]])
  expect(
    foldAgentSessionStatusEvent(snapshot, { type: 'status', session: summary }).get('a')
  ).toEqual(summary)
})
