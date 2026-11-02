// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SplitTerminalPaneDetail } from '@/constants/terminal'
import { BACKGROUND_WORKTREE_MEASURE_WINDOW_MS } from '../terminal/background-terminal-worktree-visibility'
import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  cancelQueuedTerminalPaneSplitForLeaf,
  cancelQueuedTerminalPaneSplitRequests,
  dispatchTerminalPaneSplitRequest,
  hasTerminalPaneSplitMountLease,
  queueTerminalPaneSplitRequest,
  registerTerminalPaneSplitRequestHandler,
  resolveTerminalPaneSplitSourceId,
  takeQueuedTerminalPaneSplitRequests,
  TERMINAL_PANE_SPLIT_QUEUE_CAPACITY,
  withoutQueuedMainSplits
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

describe('withoutQueuedMainSplits', () => {
  const SOURCE = '11111111-1111-4111-8111-111111111111'
  const NEW = '22222222-2222-4222-8222-222222222222'
  const layout = {
    root: {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: SOURCE },
      second: { type: 'leaf' as const, leafId: NEW }
    },
    activeLeafId: SOURCE,
    expandedLeafId: null
  }

  it('leaves out a pane whose queued split main asked for, so that request mounts it with its command', () => {
    _resetTerminalPaneSplitRequestRoutingForTests()
    queueTerminalPaneSplitRequest({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneRuntimeId: 1,
      sourceLeafId: SOURCE,
      direction: 'vertical',
      newLeafId: NEW,
      command: 'make test'
    })

    expect(withoutQueuedMainSplits(layout, 'tab-1', 'wt-1').root).toEqual({
      type: 'leaf',
      leafId: SOURCE
    })
    expect(withoutQueuedMainSplits(layout, 'tab-2', 'wt-1')).toBe(layout)
    expect(takeQueuedTerminalPaneSplitRequests('tab-1', 'wt-1')[0]).toMatchObject({
      newLeafId: NEW,
      command: 'make test'
    })
    expect(withoutQueuedMainSplits(layout, 'tab-1', 'wt-1')).toBe(layout)
    _resetTerminalPaneSplitRequestRoutingForTests()
  })
})

describe('cancelQueuedTerminalPaneSplitForLeaf', () => {
  const split = (newLeafId: string): SplitTerminalPaneDetail => ({
    ...splitRequest('tab-parked'),
    worktreeId: 'wt-1',
    newLeafId
  })

  it('drops only the closed pane’s split, and the lease with the tab’s last one', () => {
    queueTerminalPaneSplitRequest(split('leaf-a'))
    queueTerminalPaneSplitRequest(split('leaf-b'))

    cancelQueuedTerminalPaneSplitForLeaf('tab-parked', 'leaf-a')
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(true)
    cancelQueuedTerminalPaneSplitForLeaf('tab-other', 'leaf-b')
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(true)

    cancelQueuedTerminalPaneSplitForLeaf('tab-parked', 'leaf-b')
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(false)
    expect(takeQueuedTerminalPaneSplitRequests('tab-parked', 'wt-1')).toEqual([])
  })

  it('keeps the lease of another split still waiting there', () => {
    queueTerminalPaneSplitRequest(split('leaf-a'))
    queueTerminalPaneSplitRequest(split('leaf-b'))

    cancelQueuedTerminalPaneSplitForLeaf('tab-parked', 'leaf-b')

    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(true)
    expect(
      takeQueuedTerminalPaneSplitRequests('tab-parked', 'wt-1').map((r) => r.newLeafId)
    ).toEqual(['leaf-a'])
  })
})
