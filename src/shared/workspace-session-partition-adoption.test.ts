import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { TerminalTab, WorkspaceSessionState } from './types'
import {
  adoptOrphanedWorkspaceSessionPartition,
  buildAdoptedWorkspaceSessionOwnerPatch,
  pruneAdoptedWorkspaceSessionPartitionEntries
} from './workspace-session-partition-adoption'

const WORKTREE_ID = 'repo-1::/srv/wt'
const OTHER_WORKTREE_ID = 'repo-1::/srv/other-wt'

function tab(id: string, worktreeId = WORKTREE_ID): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

describe('adoptOrphanedWorkspaceSessionPartition', () => {
  it('adopts a populated partition entry when the base holds no tabs for the worktree', () => {
    const base = session({ tabsByWorktree: { [WORKTREE_ID]: [] } })
    const partition = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1')] },
      terminalLayoutsByTabId: { 'tab-1': { root: null } as never },
      activeTabIdByWorktree: { [WORKTREE_ID]: 'tab-1' },
      lastVisitedAtByWorktreeId: { [WORKTREE_ID]: 42 },
      defaultTerminalTabsAppliedByWorktreeId: { [WORKTREE_ID]: true }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, partition)

    expect(adoption.adoptedTabIdsByWorktreeId).toEqual({ [WORKTREE_ID]: ['tab-1'] })
    expect(adoption.session.tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(adoption.session.terminalLayoutsByTabId['tab-1']).toBeDefined()
    expect(adoption.session.activeTabIdByWorktree?.[WORKTREE_ID]).toBe('tab-1')
    expect(adoption.session.lastVisitedAtByWorktreeId?.[WORKTREE_ID]).toBe(42)
    expect(adoption.session.defaultTerminalTabsAppliedByWorktreeId?.[WORKTREE_ID]).toBe(true)
  })

  it('adopts when the base has no entry at all for the worktree', () => {
    const base = session({})
    const partition = session({ tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1')] } })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, partition)

    expect(adoption.session.tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('keeps the base entry when it already holds tabs, even if the partition differs', () => {
    const base = session({ tabsByWorktree: { [WORKTREE_ID]: [tab('live-tab')] } })
    const partition = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('stale-tab-1'), tab('stale-tab-2')] }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, partition)

    expect(adoption.session).toBe(base)
    expect(adoption.adoptedTabIdsByWorktreeId).toEqual({})
  })

  it('returns the base identically when there is nothing to adopt', () => {
    const base = session({ tabsByWorktree: { [WORKTREE_ID]: [] } })

    expect(adoptOrphanedWorkspaceSessionPartition(base, session({})).session).toBe(base)
    expect(adoptOrphanedWorkspaceSessionPartition(base, null).session).toBe(base)
  })

  it('never removes base entries for worktrees the partition does not populate', () => {
    const base = session({
      tabsByWorktree: { [OTHER_WORKTREE_ID]: [tab('kept', OTHER_WORKTREE_ID)] }
    })
    const partition = session({ tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1')] } })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, partition)

    expect(adoption.session.tabsByWorktree[OTHER_WORKTREE_ID]).toHaveLength(1)
    expect(adoption.session.tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('skips tabs retired by a surface tombstone on either side', () => {
    const tombstone = {
      worktreeId: WORKTREE_ID,
      parentTabId: 'retired-tab',
      leafId: 'leaf-1',
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      retiredAt: 5
    }
    const base = session({
      terminalSurfaceTombstonesByPaneKey: { 'retired-tab:leaf-1': tombstone }
    })
    const partition = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('retired-tab'), tab('live-tab')] }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, partition)

    expect(adoption.adoptedTabIdsByWorktreeId).toEqual({ [WORKTREE_ID]: ['live-tab'] })
  })

  it('only carries tab-scoped records of adopted tabs and never overwrites base records', () => {
    const baseLayout = { root: null } as never
    const base = session({
      tabsByWorktree: { [OTHER_WORKTREE_ID]: [tab('base-tab', OTHER_WORKTREE_ID)] },
      terminalLayoutsByTabId: { 'base-tab': baseLayout }
    })
    const partition = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1')] },
      terminalLayoutsByTabId: {
        'tab-1': { root: null } as never,
        'base-tab': { root: { stale: true } } as never,
        'unrelated-tab': { root: null } as never
      },
      remoteSessionIdsByTabId: { 'tab-1': 'session-1', 'unrelated-tab': 'session-2' }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, partition)

    expect(adoption.session.terminalLayoutsByTabId['base-tab']).toBe(baseLayout)
    expect(adoption.session.terminalLayoutsByTabId['tab-1']).toBeDefined()
    expect(adoption.session.terminalLayoutsByTabId['unrelated-tab']).toBeUndefined()
    expect(adoption.session.remoteSessionIdsByTabId).toEqual({ 'tab-1': 'session-1' })
  })
})

describe('buildAdoptedWorkspaceSessionOwnerPatch', () => {
  it('returns null when nothing was adopted', () => {
    expect(buildAdoptedWorkspaceSessionOwnerPatch(session({}), session({}), {})).toBeNull()
  })

  it('lands every adopted field on top of a fresh owner read without dropping newer entries', () => {
    const partition = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1')] },
      terminalLayoutsByTabId: { 'tab-1': { root: null } as never },
      remoteSessionIdsByTabId: { 'tab-1': 'session-1' },
      activeTabIdByWorktree: { [WORKTREE_ID]: 'tab-1' },
      lastVisitedAtByWorktreeId: { [WORKTREE_ID]: 42 },
      defaultTerminalTabsAppliedByWorktreeId: { [WORKTREE_ID]: true }
    })
    const adoption = adoptOrphanedWorkspaceSessionPartition(session({}), partition)
    // A concurrent write landed on the owner partition after adoption started.
    const freshOwner = session({
      tabsByWorktree: { [OTHER_WORKTREE_ID]: [tab('new-tab', OTHER_WORKTREE_ID)] }
    })

    const patch = buildAdoptedWorkspaceSessionOwnerPatch(
      freshOwner,
      adoption.session,
      adoption.adoptedTabIdsByWorktreeId
    )

    expect(patch?.tabsByWorktree?.[WORKTREE_ID]).toHaveLength(1)
    expect(patch?.tabsByWorktree?.[OTHER_WORKTREE_ID]).toHaveLength(1)
    expect(patch?.terminalLayoutsByTabId?.['tab-1']).toBeDefined()
    expect(patch?.remoteSessionIdsByTabId).toEqual({ 'tab-1': 'session-1' })
    expect(patch?.activeTabIdByWorktree?.[WORKTREE_ID]).toBe('tab-1')
    expect(patch?.lastVisitedAtByWorktreeId?.[WORKTREE_ID]).toBe(42)
    expect(patch?.defaultTerminalTabsAppliedByWorktreeId?.[WORKTREE_ID]).toBe(true)
  })
})

describe('pruneAdoptedWorkspaceSessionPartitionEntries', () => {
  it('returns null when nothing was adopted', () => {
    expect(pruneAdoptedWorkspaceSessionPartitionEntries(session({}), {})).toBeNull()
  })

  it('drops only the adopted worktree entries and adopted tab records', () => {
    const partition = session({
      tabsByWorktree: {
        [WORKTREE_ID]: [tab('tab-1')],
        [OTHER_WORKTREE_ID]: [tab('kept-tab', OTHER_WORKTREE_ID)]
      },
      terminalLayoutsByTabId: {
        'tab-1': { root: null } as never,
        'kept-tab': { root: null } as never
      },
      remoteSessionIdsByTabId: { 'tab-1': 'session-1', 'kept-tab': 'session-2' }
    })

    const patch = pruneAdoptedWorkspaceSessionPartitionEntries(partition, {
      [WORKTREE_ID]: ['tab-1']
    })

    expect(patch).not.toBeNull()
    expect(Object.keys(patch?.tabsByWorktree ?? {})).toEqual([OTHER_WORKTREE_ID])
    expect(Object.keys(patch?.terminalLayoutsByTabId ?? {})).toEqual(['kept-tab'])
    expect(patch?.remoteSessionIdsByTabId).toEqual({ 'kept-tab': 'session-2' })
  })
})
