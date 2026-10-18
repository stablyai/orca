import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelPendingPaneSizeRefreshFrames, createExpandCollapseActions } from './expand-collapse'

type ExpandCollapseStateForTest = Parameters<typeof createExpandCollapseActions>[0]

function ref<T>(current: T): React.MutableRefObject<T> {
  return { current }
}

function createState(
  overrides: Partial<ExpandCollapseStateForTest> = {}
): ExpandCollapseStateForTest {
  return {
    expandedPaneIdRef: ref(null),
    expandedStyleSnapshotRef: ref(new Map()),
    containerRef: ref(null),
    managerRef: ref(null),
    pendingPaneSizeRefreshFrameIdsRef: ref([]),
    setExpandedPaneId: vi.fn(),
    setTabPaneExpanded: vi.fn(),
    tabId: 'tab-1',
    persistLayoutSnapshot: vi.fn(),
    ...overrides
  }
}

describe('createExpandCollapseActions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cancels pending pane-size refresh frames', () => {
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 42)
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const state = createState()

    createExpandCollapseActions(state).refreshPaneSizes(true)

    expect(state.pendingPaneSizeRefreshFrameIdsRef.current).toEqual([42])

    cancelPendingPaneSizeRefreshFrames(state)

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
    expect(state.pendingPaneSizeRefreshFrameIdsRef.current).toEqual([])
  })

  it('forgets completed pane-size refresh frames', () => {
    const callbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((next: FrameRequestCallback) => {
        callbacks.push(next)
        return 7
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const state = createState({
      managerRef: ref({
        getPanes: () => [],
        getActivePane: () => null
      } as never)
    })

    createExpandCollapseActions(state).refreshPaneSizes(false)

    expect(state.pendingPaneSizeRefreshFrameIdsRef.current).toEqual([7])

    const callback = callbacks[0]
    if (!callback) {
      throw new Error('expected pane-size refresh frame to be scheduled')
    }
    callback(16)

    expect(state.pendingPaneSizeRefreshFrameIdsRef.current).toEqual([])
  })

  it('does not retain synchronously completed pane-size refresh frames', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(16)
        return 9
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const state = createState()

    createExpandCollapseActions(state).refreshPaneSizes(false)

    expect(state.pendingPaneSizeRefreshFrameIdsRef.current).toEqual([])
  })

  it('restores the pre-expand split styles before persisting a collapse', () => {
    const sibling = { style: { display: 'none', flex: '1 1 auto' } }
    const styleAtPersist: string[] = []
    const state = createState({
      expandedPaneIdRef: ref(3),
      expandedStyleSnapshotRef: ref(
        new Map([[sibling as unknown as HTMLElement, { display: '', flex: '0.7 1 0%' }]])
      ),
      persistLayoutSnapshot: vi.fn(() => {
        styleAtPersist.push(`${sibling.style.display}|${sibling.style.flex}`)
      })
    })

    createExpandCollapseActions(state).setExpandedPane(null)

    expect(styleAtPersist).toEqual(['|0.7 1 0%'])
    expect(state.expandedPaneIdRef.current).toBeNull()
  })
})
