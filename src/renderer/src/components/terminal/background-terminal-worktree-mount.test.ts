import { describe, expect, it } from 'vitest'
import { isSnapshotBackedTerminalPty } from '../terminal-pane/parking/retention/terminal-hidden-view-parking'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities,
  terminalProviderHasAuthoritativeSnapshot
} from './terminal-provider-snapshot-capability'

import {
  applyBackgroundMountTabRestriction,
  planColdActivationTabDeferral,
  pruneClosedBackgroundMountTabs,
  requestBackgroundTerminalWorktreeMount,
  revealActivationDeferredTabs,
  takeAllPendingBackgroundTerminalWorktreeMounts
} from './background-terminal-worktree-mount'

describe('background terminal mount request registry', () => {
  it('unions targeted requests and lets a whole-worktree request dominate', () => {
    takeAllPendingBackgroundTerminalWorktreeMounts()
    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-1', tabIds: ['tab-1'] })
    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-1', tabIds: ['tab-2'] })
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([
      { worktreeId: 'wt-1', tabIds: ['tab-1', 'tab-2'] }
    ])

    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-1', tabIds: ['tab-1'] })
    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-1' })
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([{ worktreeId: 'wt-1' }])
  })
})

describe('applyBackgroundMountTabRestriction', () => {
  it('restricts a not-yet-mounted worktree to the targeted tabs and unions later targets', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set<string>()

    applyBackgroundMountTabRestriction(restrictions, mounted, 'wt-1', ['tab-1'])
    expect(restrictions.get('wt-1')).toEqual(new Set(['tab-1']))

    mounted.add('wt-1')
    applyBackgroundMountTabRestriction(restrictions, mounted, 'wt-1', ['tab-2', 'tab-1'])
    expect(restrictions.get('wt-1')).toEqual(new Set(['tab-1', 'tab-2']))
  })

  it('never narrows a fully mounted worktree retroactively', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set(['wt-visited'])

    applyBackgroundMountTabRestriction(restrictions, mounted, 'wt-visited', ['tab-1'])
    expect(restrictions.has('wt-visited')).toBe(false)
  })

  it('lifts the restriction on an untargeted (whole-worktree) mount', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([['wt-1', new Set(['tab-1'])]])
    const mounted = new Set(['wt-1'])

    applyBackgroundMountTabRestriction(restrictions, mounted, 'wt-1', undefined)
    expect(restrictions.has('wt-1')).toBe(false)
  })
})

describe('pruneClosedBackgroundMountTabs', () => {
  it('retains live targets and releases the mount after the final target closes', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([
      ['wt-1', new Set(['tab-1', 'tab-2'])]
    ])
    const mounted = new Set(['wt-1'])

    expect(
      pruneClosedBackgroundMountTabs(restrictions, mounted, {
        'wt-1': [{ id: 'tab-2' }, { id: 'unrelated-tab' }]
      })
    ).toBe(true)
    expect(restrictions.get('wt-1')).toEqual(new Set(['tab-2']))
    expect(mounted.has('wt-1')).toBe(true)

    expect(pruneClosedBackgroundMountTabs(restrictions, mounted, { 'wt-1': [] })).toBe(true)
    expect(restrictions.has('wt-1')).toBe(false)
    expect(mounted.has('wt-1')).toBe(false)
  })

  it('leaves unrestricted user-visited and whole-worktree mounts alone', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set(['wt-visited', 'wt-whole'])

    expect(pruneClosedBackgroundMountTabs(restrictions, mounted, {})).toBe(false)
    expect(mounted).toEqual(new Set(['wt-visited', 'wt-whole']))
  })

  it('keeps an activation mounted when its last allowed tab closes before deferred tabs', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([['wt-1', new Set(['tab-visible'])]])
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>([
      ['wt-1', new Set(['tab-deferred', 'tab-closed'])]
    ])
    const mounted = new Set(['wt-1'])

    expect(
      pruneClosedBackgroundMountTabs(
        restrictions,
        mounted,
        { 'wt-1': [{ id: 'tab-deferred' }] },
        deferredMountTabIdsByWorktree
      )
    ).toBe(true)
    expect(restrictions.get('wt-1')).toEqual(new Set())
    expect(deferredMountTabIdsByWorktree.get('wt-1')).toEqual(new Set(['tab-deferred']))
    expect(mounted.has('wt-1')).toBe(true)
  })
})

describe('cold activation tab deferral', () => {
  const tabIds = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `tab-${index + 1}`)

  it('keeps live, previously allowed, and non-deferrable tabs mounted', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([['wt-1', new Set(['tab-2'])]])
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    const deferring = planColdActivationTabDeferral({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: 'wt-1',
      allTabIds: tabIds(12),
      isTabLive: (tabId) => tabId === 'tab-5',
      // Why: a tab parked byte watchers cannot cover must mount immediately.
      isTabDeferrable: (tabId) => tabId !== 'tab-9',
      immediateTabIds: new Set(['tab-1'])
    })
    expect(deferring).toBe(true)
    expect(restrictions.get('wt-1')).toEqual(new Set(['tab-1', 'tab-2', 'tab-5', 'tab-9']))
  })

  it('mounts legacy PTYs eagerly while deferring snapshot-capable siblings', async () => {
    const worktreeId = 'wt-1'
    const allTabIds = tabIds(7)
    const ptyIdByTabId = new Map(
      allTabIds.map((tabId) => [tabId, `${worktreeId}@@${tabId}-session`])
    )
    const legacyPtyId = ptyIdByTabId.get('tab-2')!
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([...ptyIdByTabId.values()], async (ids) =>
      ids.map((id) => ({ id, authoritative: id !== legacyPtyId }))
    )
    const restrictions = new Map<string, ReadonlySet<string>>()
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()

    const deferring = planColdActivationTabDeferral({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId,
      allTabIds,
      isTabLive: () => false,
      isTabDeferrable: (tabId) => {
        const ptyId = ptyIdByTabId.get(tabId) ?? null
        return (
          isSnapshotBackedTerminalPty(ptyId, worktreeId) &&
          ptyId !== null &&
          terminalProviderHasAuthoritativeSnapshot(ptyId)
        )
      },
      immediateTabIds: new Set(['tab-1'])
    })

    expect(deferring).toBe(true)
    expect(restrictions.get(worktreeId)).toEqual(new Set(['tab-1', 'tab-2']))
    expect(deferredMountTabIdsByWorktree.get(worktreeId)).toEqual(
      new Set(['tab-3', 'tab-4', 'tab-5', 'tab-6', 'tab-7'])
    )
  })

  it('reveals newly visible tabs and lifts the restriction once all are revealed', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([['wt-1', new Set(['tab-1'])]])
    const allTabIds = tabIds(3)
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>([
      ['wt-1', new Set(['tab-2', 'tab-3'])]
    ])

    revealActivationDeferredTabs({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: 'wt-1',
      allTabIds,
      immediateTabIds: new Set(['tab-2'])
    })
    expect(restrictions.get('wt-1')).toEqual(new Set(['tab-1', 'tab-2']))
    expect(deferredMountTabIdsByWorktree.get('wt-1')).toEqual(new Set(['tab-3']))

    const unchanged = restrictions.get('wt-1')
    revealActivationDeferredTabs({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: 'wt-1',
      allTabIds,
      immediateTabIds: new Set(['tab-2'])
    })
    expect(restrictions.get('wt-1')).toBe(unchanged)

    revealActivationDeferredTabs({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: 'wt-1',
      allTabIds,
      immediateTabIds: new Set(['tab-3'])
    })
    expect(restrictions.has('wt-1')).toBe(false)
    expect(deferredMountTabIdsByWorktree.has('wt-1')).toBe(false)
  })

  it('does not reveal a targeted background restriction as activation deferral', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([['wt-1', new Set(['tab-1'])]])
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    revealActivationDeferredTabs({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: 'wt-1',
      allTabIds: tabIds(3),
      immediateTabIds: new Set(['tab-2'])
    })
    expect(restrictions.get('wt-1')).toEqual(new Set(['tab-1']))
    expect(deferredMountTabIdsByWorktree.has('wt-1')).toBe(false)
  })
})
