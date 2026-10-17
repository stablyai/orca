import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildAttentionWorkspaceIds, type AttentionWorkspaceState } from './attention-workspaces'
import { repo, worktree } from './worktree-list-groups-test-fixtures'

const NOW = 1_700_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const LOCAL_TWIN: Worktree = { ...worktree, hostId: 'local' }
const REMOTE_TWIN: Worktree = { ...worktree, hostId: 'ssh:box' }

function terminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: worktree.id,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function unifiedTab(id: string, executionHostId?: ExecutionHostId): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId: worktree.id,
    contentType: 'terminal',
    label: 'shell',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW,
    ...(executionHostId ? { executionHostId } : {})
  }
}

function waiting(tabId: string): AgentStatusEntry {
  const paneKey = makePaneKey(tabId, LEAF)
  return {
    paneKey,
    tabId,
    state: 'waiting',
    prompt: 'approve?',
    updatedAt: NOW,
    stateStartedAt: NOW - 1_000,
    stateHistory: [],
    agentType: 'claude'
  }
}

function twinState(overrides: Partial<AttentionWorkspaceState> = {}): AttentionWorkspaceState {
  return {
    agentStatusByPaneKey: { [makePaneKey('remote-tab', LEAF)]: waiting('remote-tab') },
    migrationUnsupportedByPtyId: {},
    folderWorkspaces: [],
    tabsByWorktree: { [worktree.id]: [terminalTab('local-tab'), terminalTab('remote-tab')] },
    ptyIdsByTabId: { 'local-tab': ['pty-local-tab'], 'remote-tab': ['pty-remote-tab'] },
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {
      [worktree.id]: [unifiedTab('local-tab', 'local'), unifiedTab('remote-tab', 'ssh:box')]
    },
    worktreesByRepo: { [repo.id]: [LOCAL_TWIN, REMOTE_TWIN] },
    ...overrides
  }
}

describe('buildAttentionWorkspaceIds host ownership', () => {
  it('lights only the twin whose tab waits when one repo is on two hosts', () => {
    const ids = buildAttentionWorkspaceIds(twinState(), NOW)

    expect([...ids]).toEqual([composeWorktreeHostIdentity('ssh:box', worktree.id)])
  })

  it('lights neither twin when the waiting tab carries no host', () => {
    const ids = buildAttentionWorkspaceIds(
      twinState({
        unifiedTabsByWorktree: {
          [worktree.id]: [unifiedTab('local-tab', 'local'), unifiedTab('remote-tab')]
        }
      }),
      NOW
    )

    expect([...ids]).toEqual([])
  })

  it('keys a lone worktree by its identity even without a host stamp on the tab', () => {
    const ids = buildAttentionWorkspaceIds(
      twinState({
        unifiedTabsByWorktree: { [worktree.id]: [unifiedTab('remote-tab')] },
        worktreesByRepo: { [repo.id]: [REMOTE_TWIN] }
      }),
      NOW
    )

    expect([...ids]).toEqual([composeWorktreeHostIdentity('ssh:box', worktree.id)])
  })
})
