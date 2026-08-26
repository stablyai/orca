import { describe, expect, it } from 'vitest'

import { mergeDirectSshRemoteWorkspaceSession } from './remote-workspace-session-merge'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '../store/types'

const WORKTREE = 'repo-1::/home/user/bug-cats'

function terminalTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    title: id,
    type: 'terminal',
    worktreeId: WORKTREE,
    ...overrides
  } as TerminalTab
}

function sessionState(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE,
    activeWorkspaceKey: worktreeWorkspaceKey(WORKTREE),
    activeTabId: 'agent',
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    ...overrides
  } as WorkspaceSessionState
}

function merge(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  liveTabs: AppState['tabsByWorktree'] = {}
): WorkspaceSessionState {
  return mergeDirectSshRemoteWorkspaceSession(
    current,
    remote,
    new Set([WORKTREE]),
    liveTabs,
    new Set()
  )
}

describe('direct-SSH pull merge: closed-tab tombstones', () => {
  it('a remote tab with a local tombstone is not re-inserted', () => {
    const ghost = terminalTab('tab-ghost')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [] },
      closedTerminalTabTombstonesByTabId: {
        'tab-ghost': { closedAt: Date.now(), worktreeId: WORKTREE }
      }
    })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [ghost] },
      terminalLayoutsByTabId: { 'tab-ghost': { type: 'single', tabId: 'tab-ghost' } as never }
    })

    const merged = merge(current, remote, { [WORKTREE]: [] })

    expect(merged.tabsByWorktree[WORKTREE] ?? []).toEqual([])
    expect(merged.terminalLayoutsByTabId['tab-ghost']).toBeUndefined()
    expect(merged.closedTerminalTabTombstonesByTabId?.['tab-ghost']).toBeDefined()
  })

  it('a remote tombstone kills the matching local tab-list entry too', () => {
    const tabX = terminalTab('tab-x')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [tabX] }
    })
    const remote = sessionState({
      tabsByWorktree: {},
      closedTerminalTabTombstonesByTabId: {
        'tab-x': { closedAt: Date.now(), worktreeId: WORKTREE }
      }
    })

    const merged = merge(current, remote, {})

    expect((merged.tabsByWorktree[WORKTREE] ?? []).map((t) => t.id)).not.toContain('tab-x')
  })

  it('a live local tab invalidates a stale tombstone for its id', () => {
    const tabLive = terminalTab('tab-live')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [tabLive] },
      closedTerminalTabTombstonesByTabId: {
        'tab-live': { closedAt: Date.now(), worktreeId: WORKTREE }
      }
    })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [tabLive] }
    })

    const merged = merge(current, remote, { [WORKTREE]: [tabLive] })

    expect((merged.tabsByWorktree[WORKTREE] ?? []).map((t) => t.id)).toContain('tab-live')
    expect(merged.closedTerminalTabTombstonesByTabId?.['tab-live']).toBeUndefined()
  })

  it('a tombstone wins over preserveLocalTerminalTabIds when the tab is not live locally', () => {
    // preserveLocalTerminalTabIds (recovery tabs) only matters for a REMOTE tab that also exists
    // locally with a newer generation — it never revives a tab the tombstone filter already dropped.
    const ghost = terminalTab('tab-recovery-ghost')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [] },
      closedTerminalTabTombstonesByTabId: {
        'tab-recovery-ghost': { closedAt: Date.now(), worktreeId: WORKTREE }
      }
    })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [ghost] }
    })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([WORKTREE]),
      {},
      new Set(['tab-recovery-ghost'])
    )

    expect((merged.tabsByWorktree[WORKTREE] ?? []).map((t) => t.id)).not.toContain(
      'tab-recovery-ghost'
    )
  })

  it('clears activeTabId and activeTabIdByWorktree entries that name a tombstoned tab', () => {
    const ghost = terminalTab('tab-ghost')
    const survivor = terminalTab('tab-survivor')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [] }
    })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [ghost, survivor] },
      activeTabId: 'tab-ghost',
      activeTabIdByWorktree: { [WORKTREE]: 'tab-ghost' },
      closedTerminalTabTombstonesByTabId: {
        'tab-ghost': { closedAt: Date.now(), worktreeId: WORKTREE }
      }
    })

    const merged = merge(current, remote, { [WORKTREE]: [] })

    expect(merged.activeTabId).toBeNull()
    expect(merged.activeTabIdByWorktree?.[WORKTREE]).toBeNull()
  })

  it('a non-tombstoned active tab id passes through unchanged', () => {
    const survivor = terminalTab('tab-survivor')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [] }
    })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [survivor] },
      activeTabId: 'tab-survivor',
      activeTabIdByWorktree: { [WORKTREE]: 'tab-survivor' }
    })

    const merged = merge(current, remote, { [WORKTREE]: [] })

    expect(merged.activeTabId).toBe('tab-survivor')
    expect(merged.activeTabIdByWorktree?.[WORKTREE]).toBe('tab-survivor')
  })

  it('without any tombstone the local-survival trade is unchanged', () => {
    // Copied from remote-workspace-session-merge-local-survival.test.ts: the host still lists a tab
    // closed elsewhere, and absence alone must keep letting it survive.
    const agent = terminalTab('agent')
    const closedElsewhere = terminalTab('closed-elsewhere')
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [agent, closedElsewhere] } })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [agent] } })

    const merged = merge(current, remote, { [WORKTREE]: [agent, closedElsewhere] })

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })
})
