import { describe, expect, it } from 'vitest'
import type { TerminalTab, WorkspaceSessionState } from '../../../shared/types'
import {
  mergeDirectSshRemoteWorkspaceSession,
  narrowDirectSshReplaceWorktreeIds
} from './remote-workspace-session-merge'

function tab(id: string, worktreeId: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    worktreeId,
    title: id,
    ptyId: `pty-${id}`,
    generation: 1,
    ...overrides
  } as TerminalTab
}

function session(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

const WT = 'repo-1::/home/user/worktree-a'
const OTHER_WT = 'repo-1::/home/user/worktree-b'

// Mirrors the production caller: narrow the requested scope first, then merge with the result.
function narrowAndMerge(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  requested: ReadonlySet<string>,
  liveTabsByWorktree: Record<string, TerminalTab[]>
): { merged: WorkspaceSessionState; replaceWorktreeIds: ReadonlySet<string> } {
  const replaceWorktreeIds = narrowDirectSshReplaceWorktreeIds(
    requested,
    current,
    remote,
    liveTabsByWorktree
  )
  const merged = mergeDirectSshRemoteWorkspaceSession(
    current,
    remote,
    replaceWorktreeIds,
    liveTabsByWorktree,
    new Set()
  )
  return { merged, replaceWorktreeIds }
}

describe('narrowDirectSshReplaceWorktreeIds', () => {
  it('drops a worktree with local tabs the remote snapshot reports no tabs for', () => {
    const localTabs = [tab('tab-1', WT)]
    const narrowed = narrowDirectSshReplaceWorktreeIds(
      new Set([WT]),
      session({ tabsByWorktree: { [WT]: localTabs } }),
      session({ tabsByWorktree: { [WT]: [] } }),
      { [WT]: localTabs }
    )
    expect([...narrowed]).toEqual([])
  })

  it('keeps a worktree when the remote snapshot has tabs, or local has none', () => {
    const narrowed = narrowDirectSshReplaceWorktreeIds(
      new Set([WT, OTHER_WT]),
      session({ tabsByWorktree: { [WT]: [tab('tab-1', WT)], [OTHER_WT]: [] } }),
      session({ tabsByWorktree: { [WT]: [tab('tab-r', WT)], [OTHER_WT]: [] } }),
      { [WT]: [tab('tab-1', WT)], [OTHER_WT]: [] }
    )
    expect([...narrowed].sort()).toEqual([WT, OTHER_WT].sort())
  })
})

describe('mergeDirectSshRemoteWorkspaceSession', () => {
  it('keeps local state for a worktree the narrowing removed from the replace scope', () => {
    const localTabs = [tab('tab-1', WT), tab('tab-2', WT)]
    const current = session({
      tabsByWorktree: { [WT]: localTabs },
      terminalLayoutsByTabId: { 'tab-1': { activeLeafId: 'leaf-1' } as never },
      activeTabIdByWorktree: { [WT]: 'tab-1' },
      lastVisitedAtByWorktreeId: { [WT]: 111 },
      activeWorktreeIdsOnShutdown: [WT],
      defaultTerminalTabsAppliedByWorktreeId: { [WT]: true }
    })
    const remote = session({
      tabsByWorktree: { [WT]: [] },
      activeTabIdByWorktree: { [WT]: null },
      lastVisitedAtByWorktreeId: { [WT]: 999 }
    })

    const { merged, replaceWorktreeIds } = narrowAndMerge(current, remote, new Set([WT]), {
      [WT]: localTabs
    })

    expect([...replaceWorktreeIds]).toEqual([])
    expect(merged.tabsByWorktree[WT]).toEqual(localTabs)
    expect(merged.terminalLayoutsByTabId['tab-1']).toEqual({ activeLeafId: 'leaf-1' })
    expect(merged.activeTabIdByWorktree?.[WT]).toBe('tab-1')
    expect(merged.lastVisitedAtByWorktreeId?.[WT]).toBe(111)
    expect(merged.activeWorktreeIdsOnShutdown).toEqual([WT])
    expect(merged.defaultTerminalTabsAppliedByWorktreeId?.[WT]).toBe(true)
  })

  it('keeps local tabs for an in-scope worktree the remote snapshot omits entirely', () => {
    const localTabs = [tab('tab-1', WT)]
    const current = session({ tabsByWorktree: { [WT]: localTabs } })
    const remote = session()

    const { merged } = narrowAndMerge(current, remote, new Set([WT]), { [WT]: localTabs })

    expect(merged.tabsByWorktree[WT]).toEqual(localTabs)
  })

  it('keeps current active-tab state when the active worktree left the replace scope', () => {
    const localTabs = [tab('tab-1', WT)]
    const current = session({
      activeWorktreeId: WT,
      activeTabId: 'tab-1',
      tabsByWorktree: { [WT]: localTabs }
    })
    const remote = session({
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: { [WT]: [] }
    })

    const { merged } = narrowAndMerge(current, remote, new Set([WT]), { [WT]: localTabs })

    expect(merged.activeWorktreeId).toBe(WT)
    expect(merged.activeTabId).toBe('tab-1')
  })

  it('narrows the replace scope itself when the caller hands it an un-narrowed set', () => {
    const localTabs = [tab('tab-1', WT)]
    const merged = mergeDirectSshRemoteWorkspaceSession(
      session({ tabsByWorktree: { [WT]: localTabs } }),
      session({ tabsByWorktree: { [WT]: [] } }),
      new Set([WT]),
      { [WT]: localTabs },
      new Set()
    )

    expect(merged.tabsByWorktree[WT]).toEqual(localTabs)
  })

  it('still replaces a worktree when the remote snapshot has tabs for it', () => {
    const localTabs = [tab('tab-old', WT)]
    const remoteTabs = [tab('tab-new', WT, { generation: 2 })]
    const current = session({ tabsByWorktree: { [WT]: localTabs } })
    const remote = session({ tabsByWorktree: { [WT]: remoteTabs } })

    const { merged, replaceWorktreeIds } = narrowAndMerge(current, remote, new Set([WT]), {
      [WT]: localTabs
    })

    expect([...replaceWorktreeIds]).toEqual([WT])
    expect(merged.tabsByWorktree[WT].map((t) => t.id)).toEqual(['tab-new'])
  })

  it('accepts an empty remote worktree when local has no tabs either', () => {
    const current = session({ tabsByWorktree: { [WT]: [] } })
    const remote = session({ tabsByWorktree: { [WT]: [] } })

    const { merged } = narrowAndMerge(current, remote, new Set([WT]), {})

    expect(merged.tabsByWorktree[WT]).toEqual([])
  })

  it('scopes the guard per worktree, replacing populated ones while keeping the emptied one', () => {
    const keptTabs = [tab('tab-kept', WT)]
    const replacedRemote = [tab('tab-remote', OTHER_WT, { generation: 3 })]
    const current = session({
      tabsByWorktree: { [WT]: keptTabs, [OTHER_WT]: [tab('tab-old', OTHER_WT)] },
      activeWorktreeIdsOnShutdown: [WT],
      defaultTerminalTabsAppliedByWorktreeId: { [WT]: true, [OTHER_WT]: true }
    })
    const remote = session({
      tabsByWorktree: { [WT]: [], [OTHER_WT]: replacedRemote },
      activeWorktreeIdsOnShutdown: [WT, OTHER_WT]
    })

    const { merged, replaceWorktreeIds } = narrowAndMerge(
      current,
      remote,
      new Set([WT, OTHER_WT]),
      { [WT]: keptTabs, [OTHER_WT]: [tab('tab-old', OTHER_WT)] }
    )

    expect([...replaceWorktreeIds]).toEqual([OTHER_WT])
    expect(merged.tabsByWorktree[WT]).toEqual(keptTabs)
    expect(merged.tabsByWorktree[OTHER_WT].map((t) => t.id)).toEqual(['tab-remote'])
    // Per-worktree records follow the same scope: the kept worktree's entries stay local, the
    // replaced worktree's entries come from the remote.
    expect(merged.activeWorktreeIdsOnShutdown).toEqual([WT, OTHER_WT])
    expect(merged.defaultTerminalTabsAppliedByWorktreeId?.[WT]).toBe(true)
    // Remote-authoritative for the replaced worktree: the remote carries no entry, so none survives.
    expect(merged.defaultTerminalTabsAppliedByWorktreeId?.[OTHER_WT]).toBeUndefined()
  })
})
