import type { VirtualItem } from '@tanstack/react-virtual'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { makePRRefreshWorktree } from '@/store/slices/github-slice-test-harness'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installWorktreeVisibleRefreshVisibilityListener,
  visibleReviewCardIds,
  installVisibleReviewCardScrollListener
} from './use-visible-review-refresh'

describe('installWorktreeVisibleRefreshVisibilityListener', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('subscribes to document visibility changes so visible PR refresh can rerun on return', () => {
    const listeners = new Map<string, () => void>()
    const onChange = vi.fn()
    const addEventListener = vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener)
    })
    const removeEventListener = vi.fn()

    vi.stubGlobal('document', {
      addEventListener,
      removeEventListener
    })

    const cleanup = installWorktreeVisibleRefreshVisibilityListener(onChange)

    expect(addEventListener).toHaveBeenCalledWith('visibilitychange', onChange)
    listeners.get('visibilitychange')?.()
    expect(onChange).toHaveBeenCalledTimes(1)

    cleanup()
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', onChange)
  })
})

function row(id: string): WorktreeItemRow {
  return {
    type: 'item',
    rowKey: id,
    sectionKey: 'all',
    worktree: makePRRefreshWorktree({ id }),
    repo: {
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '',
      addedAt: 1,
      kind: 'git'
    },
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: true,
    lineageChildCount: 0
  }
}
function virtualItem(index: number): VirtualItem {
  return { key: index, index, start: index * 100, end: (index + 1) * 100, size: 100, lane: 0 }
}

describe('actual visible review cards', () => {
  it('excludes overscan rows and exact viewport boundaries', () => {
    expect(
      visibleReviewCardIds({
        enabled: true,
        renderRows: [row('above'), row('visible'), row('below')],
        virtualItems: [0, 1, 2].map(virtualItem),
        viewportTop: 100,
        viewportHeight: 100
      })
    ).toEqual(['visible'])
  })
  it('includes visible lineage children but excludes offscreen members', () => {
    expect(
      visibleReviewCardIds({
        enabled: true,
        renderRows: [{ type: 'lineage-group', key: 'family', rows: [row('parent'), row('child')] }],
        virtualItems: [virtualItem(0)],
        viewportTop: 0,
        viewportHeight: 100,
        isOnScreen: (id) => id === 'child'
      })
    ).toEqual(['child'])
  })
  it('excludes rows when their review decoration is disabled', () => {
    expect(
      visibleReviewCardIds({
        enabled: false,
        renderRows: [row('visible')],
        virtualItems: [virtualItem(0)],
        viewportTop: 0,
        viewportHeight: 100
      })
    ).toEqual([])
  })
})

describe('scrolling within one virtual lineage row', () => {
  it('updates child visibility on scroll without changing virtual indexes and cancels pending frames', () => {
    const listeners = new Map<string, EventListenerOrEventListenerObject>()
    let frame: FrameRequestCallback = () => {}
    const update = vi.fn()
    const scroll = {
      addEventListener: vi.fn((type: string, callback: EventListenerOrEventListenerObject) => {
        listeners.set(type, callback)
      }),
      removeEventListener: vi.fn()
    }
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback
        return 1
      })
    )
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const cleanup = installVisibleReviewCardScrollListener(scroll, update)
    const listener = listeners.get('scroll')
    if (typeof listener === 'function') {
      listener(new Event('scroll'))
    }
    expect(update).not.toHaveBeenCalled()
    frame(0)
    expect(update).toHaveBeenCalledOnce()
    if (typeof listener === 'function') {
      listener(new Event('scroll'))
    }
    cleanup()
    expect(cancel).toHaveBeenCalledWith(1)
    expect(scroll.removeEventListener).toHaveBeenCalledWith('scroll', listener)
    vi.unstubAllGlobals()
  })
})
