// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExpandCollapseActions } from './expand-collapse'

afterEach(() => vi.unstubAllGlobals())

describe('revealing expanded layouts during pane navigation', () => {
  it('restores sibling DOM visibility without scheduling a focus takeover', () => {
    const sibling = document.createElement('div')
    sibling.style.display = 'none'
    const context: Parameters<typeof createExpandCollapseActions>[0] = {
      expandedPaneIdRef: { current: 7 },
      expandedStyleSnapshotRef: {
        current: new Map([[sibling, { display: 'flex', flex: '1 1 0%' }]])
      },
      containerRef: { current: null },
      managerRef: { current: null },
      setExpandedPaneId: vi.fn(),
      setTabPaneExpanded: vi.fn(),
      pendingPaneSizeRefreshFrameIdsRef: { current: [] },
      tabId: 'target',
      persistLayoutSnapshot: vi.fn()
    }
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 17)
    )
    createExpandCollapseActions(context).collapseExpandedPane()
    expect(sibling.style.display).toBe('flex')
    expect(context.expandedPaneIdRef.current).toBeNull()
    expect(context.setTabPaneExpanded).toHaveBeenCalledWith('target', false)
    expect(context.expandedStyleSnapshotRef.current.size).toBe(0)
  })

  it('leaves an already expanded-free layout untouched', () => {
    const context: Parameters<typeof createExpandCollapseActions>[0] = {
      expandedPaneIdRef: { current: null },
      expandedStyleSnapshotRef: { current: new Map() },
      containerRef: { current: null },
      managerRef: { current: null },
      setExpandedPaneId: vi.fn(),
      setTabPaneExpanded: vi.fn(),
      pendingPaneSizeRefreshFrameIdsRef: { current: [] },
      tabId: 'target',
      persistLayoutSnapshot: vi.fn()
    }
    createExpandCollapseActions(context).collapseExpandedPane()
    expect(context.persistLayoutSnapshot).not.toHaveBeenCalled()
    expect(context.setTabPaneExpanded).not.toHaveBeenCalled()
  })
})
