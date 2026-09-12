// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { useRefitOnSplitCollapse } from './use-refit-on-split-collapse'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  let requestAnimationFrameMock: ReturnType<typeof vi.fn>

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
    onSyncFit = (): void => {
      dispatched += 1
    }
    window.addEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    requestAnimationFrameMock = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock)
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
    expect(dispatched).toBe(1)
    expect(requestAnimationFrameMock).not.toHaveBeenCalled()
  })

  it('dispatches when a nested split loses one leaf', () => {
    renderLayout(SPLIT_3)
    renderLayout(SPLIT_2)
    expect(dispatched).toBe(1)
  })

  it('does not dispatch when the leaf count increases (a split is created)', () => {
    renderLayout(LEAF)
    renderLayout(SPLIT_2)
    expect(dispatched).toBe(0)
  })

  it('does not dispatch when the leaf count is unchanged (e.g. ratio drag)', () => {
    renderLayout(SPLIT_2)
    renderLayout({ ...SPLIT_2, ratio: 0.3 })
    expect(dispatched).toBe(0)
  })

  it('does not dispatch when the worktree is not active', () => {
    renderLayout(SPLIT_2, false)
    renderLayout(LEAF, false)
    expect(dispatched).toBe(0)
  })
})
