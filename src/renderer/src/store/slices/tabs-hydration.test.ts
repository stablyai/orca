import { describe, it, expect, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
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

  // Why this shape exists at all: a preview used to be an editor tab whose id encoded the document,
  // and its document was never persisted — so sessions written before previews became browser tabs
  // carry chrome for a surface no restore can produce. The reader's other tabs must be untouched.
  it('drops the chrome of a preview tab from before previews were browser tabs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      openFilesByWorktree: {
        w1: [
          {
            filePath: '/repo/docs/report.html',
            relativePath: 'docs/report.html',
            worktreeId: 'w1',
            language: 'html'
          }
        ]
      },
      unifiedTabs: {
        w1: [
          {
            id: 'preview-1',
            entityId: 'html-preview::w1::/repo/docs/report.html',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'editor',
            label: 'docs/report.html (preview)',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'editor-1',
            entityId: '/repo/docs/report.html',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'editor',
            label: 'report.html',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        w1: [
          {
            id: 'g1',
            worktreeId: 'w1',
            activeTabId: 'preview-1',
            tabOrder: ['preview-1', 'editor-1']
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    // The presence half: the ordinary editor tab for the very same document survives, so a filter
    // that dropped editor chrome wholesale would fail here rather than pass on an empty strip.
    expect(result.unifiedTabsByWorktree.w1?.map((tab) => tab.id)).toEqual(['editor-1'])
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

  it('keeps restored simulator tabs while pruning unrelated empty split groups', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          {
            id: 'terminal-1',
            entityId: 'terminal-1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'simulator-1',
            entityId: 'simulator-1',
            groupId: 'g2',
            worktreeId: 'w1',
            contentType: 'simulator',
            label: 'iPhone 17 Pro',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        w1: [
          { id: 'g1', worktreeId: 'w1', activeTabId: 'terminal-1', tabOrder: ['terminal-1'] },
          { id: 'g2', worktreeId: 'w1', activeTabId: 'simulator-1', tabOrder: ['simulator-1'] },
          { id: 'g3', worktreeId: 'w1', activeTabId: null, tabOrder: [] }
        ]
      },
      tabGroupLayouts: {
        w1: {
          type: 'split',
          direction: 'horizontal',
          first: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'g1' },
            second: { type: 'leaf', groupId: 'g2' },
            ratio: 0.5
          },
          second: { type: 'leaf', groupId: 'g3' },
          ratio: 0.5
        }
      },
      activeGroupIdByWorktree: { w1: 'g2' }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1).toEqual([
      expect.objectContaining({ id: 'terminal-1', contentType: 'terminal', groupId: 'g1' }),
      expect.objectContaining({ id: 'simulator-1', contentType: 'simulator', groupId: 'g2' })
    ])
    expect(result.groupsByWorktree.w1).toEqual([
      {
        id: 'g1',
        worktreeId: 'w1',
        activeTabId: 'terminal-1',
        tabOrder: ['terminal-1'],
        recentTabIds: ['terminal-1']
      },
      {
        id: 'g2',
        worktreeId: 'w1',
        activeTabId: 'simulator-1',
        tabOrder: ['simulator-1'],
        recentTabIds: ['simulator-1']
      }
    ])
    expect(result.activeGroupIdByWorktree.w1).toBe('g2')
    expect(result.layoutByWorktree.w1).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'g1' },
      second: { type: 'leaf', groupId: 'g2' },
      ratio: 0.5
    })
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

  it('restores each worktree remembered terminal, not the globally-active one', () => {
    // Why (regression): the legacy branch used the global session.activeTabId,
    // so every worktree except the last-focused one lost its remembered
    // terminal on restart and reopened on the first tab. Use the per-worktree
    // activeTabIdByWorktree map instead.
    const terminal = (id: string, worktreeId: string, sortOrder: number) => ({
      id,
      ptyId: null,
      worktreeId,
      title: id,
      customTitle: null,
      color: null,
      sortOrder,
      createdAt: 100 + sortOrder
    })
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      // The globally-active tab belongs to w1.
      activeTabId: 'w1-terminal-1',
      tabsByWorktree: {
        w1: [terminal('w1-terminal-1', 'w1', 0)],
        w2: [terminal('w2-terminal-1', 'w2', 0), terminal('w2-terminal-2', 'w2', 1)]
      },
      activeTabIdByWorktree: { w1: 'w1-terminal-1', w2: 'w2-terminal-2' }
    }

    const result = buildHydratedTabState(session, new Set(['w1', 'w2']))
    expect(result.groupsByWorktree.w2[0].activeTabId).toBe('w2-terminal-2')
    expect(result.groupsByWorktree.w1[0].activeTabId).toBe('w1-terminal-1')
  })

  it('skips worktrees with no tabs or files', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: { w1: [], w2: [] }
    }

    const result = buildHydratedTabState(session, new Set(['w1', 'w2']))
    expect(Object.keys(result.unifiedTabsByWorktree)).toHaveLength(0)
  })
  it('collapses tab records that a corrupt session persisted under one id', () => {
    // Why: editor owner migration re-stamped a tab id a sibling record already
    // held. Two rows under one id repeat a React key and strand a ghost row.
    const duplicateId = 'editor:wt%3A%3Alungfish:env-a:FINAL-REPORT.md'
    const editorTab = (id: string, sortOrder: number) => ({
      id,
      entityId: 'editor:wt%3A%3Alungfish:env-b:FINAL-REPORT.md',
      groupId: 'g1',
      worktreeId: 'w1',
      contentType: 'editor' as const,
      label: 'FINAL-REPORT.md',
      customLabel: null,
      color: null,
      sortOrder,
      createdAt: 1
    })
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [editorTab('t-unique', 0), editorTab(duplicateId, 1), editorTab(duplicateId, 2)]
      },
      tabGroups: {
        w1: [
          {
            id: 'g1',
            worktreeId: 'w1',
            activeTabId: 't-unique',
            tabOrder: ['t-unique', duplicateId, duplicateId]
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    const hydratedIds = result.unifiedTabsByWorktree.w1.map((tab) => tab.id)
    expect(hydratedIds).toEqual(['t-unique', duplicateId])
    // Why sortOrder: the two duplicate records differ only there, so an id-only
    // assertion passes just as well for an implementation that keeps the LAST one.
    expect(result.unifiedTabsByWorktree.w1.map((tab) => tab.sortOrder)).toEqual([0, 1])
    expect(new Set(hydratedIds).size).toBe(hydratedIds.length)
    expect(result.groupsByWorktree.w1[0].tabOrder).toEqual(['t-unique', duplicateId])
  })
})
