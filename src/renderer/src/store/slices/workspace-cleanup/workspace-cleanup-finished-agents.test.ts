import { displayOnlyPaneSleepFromEntry } from '../../../../../shared/agent-session/lifecycle/pane-sleep-agent-status'
import { selectPlacedAgentStatusEntriesForWorktree } from '@/components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import { createStoreCascadesMockApi } from '../../testing/app-store-cascade-api.test-fixture'
import { expect, it, vi } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '../tabs/tab-group.test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import { makeCandidate, WORKTREE_ID } from './workspace-cleanup-slice-test-harness'
import { getWorkspaceCleanupAgentEvidence } from './workspace-cleanup-agent-evidence'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import {
  makeFacets,
  makeFacetCandidate
} from '@/components/workspace-cleanup/workspace-cleanup-facet.test.fixture'
import { matchesWorkspaceCleanupAgent } from '@/components/workspace-cleanup/workspace-cleanup-facet-matchers'

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
  store.setState({ agentStatusByPaneKey: {} })
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

it.each([
  { host: 'local', connectionId: null },
  { host: 'ssh:a', connectionId: 'a' }
] as const)(
  'counts a slept Done on $host until the real tab-close action retires it',
  ({ host, connectionId }) => {
    const store = createTestStore()
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `slept-tab:${leafId}`
    const tab = makeTab({ id: 'slept-tab', worktreeId: WORKTREE_ID, ptyId: null })
    store.setState({
      tabsByWorktree: { [WORKTREE_ID]: [tab] },
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          makeUnifiedTab({
            id: tab.id,
            worktreeId: WORKTREE_ID,
            groupId: 'g',
            executionHostId: host
          })
        ]
      },
      terminalLayoutsByTabId: {
        [tab.id]: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: host })]
      },
      sshConnectionStates: new Map([
        ['a', { status: 'connected', targetId: 'a', error: null, reconnectAttempt: 0 }]
      ]),
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: displayOnlyPaneSleepFromEntry(
          {
            paneKey,
            tabId: tab.id,
            worktreeId: WORKTREE_ID,
            connectionId,
            state: 'done',
            agentType: 'custom-cli',
            prompt: 'finished task',
            updatedAt: 1000,
            stateStartedAt: 1000,
            stateHistory: []
          },
          WORKTREE_ID,
          2000
        )
      }
    })
    const candidate = makeCandidate({ executionHostId: host, connectionId })
    const other = makeCandidate({ executionHostId: 'ssh:b', connectionId: 'b' })
    const count = () => getWorkspaceCleanupAgentEvidence(store.getState(), [candidate, other])
    expect(
      selectPlacedAgentStatusEntriesForWorktree(store.getState(), WORKTREE_ID).map(
        (entry) => entry.state
      )
    ).toEqual(['done'])
    expect(count().get(getWorkspaceCleanupCandidateIdentity(candidate))).toEqual({
      finishedAgentCount: 1
    })
    expect(count().get(getWorkspaceCleanupCandidateIdentity(other))).toEqual({
      finishedAgentCount: 0
    })
    store.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [tab, makeTab({ id: 'sibling-tab', worktreeId: WORKTREE_ID })]
      }
    })
    vi.stubGlobal('window', { api: createStoreCascadesMockApi() })
    try {
      store
        .getState()
        .closeTab(tab.id, { captureRecentlyClosed: false, remoteCloseOwnedByHost: true })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().tabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'sibling-tab'
    ])
    expect(selectPlacedAgentStatusEntriesForWorktree(store.getState(), WORKTREE_ID)).toEqual([])
    expect(count().get(getWorkspaceCleanupCandidateIdentity(candidate))).toEqual({
      finishedAgentCount: 0
    })
  }
)
