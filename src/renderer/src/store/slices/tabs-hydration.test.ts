import { describe, it, expect, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/types'
import { buildHydratedTabState } from './tabs-hydration'

vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Math.random().toString(36).slice(2, 8)}` })

function makeBaseSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

describe('buildHydratedTabState – unified format', () => {
  it('hydrates tabs and groups from unified format', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Term',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'f1',
            entityId: 'f1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'editor',
            label: 'File',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1', 'f1'] }]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    expect(result.unifiedTabsByWorktree.w1).toHaveLength(2)
    expect(result.groupsByWorktree.w1).toHaveLength(1)
    expect(result.activeGroupIdByWorktree.w1).toBe('g1')
  })

  it('filters out invalid worktree IDs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Term',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ],
        w_gone: [
          {
            id: 't2',
            entityId: 't2',
            groupId: 'g2',
            worktreeId: 'w_gone',
            contentType: 'terminal',
            label: 'Gone',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }],
        w_gone: [{ id: 'g2', worktreeId: 'w_gone', activeTabId: 't2', tabOrder: ['t2'] }]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    expect(result.unifiedTabsByWorktree.w1).toHaveLength(1)
    expect(result.unifiedTabsByWorktree.w_gone).toBeUndefined()
  })

  it('validates group references against hydrated tabs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Term',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        w1: [
          {
            id: 'g1',
            worktreeId: 'w1',
            activeTabId: 'deleted-tab',
            tabOrder: ['deleted-tab', 't1']
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    const group = result.groupsByWorktree.w1[0]
    expect(group.activeTabId).toBeNull()
    expect(group.tabOrder).toEqual(['t1'])
  })

  it('collapses groups and layout when transient tabs are dropped during hydration', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      openFilesByWorktree: {
        w1: [
          {
            filePath: '/editor.ts',
            relativePath: 'editor.ts',
            worktreeId: 'w1',
            language: 'typescript'
          }
        ]
      },
      unifiedTabs: {
        w1: [
          {
            id: 'diff-1',
            entityId: '/diff.ts',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'diff',
            label: 'diff.ts',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'editor-1',
            entityId: '/editor.ts',
            groupId: 'g2',
            worktreeId: 'w1',
            contentType: 'editor',
            label: 'editor.ts',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        w1: [
          { id: 'g1', worktreeId: 'w1', activeTabId: 'diff-1', tabOrder: ['diff-1'] },
          { id: 'g2', worktreeId: 'w1', activeTabId: 'editor-1', tabOrder: ['editor-1'] }
        ]
      },
      tabGroupLayouts: {
        w1: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'g1' },
          second: { type: 'leaf', groupId: 'g2' },
          ratio: 0.5
        }
      },
      activeGroupIdByWorktree: { w1: 'g1' }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1).toEqual([
      expect.objectContaining({ id: 'editor-1', groupId: 'g2', contentType: 'editor' })
    ])
    expect(result.groupsByWorktree.w1).toEqual([
      {
        id: 'g2',
        worktreeId: 'w1',
        activeTabId: 'editor-1',
        tabOrder: ['editor-1'],
        recentTabIds: ['editor-1']
      }
    ])
    expect(result.activeGroupIdByWorktree.w1).toBe('g2')
    expect(result.layoutByWorktree.w1).toEqual({ type: 'leaf', groupId: 'g2' })
  })
})

describe('buildHydratedTabState – legacy format', () => {
  it('converts TerminalTab[] to unified Tab[]', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: {
        w1: [
          {
            id: 'tt1',
            ptyId: null,
            worktreeId: 'w1',
            title: 'bash',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 100
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    expect(result.unifiedTabsByWorktree.w1).toHaveLength(1)
    expect(result.unifiedTabsByWorktree.w1[0].contentType).toBe('terminal')
    expect(result.unifiedTabsByWorktree.w1[0].label).toBe('bash')
  })

  it('converts PersistedOpenFile[] to editor tabs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: { w1: [] },
      openFilesByWorktree: {
        w1: [
          {
            filePath: '/src/index.ts',
            relativePath: 'src/index.ts',
            worktreeId: 'w1',
            language: 'typescript'
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    expect(result.unifiedTabsByWorktree.w1).toHaveLength(1)
    expect(result.unifiedTabsByWorktree.w1[0].contentType).toBe('editor')
    expect(result.unifiedTabsByWorktree.w1[0].id).toBe('/src/index.ts')
  })

  it('resolves activeTabId from legacy activeTabType', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: {
        w1: [
          {
            id: 'tt1',
            ptyId: null,
            worktreeId: 'w1',
            title: 'bash',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 100
          }
        ]
      },
      openFilesByWorktree: {
        w1: [
          {
            filePath: '/f1',
            relativePath: 'f1',
            worktreeId: 'w1',
            language: 'ts'
          }
        ]
      },
      activeTabTypeByWorktree: { w1: 'editor' },
      activeFileIdByWorktree: { w1: '/f1' }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    const group = result.groupsByWorktree.w1[0]
    expect(group.activeTabId).toBe('/f1')
  })

  it('skips worktrees with no tabs or files', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: { w1: [], w2: [] }
    }

    const result = buildHydratedTabState(session, new Set(['w1', 'w2']))
    expect(Object.keys(result.unifiedTabsByWorktree)).toHaveLength(0)
  })
})
