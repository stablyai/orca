import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { agentSessionRewindTargetIds } from './agent-session-rewind-targets'

it('offers accepted provider turn openers while excluding steers and unconfirmed inputs', () => {
  const root = 'legacy:trae:session:turn-lifecycle%3Ap%3Athread%3Aturn'
  const pendingRoot = 'legacy:trae:session:turn-lifecycle%3Ap%3Athread%3Apending'
  const unknownRoot = 'legacy:trae:session:turn-lifecycle%3Ap%3Athread%3Aunknown'
  const message = (id: string, sequence: number, turnItemId?: string): AgentJournalRenderItem => ({
    itemId: `orca:${id}`,
    sequence,
    revision: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'user', blocks: [] },
    turnScope: turnItemId ? { kind: 'turn', turnItemId } : { kind: 'thread' }
  })
  const submission = (
    id: string,
    dispatchState: AgentJournalSubmission['dispatchState']
  ): AgentJournalSubmission => ({
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState,
    providerItemId: dispatchState === 'accepted' ? `orca:${id}` : null,
    reason: null,
    submittedAt: 1,
    resolvedAt: dispatchState === 'pending' ? null : 2
  })
  const items: AgentJournalRenderItem[] = [
    message('accepted', 1, root),
    {
      itemId: root,
      sequence: 2,
      revision: 1,
      observedAt: 1,
      body: {
        kind: 'turn',
        turnId: 'p:thread:turn',
        userItemId: 'orca:accepted',
        state: 'completed'
      },
      turnScope: { kind: 'thread' }
    },
    message('steer', 3, root),
    message('pending', 4, pendingRoot),
    {
      itemId: pendingRoot,
      sequence: 5,
      revision: 1,
      observedAt: 1,
      body: {
        kind: 'turn',
        turnId: 'p:thread:pending',
        userItemId: 'orca:pending',
        state: 'running'
      },
      turnScope: { kind: 'thread' }
    },
    message('unknown', 6, unknownRoot),
    {
      itemId: unknownRoot,
      sequence: 7,
      revision: 1,
      observedAt: 1,
      body: {
        kind: 'turn',
        turnId: 'p:thread:unknown',
        userItemId: 'orca:unknown',
        state: 'completed'
      },
      turnScope: { kind: 'thread' }
    },
    message('unjoined', 8)
  ]
  const targets = agentSessionRewindTargetIds(
    {
      items,
      submissions: [
        submission('accepted', 'accepted'),
        submission('steer', 'accepted'),
        submission('pending', 'pending'),
        submission('unknown', 'unknown'),
        submission('unjoined', 'accepted')
      ]
    },
    0
  )
  expect([...targets]).toEqual(['orca:accepted'])
})
