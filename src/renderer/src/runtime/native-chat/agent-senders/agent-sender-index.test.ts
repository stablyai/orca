import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentSenderPublication } from '../../../../../shared/orchestration/mailbox/agent-sender-associations'
import { readAgentSender } from './agent-sender-index'
import { agentSenderPublicationPatch } from './agent-sender-publication-patch'

const publication = (
  revision: number,
  rows: AgentSenderPublication['associations']
): AgentSenderPublication => ({
  associations: rows,
  principals: [],
  attachments: [],
  revision: { epoch: 'e', revision }
})

it('keeps sender state when a newer delivery repeats a scope, and still applies a real change', () => {
  let state: AppState = {
    ...useAppStore.getState(),
    agentSenderPublicationsByHost: {
      local: {
        '*': publication(1, [{ identity: 'term_9', worktreeId: 'w9', paneKey: 'tab-9:leaf' }])
      }
    }
  }
  const deliver = (scope: string, delivery: AgentSenderPublication) => {
    state = { ...state, ...agentSenderPublicationPatch(state, 'local', scope, delivery) }
  }
  // A host can hand one empty scope object to several worktrees in one reply.
  const empty = publication(5, [])
  deliver('w1', empty)
  deliver('w2', empty)
  const publications = state.agentSenderPublicationsByHost

  deliver('w1', publication(9, []))
  expect(state.agentSenderPublicationsByHost).toBe(publications)
  expect(readAgentSender(state, 'local', 'term_9')?.paneKey).toBe('tab-9:leaf')

  deliver('w2', publication(6, [{ identity: 'term_2', worktreeId: 'w2', paneKey: 'tab-2:leaf' }]))
  expect(readAgentSender(state, 'local', 'term_2')?.paneKey).toBe('tab-2:leaf')

  // Older than what w1 already applied: ignored.
  deliver('w1', publication(8, [{ identity: 'term_1', worktreeId: 'w1', paneKey: 'tab-1:leaf' }]))
  expect(readAgentSender(state, 'local', 'term_1')).toBeUndefined()
})
