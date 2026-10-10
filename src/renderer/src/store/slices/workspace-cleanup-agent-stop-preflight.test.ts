import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupHostIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { withWorkspaceCleanupAgentStopApproval } from '@/components/workspace-cleanup/workspace-cleanup-agent-stop-approval'
import { makeTab } from './store-test-helpers'
import { enrichWorkspaceCleanupCandidates } from './workspace-cleanup-candidate-enrichment'
import { findWorkspaceCleanupLiveAgentWorktreeIds } from './workspace-cleanup-local-evidence'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate,
  makeState
} from './workspace-cleanup-slice-test-harness'

const OTHER_ID = 'repo1::/tmp/other'

function paneKey(tabId: string): string {
  return makePaneKey(tabId, '11111111-1111-4111-8111-111111111111')
}

function agentStatus(paneKey: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  const updatedAt = Date.now()
  return { paneKey, state, prompt: '', updatedAt, stateStartedAt: updatedAt, stateHistory: [] }
}

// A structured chat publishes status under its own surface id; its tab is not in tabsByWorktree.
function structuredChatStatus(state: AgentStatusEntry['state']): AgentStatusEntry {
  return { ...agentStatus(paneKey('chat-1'), state), worktreeId: WORKTREE_ID }
}

function liveAgentState(): Partial<AppState> {
  return {
    tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: 'tab-1', worktreeId: WORKTREE_ID })] },
    agentStatusByPaneKey: { [paneKey('tab-1')]: agentStatus(paneKey('tab-1'), 'working') }
  }
}

describe('workspace cleanup live-agent finder', () => {
  it('finds only workspaces whose agent is working right now', () => {
    const state = makeState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTab({ id: 'tab-1', worktreeId: WORKTREE_ID })],
        [OTHER_ID]: [makeTab({ id: 'tab-2', worktreeId: OTHER_ID })]
      },
      agentStatusByPaneKey: {
        [paneKey('tab-1')]: agentStatus(paneKey('tab-1'), 'working'),
        [paneKey('tab-2')]: agentStatus(paneKey('tab-2'), 'done')
      }
    })

    expect([...findWorkspaceCleanupLiveAgentWorktreeIds(state, [WORKTREE_ID, OTHER_ID])]).toEqual([
      WORKTREE_ID
    ])
  })

  it.each([
    ['working', true],
    ['done', false]
  ] as const)('counts a %s structured chat with no terminal tab: %s', async (state, live) => {
    const appState = makeState({
      agentStatusByPaneKey: { [paneKey('chat-1')]: structuredChatStatus(state) }
    })

    expect(findWorkspaceCleanupLiveAgentWorktreeIds(appState, [WORKTREE_ID]).has(WORKTREE_ID)).toBe(
      live
    )
    const [enriched] = await enrichWorkspaceCleanupCandidates([makeCandidate()], appState)
    expect(enriched.blockers.includes('live-agent')).toBe(live)
  })
})

describe('workspace cleanup removal of a workspace with a live agent', () => {
  async function removeWith(approvedAgentStop: boolean) {
    const fresh = makeCandidate()
    installWorkspaceCleanupApi(
      vi.fn().mockResolvedValue({
        scannedAt: NOW,
        candidates: [fresh],
        errors: []
      } satisfies WorkspaceCleanupScanResult)
    )
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    store.setState(liveAgentState())
    const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [withWorkspaceCleanupAgentStopApproval(fresh, approvedAgentStop)]
    })
    return { result, removeWorktree }
  }

  it('refuses the row when an agent started after the user confirmed', async () => {
    const { result, removeWorktree } = await removeWith(false)

    expect(result.failures).toEqual([
      {
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        displayName: 'old-workspace',
        message:
          'An agent started in this workspace after you confirmed. Delete it again to review stopping the agent.'
      }
    ])
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('removes the row when the user approved stopping its agent', async () => {
    const { result, removeWorktree } = await removeWith(true)

    expect(result.failures).toEqual([])
    expect(result.removedIdentities).toEqual([
      getWorkspaceCleanupHostIdentity('local', WORKTREE_ID)
    ])
    expect(removeWorktree).toHaveBeenCalledTimes(1)
  })
})
