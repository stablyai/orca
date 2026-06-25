import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/types'
import { buildHydratedTabState } from './tabs-hydration'

function makeBaseSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

describe('buildHydratedTabState generated terminal titles', () => {
  it('hydrates generated terminal labels from persisted terminal metadata', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: {
        w1: [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'w1',
            title: 'Codex working',
            generatedTitle: 'Fix flaky tests',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Codex working',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1[0].generatedLabel).toBe('Fix flaky tests')
  })

  it('converts legacy generated terminal titles to unified generated labels', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: {
        w1: [
          {
            id: 'tt1',
            ptyId: null,
            worktreeId: 'w1',
            title: 'bash',
            generatedTitle: 'Persisted agent title',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 100
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1[0].generatedLabel).toBe('Persisted agent title')
  })

  it('hydrates quick command labels from persisted terminal metadata', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: {
        w1: [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'w1',
            title: 'pnpm test',
            quickCommandLabel: 'Run tests',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'pnpm test',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1[0].quickCommandLabel).toBe('Run tests')
  })

  it('converts legacy quick command labels to unified labels', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      tabsByWorktree: {
        w1: [
          {
            id: 'tt1',
            ptyId: null,
            worktreeId: 'w1',
            title: 'pnpm test',
            quickCommandLabel: 'Run tests',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 100
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1[0].quickCommandLabel).toBe('Run tests')
  })
})
