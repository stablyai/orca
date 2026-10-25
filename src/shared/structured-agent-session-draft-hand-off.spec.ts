// Match queued drafts through queuedMessageId, never by comparing draft and submission IDs.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'

function handOff(
  dispatchState: AgentJournalSubmission['dispatchState'],
  queuedMessageId?: string
): AgentJournalSubmission {
  return {
    clientMessageId: 'hand-off',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: dispatchState === 'rejected' ? 'refused' : null,
    submittedAt: 10,
    resolvedAt: null,
    ...(queuedMessageId !== undefined ? { queuedMessageId } : {})
  }
}

describe('a queued draft handed off under a fresh submission id', () => {
  it('is handed off in every dispatch state', () => {
    for (const state of ['pending', 'accepted', 'rejected', 'unknown'] as const) {
      expect(handedOffQueuedMessageIds([handOff(state, 'draft')])).toEqual(new Set(['draft']))
    }
  })

  it('is never matched by the submission id itself', () => {
    const ids = handedOffQueuedMessageIds([handOff('pending', 'draft'), handOff('accepted')])
    expect(ids.has('hand-off')).toBe(false)
    expect([...ids]).toEqual(['draft'])
  })
})
