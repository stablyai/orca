import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { AppState } from '../types'

export function folderWorkspaceRemovalSessionState(
  folderWorkspace: FolderWorkspace
): Partial<AppState> {
  const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
  return {
    folderWorkspaces: [folderWorkspace],
    activeWorktreeId: workspaceKey,
    activeWorkspaceKey: workspaceKey,
    activeTabId: 'terminal-tab-1',
    activeBrowserTabId: 'browser-tab-1',
    activeTabType: 'browser',
    tabsByWorktree: {
      [workspaceKey]: [
        {
          id: 'terminal-tab-1',
          worktreeId: workspaceKey,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: 'pty-1'
        }
      ]
    },
    terminalLayoutsByTabId: {
      'terminal-tab-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    },
    browserTabsByWorktree: {
      [workspaceKey]: [
        {
          id: 'browser-tab-1',
          worktreeId: workspaceKey,
          url: 'https://example.com',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    browserPagesByWorkspace: {
      'browser-tab-1': [
        {
          id: 'page-1',
          workspaceId: 'browser-tab-1',
          worktreeId: workspaceKey,
          url: 'https://example.com',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    openFiles: [
      {
        id: 'file-1',
        worktreeId: workspaceKey,
        filePath: '/workspace/platform/notes.md',
        relativePath: 'notes.md',
        language: 'markdown',
        isDirty: true,
        isPreview: false,
        mode: 'edit'
      }
    ],
    editorDrafts: { 'file-1': 'draft' },
    activeFileIdByWorktree: { [workspaceKey]: 'file-1' },
    activeTabTypeByWorktree: { [workspaceKey]: 'browser' },
    activeBrowserTabIdByWorktree: { [workspaceKey]: 'browser-tab-1' },
    lastVisitedAtByWorktreeId: { [workspaceKey]: 10 }
  }
}
