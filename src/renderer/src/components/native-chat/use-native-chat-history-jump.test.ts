// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import {
  nativeChatRailJumpStep,
  useNativeChatHistoryJump,
  type NativeChatHistoryJumpTarget
} from './use-native-chat-history-jump'

type LaneSnapshot = { loaded: number; messages: readonly string[]; streamed: number }

/** Model structured paging: commit before resolving and share pending-page results with concurrent callers. */
function createLane({
  total,
  pageSize,
  initiallyLoaded,
  ghost,
  pageResult = 'applied'
}: {
  total: number
  pageSize: number
  initiallyLoaded: number
  /** Unrenderable outline entry disappears once the window covers its index. */
  ghost?: { id: string; at: number }
  pageResult?: NativeChatOlderPageResult
}) {
  const ids = Array.from({ length: total }, (_, index) => `m${index}`)
  let snapshot: LaneSnapshot = {
    loaded: initiallyLoaded,
    messages: ids.slice(total - initiallyLoaded),
    streamed: 0
  }
  const listeners = new Set<() => void>()
  const emit = (): void => listeners.forEach((listener) => listener())
  const pageGate: { release: (() => void) | null } = { release: null }
  let holdPages = false
  let inFlight: Promise<NativeChatOlderPageResult> | null = null
  const reads = { count: 0 }
  const readPage = async (): Promise<NativeChatOlderPageResult> => {
    reads.count += 1
    if (holdPages) {
      await new Promise<void>((resolve) => {
        pageGate.release = resolve
      })
    }
    await Promise.resolve()
    if (pageResult !== 'applied') {
      return pageResult
    }
    const loaded = Math.min(total, snapshot.loaded + pageSize)
    snapshot = { ...snapshot, loaded, messages: ids.slice(total - loaded) }
    emit()
    return 'applied'
  }
  const loadEarlier = vi.fn((): Promise<NativeChatOlderPageResult> => {
    if (inFlight) {
      return inFlight
    }
    if (snapshot.loaded >= total) {
      return Promise.resolve('exhausted')
    }
    const page = readPage().finally(() => {
      inFlight = null
    })
    inFlight = page
    return page
  })
  const lane = {
    loadEarlier,
    reads,
    holdPages: () => {
      holdPages = true
    },
    releasePage: () => pageGate.release?.(),
    stream: () => {
      snapshot = { ...snapshot, streamed: snapshot.streamed + 1 }
      emit()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot
  }
  const useLaneRailJump = (
    jumpToLoaded: (item: NativeChatRailItem) => void,
    sessionKey = 'session-1',
    isVisible = true
  ) => {
    const current = useSyncExternalStore(lane.subscribe, lane.getSnapshot)
    const items = useMemo<NativeChatRailItem[]>(() => {
      const firstLoaded = total - current.loaded
      const unloaded = ids.slice(0, firstLoaded)
      const outline = ghost && ghost.at < firstLoaded ? [ghost.id, ...unloaded] : unloaded
      return [
        ...outline.map((id) => ({ id, slotIndex: null, text: id, hasImages: false })),
        ...current.messages.map((id, slotIndex) => ({ id, slotIndex, text: id, hasImages: false }))
      ]
    }, [current])
    return useNativeChatHistoryJump({
      step: (target) =>
        target.kind === 'rail' ? nativeChatRailJumpStep(items, target.id, jumpToLoaded) : 'stop',
      sessionKey,
      isVisible,
      loadEarlier: lane.loadEarlier
    })
  }
  return { lane, useLaneRailJump }
}

function outlineItem(id: string): NativeChatHistoryJumpTarget {
  return { kind: 'rail', id }
}

async function releasePage(lane: { releasePage: () => void }): Promise<void> {
  await act(async () => {
    lane.releasePage()
    await Promise.resolve()
  })
}

describe('rail jump through unloaded history', () => {
  it("lets a pick made during another pick's page win, sharing that page", async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.start(outlineItem('m25')))
    await waitFor(() => expect(lane.reads.count).toBe(1))
    act(() => result.current.start(outlineItem('m2')))
    expect(result.current.pending).toEqual(outlineItem('m2'))
    for (let page = 0; page < 3; page += 1) {
      await releasePage(lane)
    }

    await waitFor(() => expect(jumpToLoaded).toHaveBeenCalledTimes(1))
    expect(jumpToLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }))
    expect(lane.reads.count).toBe(3)
  })

  it("aims at a pick made before the previous one's commit settled", async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => {
      result.current.start(outlineItem('m25'))
      result.current.start(outlineItem('m2'))
    })

    await waitFor(() => expect(result.current.pending).toBeNull())
    expect(jumpToLoaded).toHaveBeenCalledTimes(1)
    expect(jumpToLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }))
    expect(lane.reads.count).toBe(3)
  })

  it('abandons the jump when the session changes mid-page', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result, rerender } = renderHook(
      ({ sessionKey }: { sessionKey: string }) => useLaneRailJump(jumpToLoaded, sessionKey),
      { initialProps: { sessionKey: 'session-1' } }
    )

    act(() => result.current.start(outlineItem('m25')))
    await waitFor(() => expect(lane.reads.count).toBe(1))
    rerender({ sessionKey: 'session-2' })
    expect(result.current.pending).toBeNull()
    await releasePage(lane)

    expect(lane.reads.count).toBe(1)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })
})
