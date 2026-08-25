import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { createWebSessionTabsNotificationReconciler } from './web-session-tabs-notification-reconciler'

function snapshot(
  worktree: string,
  snapshotVersion: number,
  publicationEpoch = 'epoch-1'
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

describe('web session-tabs notification reconciler', () => {
  it('seeds a cold frame, ignores exact replay, and observes the next version', () => {
    const observeAcceptedSnapshot = vi.fn()
    const reconciler = createWebSessionTabsNotificationReconciler({
      trackedWorktrees: [],
      getPaneKeys: () => [],
      observeAcceptedSnapshot
    })

    reconciler.observeSnapshot(snapshot('wt-a', 1))
    reconciler.observeSnapshot(snapshot('wt-a', 1))
    reconciler.observeSnapshot(snapshot('wt-a', 2))

    expect(observeAcceptedSnapshot).toHaveBeenNthCalledWith(1, expect.anything(), {
      seedOnly: true,
      attentionRequired: false,
      paneEvidenceByKey: expect.any(Map)
    })
    expect(observeAcceptedSnapshot).toHaveBeenNthCalledWith(2, expect.anything(), {
      seedOnly: false,
      attentionRequired: false,
      paneEvidenceByKey: expect.any(Map)
    })
    expect(observeAcceptedSnapshot).toHaveBeenCalledTimes(2)
  })

  it('carries hidden attention only for an armed fresh transition', () => {
    const observeAcceptedSnapshot = vi.fn()
    const reconciler = createWebSessionTabsNotificationReconciler({
      trackedWorktrees: [],
      getPaneKeys: () => [],
      observeAcceptedSnapshot
    })

    reconciler.observeInventory([snapshot('wt-a', 1)], { armPublished: true })
    reconciler.beginVisibilityResume()
    reconciler.observeInventory([snapshot('wt-a', 2)], { armPublished: true })

    expect(observeAcceptedSnapshot).toHaveBeenNthCalledWith(1, expect.anything(), {
      seedOnly: true,
      attentionRequired: false,
      paneEvidenceByKey: expect.any(Map)
    })
    expect(observeAcceptedSnapshot).toHaveBeenNthCalledWith(2, expect.anything(), {
      seedOnly: false,
      attentionRequired: true,
      paneEvidenceByKey: expect.any(Map)
    })
  })

  it('makes a same-ID reappearance cold after authoritative absence', () => {
    const observeAcceptedSnapshot = vi.fn()
    const reconciler = createWebSessionTabsNotificationReconciler({
      trackedWorktrees: [{ worktree: 'wt-a', freshness: snapshot('wt-a', 1) }],
      getPaneKeys: () => [],
      observeAcceptedSnapshot
    })

    reconciler.observeInventory([], { armPublished: false })
    reconciler.observeSnapshot(snapshot('wt-a', 1, 'epoch-2'))

    expect(observeAcceptedSnapshot).toHaveBeenCalledWith(expect.anything(), {
      seedOnly: true,
      attentionRequired: false,
      paneEvidenceByKey: expect.any(Map)
    })
  })

  it('does not couple one worktree observation to another', () => {
    const observed: string[] = []
    const reconciler = createWebSessionTabsNotificationReconciler({
      trackedWorktrees: [
        { worktree: 'wt-a', freshness: snapshot('wt-a', 1) },
        { worktree: 'wt-b', freshness: snapshot('wt-b', 1) }
      ],
      getPaneKeys: () => [],
      observeAcceptedSnapshot: (value) => observed.push(value.worktree)
    })

    reconciler.observeSnapshot(snapshot('wt-b', 2))

    expect(observed).toEqual(['wt-b'])
  })
})
