import { describe, it, expect } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'

describe('parseWorkspaceSession — quick command tab reuse', () => {
  it('preserves the internal quickCommandId on terminal and unified tabs', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt: [
          {
            id: 'tab1',
            ptyId: null,
            worktreeId: 'wt',
            title: 'npm run dev',
            quickCommandLabel: 'Dev',
            quickCommandId: 'dev',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        wt: [
          {
            id: 'tab1',
            entityId: 'tab1',
            groupId: 'group1',
            worktreeId: 'wt',
            contentType: 'terminal',
            label: 'npm run dev',
            quickCommandLabel: 'Dev',
            quickCommandId: 'dev',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].quickCommandId).toBe('dev')
      expect(result.value.unifiedTabs?.wt[0].quickCommandId).toBe('dev')
    }
  })
})
