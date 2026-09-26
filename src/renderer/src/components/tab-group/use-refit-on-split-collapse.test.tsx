// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { useRefitOnSplitCollapse } from './use-refit-on-split-collapse'

const LEAF: TabGroupLayoutNode = { type: 'leaf', groupId: 'a' }
const SPLIT_2: TabGroupLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', groupId: 'a' },
  second: { type: 'leaf', groupId: 'b' }
}
const SPLIT_3: TabGroupLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', groupId: 'a' },
  second: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', groupId: 'b' },
    second: { type: 'leaf', groupId: 'c' }
  }
}

function Probe({
  layout,
  isWorktreeActive
}: {
  layout: TabGroupLayoutNode
  isWorktreeActive: boolean
}): null {
  useRefitOnSplitCollapse(layout, isWorktreeActive)
  return null
}

describe('useRefitOnSplitCollapse', () => {
  let container: HTMLDivElement
  let root: Root
  let dispatched: number
  let onSyncFit: () => void
  // Two-deep rAF callback queue so the double-rAF resolves deterministically.
  let rafCallbacks: FrameRequestCallback[]

  const flushRaf = (): void => {
    // Drain in waves so a callback scheduled by another callback runs next tick.
    let guard = 0
    while (rafCallbacks.length > 0 && guard < 10) {
      const batch = rafCallbacks
      rafCallbacks = []
      for (const cb of batch) {
        cb(performance.now())
      }
      guard += 1
    }
  }

  const renderLayout = (layout: TabGroupLayoutNode, isWorktreeActive = true): void => {
    act(() => {
      root.render(<Probe layout={layout} isWorktreeActive={isWorktreeActive} />)
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    dispatched = 0
    rafCallbacks = []
    onSyncFit = (): void => {
      dispatched += 1
    }
    window.addEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    window.removeEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('dispatches SYNC_FIT_PANES_EVENT when a split collapses to fewer leaves', () => {
    renderLayout(SPLIT_2)
    expect(dispatched).toBe(0)

    renderLayout(LEAF)
    flushRaf()
    expect(dispatched).toBe(1)
  })

  it('dispatches when a nested split loses one leaf', () => {
    renderLayout(SPLIT_3)
    renderLayout(SPLIT_2)
    flushRaf()
    expect(dispatched).toBe(1)
  })

  it('does not dispatch when the leaf count increases (a split is created)', () => {
    renderLayout(LEAF)
    renderLayout(SPLIT_2)
    flushRaf()
    expect(dispatched).toBe(0)
  })

  it('does not dispatch when the leaf count is unchanged (e.g. ratio drag)', () => {
    renderLayout(SPLIT_2)
    renderLayout({ ...SPLIT_2, ratio: 0.3 })
    flushRaf()
    expect(dispatched).toBe(0)
  })

  it('does not dispatch when the worktree is not active', () => {
    renderLayout(SPLIT_2, false)
    renderLayout(LEAF, false)
    flushRaf()
    expect(dispatched).toBe(0)
  })
})
