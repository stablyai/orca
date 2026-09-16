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

  // Why this matters beyond persistence hygiene: terminal-pane recovery asks
  // the terminal ROW who owns the surface. While the row lost viewMode on load,
  // a chat-owned tab read as "not chat-owned" after every restart and recovery
  // would remount its hidden surface — the race #19745's guard exists to stop.
  describe('terminal row viewMode', () => {
    function parseRow(row: Record<string, unknown>): Record<string, unknown> | undefined {
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
              ...row
            }
          ]
        },
        terminalLayoutsByTabId: {}
      })
      expect(result.ok).toBe(true)
      return result.ok ? result.value.tabsByWorktree.wt[0] : undefined
    }

    it('survives the load boundary so a restored row still reads chat-owned', () => {
      expect(parseRow({ viewMode: 'chat' })?.viewMode).toBe('chat')
    })

    it('keeps an explicit terminal mode', () => {
      expect(parseRow({ viewMode: 'terminal' })?.viewMode).toBe('terminal')
    })

    it('leaves a row persisted by an older build undefined rather than failing', () => {
      expect(parseRow({})?.viewMode).toBeUndefined()
    })

    it('degrades an unknown mode from a newer build instead of dropping the tab', () => {
      // .catch('terminal') — the safe default, never a whole-session parse failure.
      expect(parseRow({ viewMode: 'holographic' })?.viewMode).toBe('terminal')
    })
  })
})
