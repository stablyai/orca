import { describe, expect, it } from 'vitest'
import type { BrowserWorkspace } from './browser-workspace-types'
import type { Tab } from './tab-types'
import { getWorkspaceSessionTabActivityIds } from './workspace-session-tab-activity'

function browser(worktreeId: string): BrowserWorkspace {
  return {
    id: `browser-${worktreeId}`,
    worktreeId,
    url: 'about:blank',
    title: '',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

function tab(worktreeId: string, contentType: Tab['contentType'], agent?: string): Tab {
  return {
    id: `${contentType}-${worktreeId}`,
    entityId: worktreeId,
    groupId: 'group',
    worktreeId,
    contentType,
    label: '',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...(agent ? { agentSessionAgent: agent } : {})
  }
}

describe('getWorkspaceSessionTabActivityIds', () => {
  it('counts open browser and native-chat tabs under the workspace id their key names', () => {
    expect(
      getWorkspaceSessionTabActivityIds({
        browserTabsByWorktree: { 'worktree:repo::/a': [browser('repo::/a')], empty: [] },
        unifiedTabs: {
          'folder:f1': [tab('folder:f1', 'agent-session', 'claude')],
          terminalOnly: [tab('terminalOnly', 'terminal')]
        }
      })
    ).toEqual(new Set(['repo::/a', 'folder:f1']))
  })

  it('reads a missing session as no activity', () => {
    expect(getWorkspaceSessionTabActivityIds(null)).toEqual(new Set())
  })
})
