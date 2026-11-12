import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../shared/worktree/types'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { Store } from '../../../main/persistence/loading-store/store'
import {
  listWslStoppedWorktrees,
  wslDistroNotRunningForScanFailure
} from '../../../main/ipc/worktrees/listing/wsl-stopped-worktree-listing'
import { WslDistroStoppedError } from '../../../main/wsl/filesystem/wsl-unc-access-gate'

export function stoppedWorkspaceListing(repo: Repo, rows: Worktree[]): DetectedWorktreeListResult {
  const meta: Record<string, WorktreeMeta> = Object.fromEntries(rows.map((row) => [row.id, row]))
  const store: Partial<Store> = {
    getRepos: () => [repo],
    getSettings: () => getDefaultSettings('/qa'),
    getProjectHostSetups: () => [],
    getAllWorktreeMeta: () => meta,
    getWorktreeMetaForHost: (id: string) => meta[id],
    getAllWorktreeMetaForHost: () => meta,
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    setWorktreeMeta: (target: HostWorktreeTarget, updates: Partial<WorktreeMeta>) =>
      (meta[target.id] = { ...meta[target.id], ...updates })
  }
  return {
    repoId: repo.id,
    authoritative: false,
    source: 'metadata-fallback',
    wslDistroStopped:
      wslDistroNotRunningForScanFailure(new WslDistroStoppedError('orca-qa')) ?? undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stopped listing only reads these validated metadata/ownership methods; no persistence or process method is reachable.
    worktrees: listWslStoppedWorktrees(store as Store, repo, meta)
  }
}

export function savedBareWorkspaceSession(worktreeId: string): WorkspaceSessionState {
  const tab = {
    worktreeId,
    groupId: 'original-group',
    executionHostId: 'local' as const,
    customLabel: null,
    color: null,
    createdAt: 1
  }
  const browser = {
    worktreeId,
    url: 'https://example.test/saved',
    title: 'Saved browser',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo1',
    activeWorktreeId: worktreeId,
    activeWorkspaceExecutionHostId: 'local',
    activeTabId: 'old-shell',
    activeTabIdByWorktree: { [worktreeId]: 'old-shell' },
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: 'old-shell',
          worktreeId,
          title: 'Saved shell',
          ptyId: null,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabs: {
      [worktreeId]: [
        {
          ...tab,
          id: 'shell-tab',
          entityId: 'old-shell',
          contentType: 'terminal',
          label: 'Saved shell',
          sortOrder: 0
        },
        {
          ...tab,
          id: 'chat-tab',
          entityId: 'old-chat',
          contentType: 'agent-session',
          agentSessionAgent: 'claude',
          label: 'Saved conversation',
          sortOrder: 1
        },
        {
          ...tab,
          id: 'browser-tab',
          entityId: 'old-browser',
          contentType: 'browser',
          label: 'Saved browser',
          sortOrder: 2
        },
        {
          ...tab,
          id: 'editor-tab',
          entityId: '/repo/.bare/readme.md',
          contentType: 'editor',
          label: 'readme.md',
          sortOrder: 3
        }
      ]
    },
    tabGroups: {
      [worktreeId]: [
        {
          id: 'original-group',
          worktreeId,
          activeTabId: 'shell-tab',
          tabOrder: ['shell-tab', 'chat-tab', 'browser-tab', 'editor-tab']
        }
      ]
    },
    openFilesByWorktree: {
      [worktreeId]: [
        {
          worktreeId,
          filePath: '/repo/.bare/readme.md',
          relativePath: 'readme.md',
          language: 'markdown'
        }
      ]
    },
    browserTabsByWorktree: {
      [worktreeId]: [
        { ...browser, id: 'old-browser', activePageId: 'old-page', pageIds: ['old-page'] }
      ]
    },
    browserPagesByWorkspace: {
      'old-browser': [{ ...browser, id: 'old-page', workspaceId: 'old-browser' }]
    }
  }
}
