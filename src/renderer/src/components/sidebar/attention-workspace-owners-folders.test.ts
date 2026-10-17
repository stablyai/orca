import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../../../../shared/folder-workspace-worktree'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildAttentionWorkspaceIds, type AttentionWorkspaceState } from './attention-workspaces'
import { repo, worktree } from './worktree-list-groups-test-fixtures'

const NOW = 1_700_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const FOLDER_KEY = folderWorkspaceKey('shared-folder')

function folder(executionHostId: ExecutionHostId): FolderWorkspace {
  return {
    id: 'shared-folder',
    projectGroupId: 'group-1',
    name: 'Notes',
    folderPath: '/notes',
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  }
}

function terminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function unifiedTab(id: string, worktreeId: string, executionHostId: ExecutionHostId): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId,
    contentType: 'terminal',
    label: 'shell',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW,
    executionHostId
  }
}

function waiting(tabId: string): AgentStatusEntry {
  return {
    paneKey: makePaneKey(tabId, LEAF),
    tabId,
    state: 'waiting',
    prompt: 'approve?',
    updatedAt: NOW,
    stateStartedAt: NOW - 1_000,
    stateHistory: [],
    agentType: 'claude'
  }
}

function state(overrides: Partial<AttentionWorkspaceState>): AttentionWorkspaceState {
  return {
    agentStatusByPaneKey: { [makePaneKey('tab', LEAF)]: waiting('tab') },
    migrationUnsupportedByPtyId: {},
    folderWorkspaces: [],
    tabsByWorktree: {},
    ptyIdsByTabId: { tab: ['pty-tab'] },
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    worktreesByRepo: {},
    ...overrides
  }
}

describe('buildAttentionWorkspaceIds owners beyond repo twins', () => {
  it('lights only the host of a folder workspace whose id exists on two hosts', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        folderWorkspaces: [folder('local'), folder('ssh:box')],
        tabsByWorktree: { [FOLDER_KEY]: [terminalTab('tab', FOLDER_KEY)] },
        unifiedTabsByWorktree: { [FOLDER_KEY]: [unifiedTab('tab', FOLDER_KEY, 'ssh:box')] }
      }),
      NOW
    )

    expect([...ids]).toEqual([getFolderWorkspaceHostIdentity(folder('ssh:box'))])
  })

  it('still lights a lone SSH worktree whose legacy tab is stamped local', () => {
    const remote = { ...worktree, hostId: 'ssh:box' as const }
    const ids = buildAttentionWorkspaceIds(
      state({
        tabsByWorktree: { [worktree.id]: [terminalTab('tab', worktree.id)] },
        unifiedTabsByWorktree: { [worktree.id]: [unifiedTab('tab', worktree.id, 'local')] },
        worktreesByRepo: { [repo.id]: [remote] }
      }),
      NOW
    )

    expect([...ids]).toEqual([composeWorktreeHostIdentity('ssh:box', worktree.id)])
  })
})
