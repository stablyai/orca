import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentSenderPublication } from '../../../../../shared/orchestration/mailbox/agent-sender-associations'
import { HostPartDraft } from './agent-sender-host-part'
import { readAgentSender } from './agent-sender-index'
import { agentSenderPublicationPatch } from './agent-sender-publication-patch'

// Perf contract (#43768): every delivery to one host re-merged every sender row of the host.

const FLEET_WORKTREES = 100

const publication = (
  revision: number,
  rows: AgentSenderPublication['associations']
): AgentSenderPublication => ({
  associations: rows,
  principals: [],
  attachments: [],
  revision: { epoch: 'e', revision }
})

const row = (worktree: number, generation = 0) => ({
  identity: `term_${worktree}_${generation}`,
  worktreeId: `w${worktree}`,
  paneKey: `tab-${worktree}:leaf`
})

const baseline = () => Array.from({ length: FLEET_WORKTREES }, (_, worktree) => row(worktree))

it('a repeated delivery joins no rows, and one scope change joins only that scope', () => {
  // Rows handed to the host's sender index, whether it edits the previous index or rebuilds it.
  const rows = vi.spyOn(HostPartDraft.prototype, 'rows')
  const joined = () =>
    rows.mock.calls.reduce((sum, [located]) => sum + located.associations.length, 0)
  let state: AppState = { ...useAppStore.getState(), agentSenderPublicationsByHost: {} }
  const deliver = (scope: string, delivery: AgentSenderPublication) => {
    state = { ...state, ...agentSenderPublicationPatch(state, 'local', scope, delivery) }
  }
  const sender = (identity: string) => readAgentSender(state, 'local', identity)?.paneKey

  // The local host's whole-host publication, plus one worktree's newer scope over it.
  deliver('*', publication(1, baseline()))
  // Scope revisions run ahead of the baseline's, so a repeated baseline keeps them.
  deliver('w7', publication(10, [row(7, 1)]))
  expect(sender(row(7, 1).identity)).toBe('tab-7:leaf')

  expect(joined()).toBe(101)
  const counts: Record<string, number> = {}
  let mark = joined()
  const step = (name: string) => {
    counts[name] = joined() - mark
    mark = joined()
  }

  deliver('*', publication(2, baseline()))
  expect(sender(row(3).identity)).toBe('tab-3:leaf')
  step('repeatedWholeHost')

  deliver('w7', publication(11, [row(7, 2)]))
  expect(sender(row(7, 2).identity)).toBe('tab-7:leaf')
  expect(sender(row(7, 1).identity)).toBeUndefined()
  step('scopeChange')

  deliver('w7', publication(12, [row(7, 2)]))
  expect(sender(row(7, 2).identity)).toBe('tab-7:leaf')
  step('repeatedScope')

  // A worktree's first scope over the baseline, and that scope going away again.
  deliver('w8', publication(20, [row(8, 1)]))
  expect(sender(row(8, 1).identity)).toBe('tab-8:leaf')
  expect(sender(row(8).identity)).toBeUndefined()
  step('scopeAppears')

  state = {
    ...state,
    ...agentSenderPublicationPatch(state, 'local', 'w8', undefined, true)
  }
  expect(sender(row(8).identity)).toBe('tab-8:leaf')
  step('scopeLeaves')

  expect(counts).toEqual({
    repeatedWholeHost: 0,
    scopeChange: 2,
    repeatedScope: 0,
    scopeAppears: 2,
    scopeLeaves: 2
  })
})
