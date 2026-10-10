import type { AppState } from '@/store/types'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-types'
import { getDefaultSettings } from '../../../shared/constants'

export const installed: AgentHookInstallStatus = {
  agent: 'claude',
  state: 'installed',
  configPath: '/home/user/.claude/settings.json',
  managedHooksPresent: true,
  detail: null
}

export const workspaceId = 'folder:hook-refresh'

export function liveConsumerState(): Partial<AppState> {
  return {
    settings: getDefaultSettings('/home/user'),
    repos: [],
    projects: [],
    projectGroups: [],
    worktreesByRepo: {},
    folderWorkspaces: [
      {
        id: 'hook-refresh',
        projectGroupId: 'group-1',
        name: 'project',
        folderPath: '/home/user/project',
        connectionId: null,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
    ],
    tabsByWorktree: {
      [workspaceId]: [
        {
          id: 'tab-1',
          worktreeId: workspaceId,
          ptyId: null,
          title: 'claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0,
          launchAgent: 'claude'
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    agentHookInstallStateByTarget: {}
  }
}
