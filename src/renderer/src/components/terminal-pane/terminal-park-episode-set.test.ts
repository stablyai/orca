import { describe, expect, it } from 'vitest'
import {
  acknowledgeTerminalParkEpisodeSet,
  reconcileTerminalParkEpisodeSet,
  selectAcknowledgedTerminalParkEpisodeUnmounts,
  selectCurrentTerminalParkEpisodeUnmounts,
  selectTerminalParkEpisodeWatcherTabIds,
  type TerminalParkEpisodeSet,
  type TerminalParkEpisodeTab
} from './terminal-park-episode-set'
import type {
  TerminalParkedWatcherBlockedPlan,
  TerminalParkedWatcherCoveredPlan,
  TerminalParkedWatcherPendingPlan
} from './terminal-parked-watcher-coverage-plan'

const WORKTREE_ID = 'worktree-1'
const TAB_ID = 'tab-1'
const OTHER_TAB_ID = 'tab-2'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function tab(id = TAB_ID): TerminalParkEpisodeTab {
  return { id, ptyId: `pty-${id}`, generation: 1 }
}

function coveredPlan(materialKey: string, tabId = TAB_ID): TerminalParkedWatcherCoveredPlan {
  return {
    status: 'covered',
    materialKey,
    worktreeId: WORKTREE_ID,
    tabId,
    tabPtyId: `pty-${tabId}`,
    generation: 1,
    panes: [{ leafId: LEAF_ID, ptyId: `pty-${tabId}` }]
  }
}

function pendingPlan(materialKey: string): TerminalParkedWatcherPendingPlan {
  return {
    ...coveredPlan(materialKey),
    status: 'pending',
    issue: { reason: 'provider-capability-pending' }
  }
}

function blockedPlan(materialKey: string): TerminalParkedWatcherBlockedPlan {
  return {
    ...coveredPlan(materialKey),
    status: 'blocked',
    issue: { reason: 'provider-snapshot-unavailable' }
  }
}

function rejectRequestedLease(
  current: TerminalParkEpisodeSet,
  plan: TerminalParkedWatcherCoveredPlan
): TerminalParkEpisodeSet {
  const requested = reconcileTerminalParkEpisodeSet({
    current,
    tabs: [tab()],
    requestedTabIds: new Set([TAB_ID]),
    plan: () => plan
  })
  return acknowledgeTerminalParkEpisodeSet(requested.leases, [
    {
      status: 'failed',
      tabId: TAB_ID,
      materialKey: plan.materialKey,
      reason: 'watcher-coverage-incomplete',
      expectedPtyIds: [`pty-${TAB_ID}`],
      watchedPtyIds: []
    }
  ]).leases
}

describe('terminal park episode set', () => {
  it('unmounts a covered request', () => {
    const plan = coveredPlan('key-1')
    const result = reconcileTerminalParkEpisodeSet({
      current: new Map(),
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID]),
      plan: () => plan
    })

    expect(result.leases.get(TAB_ID)).toMatchObject({ phase: 'requested', plan })
    expect(result.plansByTabId.get(TAB_ID)).toBe(plan)
    expect(result.unmountTabIds).toEqual(new Set([TAB_ID]))
  })

  it('keeps a same-key rejection mounted across reconciliation', () => {
    const plan = coveredPlan('key-1')
    const rejected = rejectRequestedLease(new Map(), plan)
    const result = reconcileTerminalParkEpisodeSet({
      current: rejected,
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID]),
      plan: () => plan
    })

    expect(result.leases).toBe(rejected)
    expect(result.leases.get(TAB_ID)?.phase).toBe('rejected')
    expect(result.unmountTabIds).toEqual(new Set())
  })

  it('rearms a rejected episode when its material key changes', () => {
    const rejected = rejectRequestedLease(new Map(), coveredPlan('key-1'))
    const result = reconcileTerminalParkEpisodeSet({
      current: rejected,
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID]),
      plan: () => coveredPlan('key-2')
    })

    expect(result.leases.get(TAB_ID)).toMatchObject({
      phase: 'requested',
      plan: { materialKey: 'key-2' }
    })
    expect(result.unmountTabIds).toEqual(new Set([TAB_ID]))
  })

  it('refuses a stale lease key before reconciliation', () => {
    const requested = reconcileTerminalParkEpisodeSet({
      current: new Map(),
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID]),
      plan: () => coveredPlan('key-1')
    })

    expect(
      selectCurrentTerminalParkEpisodeUnmounts({
        leases: requested.leases,
        plansByTabId: new Map([[TAB_ID, coveredPlan('key-2')]]),
        requestedTabIds: new Set([TAB_ID])
      })
    ).toEqual(new Set())
  })

  it('does not commit an acknowledgement-required request before watcher coverage', () => {
    const plan = coveredPlan('key-1')
    const requested = reconcileTerminalParkEpisodeSet({
      current: new Map(),
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID]),
      plan: () => plan
    })
    const selectUnmounts = (leases: TerminalParkEpisodeSet): Set<string> =>
      selectAcknowledgedTerminalParkEpisodeUnmounts({
        leases,
        plansByTabId: requested.plansByTabId,
        requestedTabIds: new Set([TAB_ID]),
        acknowledgementRequiredTabIds: new Set([TAB_ID])
      })

    expect(selectUnmounts(requested.leases)).toEqual(new Set())

    const covering = acknowledgeTerminalParkEpisodeSet(requested.leases, [
      {
        status: 'covering',
        tabId: TAB_ID,
        materialKey: plan.materialKey,
        watchedPtyIds: [`pty-${TAB_ID}`]
      }
    ])
    expect(selectUnmounts(covering.leases)).toEqual(new Set([TAB_ID]))
  })

  it('keeps a newly covering deferred watcher across stale rendered state', () => {
    const plan = coveredPlan('key-1')
    const requested = reconcileTerminalParkEpisodeSet({
      current: new Map(),
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID]),
      plan: () => plan
    })
    const covering = acknowledgeTerminalParkEpisodeSet(requested.leases, [
      {
        status: 'covering',
        tabId: TAB_ID,
        materialKey: plan.materialKey,
        watchedPtyIds: [`pty-${TAB_ID}`]
      }
    ])

    expect(
      selectTerminalParkEpisodeWatcherTabIds({
        worktreeId: WORKTREE_ID,
        tabIds: [TAB_ID],
        leases: covering.leases,
        plansByTabId: requested.plansByTabId,
        renderedUnmountTabIds: new Set(),
        activationDeferredTabIds: new Set([TAB_ID])
      })
    ).toEqual(new Set([TAB_ID]))
  })

  it('does not start a newly requested ordinary watcher before its unmount render', () => {
    const requested = reconcileTerminalParkEpisodeSet({
      current: new Map(),
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID]),
      plan: () => coveredPlan('key-1')
    })

    expect(
      selectTerminalParkEpisodeWatcherTabIds({
        worktreeId: WORKTREE_ID,
        tabIds: [TAB_ID],
        leases: requested.leases,
        plansByTabId: requested.plansByTabId,
        renderedUnmountTabIds: new Set()
      })
    ).toEqual(new Set())
  })

  it('drops a revealed tab from stale rendered watcher state', () => {
    expect(
      selectTerminalParkEpisodeWatcherTabIds({
        worktreeId: WORKTREE_ID,
        tabIds: [TAB_ID],
        leases: new Map(),
        plansByTabId: new Map(),
        renderedUnmountTabIds: new Set([TAB_ID])
      })
    ).toEqual(new Set())
  })

  it.each([
    ['pending', pendingPlan('pending-key')],
    ['blocked', blockedPlan('blocked-key')]
  ] as const)('force-unmounts a %s request', (_status, plan) => {
    const result = reconcileTerminalParkEpisodeSet({
      current: new Map(),
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID]),
      forcedTabIds: new Set([TAB_ID]),
      plan: () => plan
    })

    expect(result.leases.get(TAB_ID)?.phase).toBe('forced')
    expect(result.unmountTabIds).toEqual(new Set([TAB_ID]))
  })

  it('keeps covering acknowledgements render-stable and reports failures', () => {
    const plan = coveredPlan('key-1')
    const requested = reconcileTerminalParkEpisodeSet({
      current: new Map(),
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID]),
      plan: () => plan
    })
    const covering = acknowledgeTerminalParkEpisodeSet(requested.leases, [
      {
        status: 'covering',
        tabId: TAB_ID,
        materialKey: plan.materialKey,
        watchedPtyIds: [`pty-${TAB_ID}`]
      }
    ])
    const failed = acknowledgeTerminalParkEpisodeSet(requested.leases, [
      {
        status: 'failed',
        tabId: TAB_ID,
        materialKey: plan.materialKey,
        reason: 'watcher-start-failed',
        expectedPtyIds: [`pty-${TAB_ID}`],
        watchedPtyIds: []
      }
    ])

    expect(covering.renderChanged).toBe(false)
    expect(covering.leases.get(TAB_ID)?.phase).toBe('covering')
    expect(failed.renderChanged).toBe(true)
    expect(failed.leases.get(TAB_ID)?.phase).toBe('rejected')
  })

  it('drops leases for removed tabs', () => {
    const current = reconcileTerminalParkEpisodeSet({
      current: new Map(),
      tabs: [tab(), tab(OTHER_TAB_ID)],
      requestedTabIds: new Set([TAB_ID, OTHER_TAB_ID]),
      plan: (entry) => coveredPlan(`key-${entry.id}`, entry.id)
    })
    const result = reconcileTerminalParkEpisodeSet({
      current: current.leases,
      tabs: [tab()],
      requestedTabIds: new Set([TAB_ID, OTHER_TAB_ID]),
      plan: () => coveredPlan(`key-${TAB_ID}`)
    })

    expect(result.leases).not.toBe(current.leases)
    expect(Array.from(result.leases.keys())).toEqual([TAB_ID])
    expect(Array.from(result.plansByTabId.keys())).toEqual([TAB_ID])
    expect(result.unmountTabIds).toEqual(new Set([TAB_ID]))
  })
})
