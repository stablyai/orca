// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SplitTerminalPaneDetail } from '@/constants/terminal'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'
import type { PtyConnectionDeps } from './pty-connection-types'
import { BACKGROUND_WORKTREE_MEASURE_WINDOW_MS } from '../terminal/background-terminal-worktree-visibility'
import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  cancelQueuedTerminalPaneSplitRequests,
  dispatchTerminalPaneSplitRequest,
  hasTerminalPaneSplitMountLease,
  queueTerminalPaneSplitRequest,
  registerTerminalPaneSplitRequestHandler,
  resolveTerminalPaneSplitSourceId,
  takeQueuedTerminalPaneSplitRequests,
  TERMINAL_PANE_SPLIT_QUEUE_CAPACITY
} from './terminal-pane-split-request-routing'

const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'

function splitRequest(tabId: string, paneRuntimeId = 9): SplitTerminalPaneDetail {
  return {
    tabId,
    paneRuntimeId,
    sourceLeafId: SOURCE_LEAF_ID,
    direction: 'vertical'
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  _resetTerminalPaneSplitRequestRoutingForTests()
})

afterEach(() => {
  _resetTerminalPaneSplitRequestRoutingForTests()
  vi.useRealTimers()
})

describe('parked terminal split request routing', () => {
  it('forwards the initial ratio through the actual mount handler and ignores a repeated leaf', () => {
    const manager = new PaneManager(document.createElement('div'), { linkOpenHint: () => '' })
    const ptyDeps: PtyConnectionDeps = {
      tabId: 'tab-parked',
      worktreeId: 'repo::/workspace',
      mountFollowsTerminalPark: false,
      paneTransportsRef: { current: new Map() },
      paneMode2031Ref: { current: new Map() },
      paneKittyKeyboardModesRef: { current: new Map() },
      paneLastThemeModeRef: { current: new Map() },
      replayingPanesRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      onPtyExitRef: { current: vi.fn() },
      onAgentExitedRef: { current: vi.fn() },
      clearTabPtyId: vi.fn(),
      consumeSuppressedPtyExit: () => false,
      isPtyShutdownPending: () => false,
      updateTabTitle: vi.fn(),
      setRuntimePaneTitle: vi.fn(),
      clearRuntimePaneTitle: vi.fn(),
      updateTabPtyId: vi.fn(),
      markWorktreeUnread: vi.fn(),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn(),
      clearWorktreeUnread: vi.fn(),
      clearTerminalTabUnread: vi.fn(),
      clearTerminalPaneUnread: vi.fn(),
      onShowSessionRestoredBanner: vi.fn(),
      dispatchNotification: vi.fn(),
      setCacheTimerStartedAt: vi.fn(),
      syncPanePtyLayoutBinding: vi.fn(),
      clearExitedPanePtyLayoutBinding: vi.fn()
    }
    let mounted = false
    vi.spyOn(manager, 'getNumericIdForLeaf').mockImplementation((leaf) =>
      leaf === SOURCE_LEAF_ID ? 7 : mounted ? 8 : null
    )
    const splitPane = vi.spyOn(manager, 'splitPane').mockImplementation(() => {
      expect(ptyDeps.startup).toEqual({ command: 'printf startup-once' })
      mounted = true
      return null
    })
    const mountDeps = {
      tabId: 'tab-parked',
      worktreeId: 'repo::/workspace',
      isActive: false,
      managerRef: { current: manager },
      persistLayoutSnapshot: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    }
    const cleanup = installTerminalPaneMountEvents({ manager, ptyDeps, deps: mountDeps })
    const request = {
      ...splitRequest('tab-parked'),
      worktreeId: 'repo::/workspace',
      newLeafId: '22222222-2222-4222-8222-222222222222',
      ptyId: 'pty-new',
      ratio: 0.85,
      command: 'printf startup-once'
    }
    dispatchTerminalPaneSplitRequest(request)
    dispatchTerminalPaneSplitRequest(request)
    expect(splitPane).toHaveBeenCalledExactlyOnceWith(7, 'vertical', {
      ratio: 0.85,
      leafId: request.newLeafId,
      ptyId: 'pty-new'
    })
    expect(ptyDeps.startup).toBeNull()
    cleanup()
    manager.destroy()
  })

  it('demonstrates that the legacy fire-and-forget event is lost before a parked pane mounts', () => {
    const handler = vi.fn()

    dispatchTerminalPaneSplitRequest(splitRequest('tab-parked'))
    const unregister = registerTerminalPaneSplitRequestHandler('tab-parked', undefined, handler)

    expect(handler).not.toHaveBeenCalled()
    unregister()
  })

  it('replays a parked-tab request as soon as that exact pane lifecycle registers', () => {
    const request = splitRequest('tab-parked', 91)
    const splitPane = vi.fn()
    queueTerminalPaneSplitRequest(request)

    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(true)
    expect(splitPane).not.toHaveBeenCalled()

    const unregister = registerTerminalPaneSplitRequestHandler(
      'tab-parked',
      undefined,
      (detail) => {
        const sourcePaneId = resolveTerminalPaneSplitSourceId(detail, (leafId) =>
          leafId === SOURCE_LEAF_ID ? 7 : null
        )
        splitPane(sourcePaneId, detail.direction)
      }
    )

    expect(splitPane).toHaveBeenCalledOnce()
    expect(splitPane).toHaveBeenCalledWith(7, 'vertical')
    expect(takeQueuedTerminalPaneSplitRequests('tab-parked')).toEqual([])
    // The stable leaf wins over the pre-park numeric pane id reminted by the mount.
    expect(splitPane).not.toHaveBeenCalledWith(91, expect.anything())
    unregister()
  })

  it('fails closed when a remount no longer contains the stable source leaf', () => {
    expect(resolveTerminalPaneSplitSourceId(splitRequest('tab-parked', 91), () => null)).toBe(-1)
  })

  it('keeps the mount lease through replay, then releases it at the existing measure bound', () => {
    queueTerminalPaneSplitRequest(splitRequest('tab-parked'))
    takeQueuedTerminalPaneSplitRequests('tab-parked')

    vi.advanceTimersByTime(BACKGROUND_WORKTREE_MEASURE_WINDOW_MS - 1)
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(true)

    vi.advanceTimersByTime(1)
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(false)
  })

  it('cancels queued work and its mount lease when the target tab closes', () => {
    queueTerminalPaneSplitRequest(splitRequest('tab-closed'))

    cancelQueuedTerminalPaneSplitRequests('tab-closed')

    expect(takeQueuedTerminalPaneSplitRequests('tab-closed')).toEqual([])
    expect(hasTerminalPaneSplitMountLease('tab-closed')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds both queued requests and leased target tabs', () => {
    for (let index = 0; index <= TERMINAL_PANE_SPLIT_QUEUE_CAPACITY; index += 1) {
      queueTerminalPaneSplitRequest(splitRequest(`tab-${index}`))
    }

    expect(takeQueuedTerminalPaneSplitRequests('tab-0')).toEqual([])
    expect(hasTerminalPaneSplitMountLease('tab-0')).toBe(false)
    expect(
      takeQueuedTerminalPaneSplitRequests(`tab-${TERMINAL_PANE_SPLIT_QUEUE_CAPACITY}`)
    ).toEqual([splitRequest(`tab-${TERMINAL_PANE_SPLIT_QUEUE_CAPACITY}`)])
    expect(vi.getTimerCount()).toBe(TERMINAL_PANE_SPLIT_QUEUE_CAPACITY)
  })

  it('replays same tab ids only to their owning worktree handlers', () => {
    queueTerminalPaneSplitRequest({ ...splitRequest('tab-shared'), worktreeId: 'repo::/one' })
    queueTerminalPaneSplitRequest({ ...splitRequest('tab-shared'), worktreeId: 'repo::/two' })
    const first = vi.fn()
    const second = vi.fn()

    const unregisterFirst = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/one',
      first
    )
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: 'repo::/one' }))
    expect(second).not.toHaveBeenCalled()

    const unregisterSecond = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/two',
      second
    )
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: 'repo::/two' }))
    unregisterFirst()
    unregisterSecond()
  })
})
