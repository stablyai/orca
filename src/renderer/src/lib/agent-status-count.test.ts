import { describe, expect, it } from 'vitest'
import type { TerminalTab, Worktree } from '../../../shared/types'
import { countWorkingAgents, getWorkingAgentsPerWorktree } from './agent-status'

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function worktrees(...ids: string[]): Record<string, Worktree[]> {
  return {
    repo: ids.map(
      (id) =>
        ({
          id,
          repoId: 'repo',
          path: `/path/${id}`,
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: false,
          displayName: id,
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0
        }) satisfies Worktree
    )
  }
}

// Why: build a live-pty map from tab ids so each test can declare which tabs
// are actually alive without manually tracking parallel `tab.ptyId` values.
// `tab.ptyId` is the wake-hint sessionId preserved across sleep, not a
// liveness signal — slept-tab tests below pin the gap.
function livePtyMap(...tabIds: string[]): Record<string, string[]> {
  return Object.fromEntries(tabIds.map((id, i) => [id, [`pty-${i}`]]))
}

describe('countWorkingAgents', () => {
  it('counts each live working tab when pane-level titles are unavailable', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [
            makeTab({ id: 'tab-1', title: '⠂ Claude Code' }),
            makeTab({ id: 'tab-2', title: '✦ Gemini CLI' })
          ],
          'wt-2': [makeTab({ id: 'tab-3', worktreeId: 'wt-2', title: '⠋ Codex is thinking' })]
        },
        runtimePaneTitlesByTabId: {},
        ptyIdsByTabId: livePtyMap('tab-1', 'tab-2', 'tab-3'),
        worktreesByRepo: worktrees('wt-1', 'wt-2')
      })
    ).toBe(3)
  })

  it('counts working panes separately within the same tab', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
        },
        runtimePaneTitlesByTabId: {
          'tab-1': {
            1: '⠂ Claude Code',
            2: '✦ Gemini CLI',
            3: '✳ Claude Code'
          }
        },
        ptyIdsByTabId: livePtyMap('tab-1'),
        worktreesByRepo: worktrees('wt-1')
      })
    ).toBe(2)
  })

  it('ignores non-working or non-live tabs', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [
            makeTab({ id: 'tab-1', title: '✳ Claude Code' }),
            makeTab({ id: 'tab-2', title: '✋ Gemini CLI' }),
            makeTab({ id: 'tab-3', title: 'bash' }),
            makeTab({ id: 'tab-4', title: '⠂ Claude Code' })
          ]
        },
        runtimePaneTitlesByTabId: {},
        ptyIdsByTabId: livePtyMap('tab-1', 'tab-2', 'tab-3'),
        worktreesByRepo: worktrees('wt-1')
      })
    ).toBe(0)
  })

  it('prefers pane-level titles over the coarse tab title when available', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
        },
        runtimePaneTitlesByTabId: {
          'tab-1': {
            1: '✳ Claude Code',
            2: 'bash'
          }
        },
        ptyIdsByTabId: livePtyMap('tab-1'),
        worktreesByRepo: worktrees('wt-1')
      })
    ).toBe(0)
  })

  it('excludes orphaned worktrees not in worktreesByRepo', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })],
          'wt-deleted': [makeTab({ id: 'tab-2', worktreeId: 'wt-deleted', title: '✦ Gemini CLI' })]
        },
        runtimePaneTitlesByTabId: {},
        ptyIdsByTabId: livePtyMap('tab-1', 'tab-2'),
        worktreesByRepo: worktrees('wt-1')
      })
    ).toBe(1)
  })

  // Why: sleep preserves runtimePaneTitlesByTabId and tab.ptyId as wake hints
  // while ptyIdsByTabId[tab.id] is cleared to []. Both branches of the
  // counter (primary pane-titles and tab-title fallback) must respect that
  // liveness gate — otherwise the title-bar agent count, dock badge, and
  // workingAgentsPerWorktree aggregates report ghost activity for slept
  // worktrees.
  it('returns 0 for a slept tab whose preserved pane titles still match working (primary branch)', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
        },
        runtimePaneTitlesByTabId: {
          'tab-1': { 0: '⠂ Claude Code' }
        },
        // Slept: live-pty array is empty even though tab.ptyId is set as a
        // wake-hint sessionId.
        ptyIdsByTabId: { 'tab-1': [] },
        worktreesByRepo: worktrees('wt-1')
      })
    ).toBe(0)
  })

  it('returns 0 for a slept tab whose preserved tab.title still matches working (fallback branch)', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
        },
        runtimePaneTitlesByTabId: {},
        ptyIdsByTabId: { 'tab-1': [] },
        worktreesByRepo: worktrees('wt-1')
      })
    ).toBe(0)
  })
})

describe('getWorkingAgentsPerWorktree', () => {
  it('returns per-pane labels and pane ids for split tabs', () => {
    expect(
      getWorkingAgentsPerWorktree({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
        },
        runtimePaneTitlesByTabId: {
          'tab-1': {
            1: '⠂ Claude Code',
            2: '✦ Gemini CLI',
            3: '✳ Claude Code'
          }
        },
        ptyIdsByTabId: livePtyMap('tab-1'),
        worktreesByRepo: worktrees('wt-1')
      })
    ).toEqual({
      'wt-1': {
        agents: [
          { label: 'Claude Code', status: 'working', tabId: 'tab-1', paneId: 1 },
          { label: 'Gemini CLI', status: 'working', tabId: 'tab-1', paneId: 2 }
        ]
      }
    })
  })

  it('excludes orphaned worktrees not in worktreesByRepo', () => {
    expect(
      getWorkingAgentsPerWorktree({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })],
          'wt-deleted': [makeTab({ id: 'tab-2', worktreeId: 'wt-deleted', title: '✦ Gemini CLI' })]
        },
        runtimePaneTitlesByTabId: {},
        ptyIdsByTabId: livePtyMap('tab-1', 'tab-2'),
        worktreesByRepo: worktrees('wt-1')
      })
    ).toEqual({
      'wt-1': {
        agents: [{ label: 'Claude Code', status: 'working', tabId: 'tab-1', paneId: null }]
      }
    })
  })

  // See countWorkingAgents slept-tab tests above — the same liveness gate
  // applies here on both branches of the per-worktree aggregation.
  it('returns nothing for a slept tab whose preserved pane titles still match working (primary branch)', () => {
    expect(
      getWorkingAgentsPerWorktree({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
        },
        runtimePaneTitlesByTabId: {
          'tab-1': { 0: '⠂ Claude Code' }
        },
        ptyIdsByTabId: { 'tab-1': [] },
        worktreesByRepo: worktrees('wt-1')
      })
    ).toEqual({})
  })

  it('returns nothing for a slept tab whose preserved tab.title still matches working (fallback branch)', () => {
    expect(
      getWorkingAgentsPerWorktree({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
        },
        runtimePaneTitlesByTabId: {},
        ptyIdsByTabId: { 'tab-1': [] },
        worktreesByRepo: worktrees('wt-1')
      })
    ).toEqual({})
  })
})
