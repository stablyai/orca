import {
  makeFacets,
  makeFacetCandidate
} from '@/components/workspace-cleanup/query/workspace-cleanup-facet.test.fixture'
import { expect, it } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/testing/terminal-tab.test-fixture'
import { makeUnifiedTab } from '../tabs/tab-group.test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import { makeCandidate, WORKTREE_ID } from './workspace-cleanup-slice-test-harness'
import { getWorkspaceCleanupAgentEvidence } from './workspace-cleanup-agent-evidence'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { matchesWorkspaceCleanupAgent } from '@/components/workspace-cleanup/query/workspace-cleanup-facet-matchers'

it('counts current Done agents only for their workspace host', () => {
  const store = createTestStore()
  const tab = makeTab({ id: 'done-tab', worktreeId: WORKTREE_ID, ptyId: null })
  store.setState({
    tabsByWorktree: { [WORKTREE_ID]: [tab] },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        makeUnifiedTab({
          id: tab.id,
          worktreeId: WORKTREE_ID,
          groupId: 'g',
          executionHostId: 'ssh:a'
        })
      ]
    },
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'ssh:a' }),
        makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'ssh:b' })
      ]
    },
    agentStatusByPaneKey: {
      'done-tab:0': {
        paneKey: 'done-tab:0',
        tabId: tab.id,
        worktreeId: WORKTREE_ID,
        state: 'done',
        prompt: 'finished task',
        agentType: 'claude',
        updatedAt: 1000,
        stateStartedAt: 1000,
        stateHistory: [],
        connectionId: 'a'
      }
    }
  })
  const a = makeCandidate({ executionHostId: 'ssh:a', connectionId: 'a' })
  const b = makeCandidate({ executionHostId: 'ssh:b', connectionId: 'b' })
  const evidence = getWorkspaceCleanupAgentEvidence(store.getState(), [a, b])
  expect(evidence.get(getWorkspaceCleanupCandidateIdentity(a))).toEqual({ finishedAgentCount: 1 })
  expect(evidence.get(getWorkspaceCleanupCandidateIdentity(b))).toEqual({ finishedAgentCount: 0 })
  store.setState({
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {
      'done-tab:0': {
        paneKey: 'done-tab:0',
        tabId: tab.id,
        worktreeId: WORKTREE_ID,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sleep-session' },
        prompt: 'finished task',
        state: 'done',
        capturedAt: 2000,
        updatedAt: 1000,
        connectionId: 'a',
        origin: 'worktree-sleep'
      }
    }
  })
  expect(
    getWorkspaceCleanupAgentEvidence(store.getState(), [a]).get(
      getWorkspaceCleanupCandidateIdentity(a)
    )
  ).toEqual({ finishedAgentCount: 0 })
})

it('does not treat an old retained-row count as proof that a workspace has finished agents', () => {
  const candidate = makeFacetCandidate()
  const facets = makeFacets({
    candidate: {
      localContext: {
        ...candidate.localContext,
        finishedAgentCount: undefined,
        retainedDoneAgentCount: 2
      }
    }
  })
  expect(matchesWorkspaceCleanupAgent(facets, { states: [], retainedDoneAgents: 'only' })).toBe(
    false
  )
  expect(matchesWorkspaceCleanupAgent(facets, { states: [], retainedDoneAgents: 'exclude' })).toBe(
    false
  )
  expect(matchesWorkspaceCleanupAgent(facets, { states: [], retainedDoneAgents: 'any' })).toBe(true)
})
