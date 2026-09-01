import { describe, expect, it } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'

describe('parseWorkspaceSession terminal fields', () => {
  it('preserves terminal startup cwd while accepting older omitted fields', () => {
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
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            startupCwd: '/repo/packages/app',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 'tab2',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal 2',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].startupCwd).toBe('/repo/packages/app')
      expect(result.value.tabsByWorktree.wt[1].startupCwd).toBeUndefined()
    }
  })

  it('drops a tab with an empty startup cwd instead of failing the session', () => {
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
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            startupCwd: '',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt).toEqual([])
    }
  })

  it('round-trips host-owned launch notices and drops malformed notice state', () => {
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
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            launchNotices: {
              launchToken: 'tok-1',
              notices: [
                { code: 'disabled_custom_fallback', label: 'My Claude', baseAgent: 'claude' }
              ]
            }
          },
          {
            id: 'tab2',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal 2',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1,
            // Malformed: missing launchToken. `.catch(undefined)` must drop only
            // this field, not fail the whole-session parse.
            launchNotices: { notices: [{ code: 'not_a_code', label: 'x' }] }
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].launchNotices).toEqual({
        launchToken: 'tok-1',
        notices: [{ code: 'disabled_custom_fallback', label: 'My Claude', baseAgent: 'claude' }]
      })
      expect(result.value.tabsByWorktree.wt[1].launchNotices).toBeUndefined()
    }
  })
})
