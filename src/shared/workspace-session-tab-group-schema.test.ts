import { describe, it, expect } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'

describe('parseWorkspaceSession', () => {
  it('preserves clusters and falls back to grey for an unknown color', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      tabGroups: {
        wt: [
          {
            id: 'pane',
            worktreeId: 'wt',
            activeTabId: 'a',
            tabOrder: ['a'],
            tabClusters: [
              { id: 'cluster', name: 'Work', color: 'future-color', collapsed: true, tabIds: ['a'] }
            ]
          }
        ]
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected a valid session')
    }
    expect(result.value.tabGroups?.wt[0].tabClusters).toEqual([
      { id: 'cluster', name: 'Work', color: 'grey', collapsed: true, tabIds: ['a'] }
    ])
  })

  it.each([
    { tabClusters: 'broken' },
    { tabClusters: [{ id: 1, name: '', color: 'blue', collapsed: false, tabIds: ['a'] }] },
    { tabClusters: [{ id: 'c', name: null, color: 'blue', collapsed: false, tabIds: ['a'] }] },
    { tabClusters: [{ id: 'c', name: '', color: 'blue', collapsed: 'yes', tabIds: ['a'] }] },
    { tabClusters: [{ id: 'c', name: '', color: 'blue', collapsed: false, tabIds: [1] }] }
  ])('drops corrupt cluster metadata without dropping its pane: %j', ({ tabClusters }) => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      tabGroups: {
        wt: [
          {
            id: 'pane',
            worktreeId: 'wt',
            activeTabId: 'a',
            tabOrder: ['a'],
            tabClusters
          }
        ]
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected a salvaged session')
    }
    expect(result.value.tabGroups?.wt).toEqual([
      { id: 'pane', worktreeId: 'wt', activeTabId: 'a', tabOrder: ['a'], tabClusters: undefined }
    ])
  })
})
