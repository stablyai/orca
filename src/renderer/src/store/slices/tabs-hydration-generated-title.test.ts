import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
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

  it('preserves an explicit Vault clear across unified hydration conflicts', () => {
    const title = { agent: 'claude' as const, sessionId: 'session-1', title: 'Stale name' }
    const baseTerminal = {
      id: 't1',
      ptyId: null,
      worktreeId: 'w1',
      title: 'Claude working',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const baseUnified = {
      id: 't1',
      entityId: 't1',
      groupId: 'g1',
      worktreeId: 'w1',
      contentType: 'terminal' as const,
      label: 'Claude working',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const hydrate = (terminalTitle: typeof title | null, unifiedTitle: typeof title | null) =>
      buildHydratedTabState(
        {
          ...makeBaseSession(),
          tabsByWorktree: { w1: [{ ...baseTerminal, aiVaultTitle: terminalTitle }] },
          unifiedTabs: { w1: [{ ...baseUnified, aiVaultTitle: unifiedTitle }] },
          tabGroups: {
            w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }]
          }
        },
        new Set(['w1'])
      ).unifiedTabsByWorktree.w1[0].aiVaultTitle

    expect(hydrate(title, null)).toBeNull()
    expect(hydrate(null, title)).toBeNull()
  })

  it('converts legacy Vault title objects and clears without inventing absence', () => {
    const makeSession = (
      aiVaultTitle: { agent: 'claude'; sessionId: string; title: string } | null
    ) =>
      ({
        ...makeBaseSession(),
        tabsByWorktree: {
          w1: [
            {
              id: 'tt1',
              ptyId: null,
              worktreeId: 'w1',
              title: 'bash',
              aiVaultTitle,
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 100
            }
          ]
        }
      }) satisfies WorkspaceSessionState
    const title = { agent: 'claude' as const, sessionId: 'session-1', title: 'Housekeeping' }

    expect(
      buildHydratedTabState(makeSession(title), new Set(['w1'])).unifiedTabsByWorktree.w1[0]
        .aiVaultTitle
    ).toEqual(title)
    expect(
      buildHydratedTabState(makeSession(null), new Set(['w1'])).unifiedTabsByWorktree.w1[0]
        .aiVaultTitle
    ).toBeNull()
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
