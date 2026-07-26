import { afterEach, describe, expect, it, vi } from 'vitest'

function createReactHookHarness() {
  const refs: { current: unknown }[] = []
  const effects: {
    deps: readonly unknown[] | undefined
    effect: () => void | (() => void)
  }[] = []
  let refIndex = 0

  return {
    beginRender: () => {
      refIndex = 0
      effects.length = 0
    },
    effects,
    react: {
      useCallback: <T extends (...args: never[]) => unknown>(callback: T): T => callback,
      useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
        effects.push({ deps, effect })
      },
      useMemo: <T>(factory: () => T): T => factory(),
      useRef: <T>(initialValue: T): { current: T } => {
        const index = refIndex
        refIndex += 1
        refs[index] ??= { current: initialValue }
        return refs[index] as { current: T }
      }
    }
  }
}

describe('useVirtualizedScrollAnchor listener effect dependencies', () => {
  afterEach(() => {
    vi.doUnmock('react')
    vi.resetModules()
  })

  it('does not tear down the scroll listener when row snapshots change', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const { useVirtualizedScrollAnchor } = await import('./useVirtualizedScrollAnchor')

    const anchorRef = { current: null }
    const scrollElementRef = { current: null }
    const scrollOffsetRef = { current: 0 }
    const virtualizer = {
      getVirtualItems: () => [],
      isScrolling: false,
      scrollToIndex: vi.fn()
    }
    const renderWithRows = (rows: readonly string[]) => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      useVirtualizedScrollAnchor({
        anchorRef,
        getRowKey: (row) => row,
        rows,
        scrollElementRef,
        scrollOffsetRef,
        totalSize: rows.length,
        virtualizer
      } as never)
      return harness.effects[0]?.deps
    }

    const initialDeps = renderWithRows(['before-delete', 'stable-top'])
    const nextDeps = renderWithRows(['stable-top'])

    // Why: cleanup records the current anchor. If rows are dependencies, a
    // delete reruns cleanup after mutation and overwrites the pre-delete anchor.
    // Only stable refs are allowed here.
    expect(initialDeps).toEqual([anchorRef, scrollElementRef, scrollOffsetRef])
    expect(nextDeps).toEqual(initialDeps)
  })

  it('keeps the target anchor while measured fallback restores a transitional window', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const { useVirtualizedScrollAnchor } = await import('./useVirtualizedScrollAnchor')

    const anchorRef = { current: { key: 'row-1', offset: 3358 } }
    const scrollElementRef = {
      current: {
        clientHeight: 880,
        scrollHeight: 30_000,
        scrollTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }
    }
    const scrollOffsetRef = { current: 0 }
    const virtualizer = {
      getVirtualItems: () => [
        { index: 8, start: 0, end: 30_000 },
        { index: 1, start: 758, end: 4512 }
      ],
      isScrolling: false,
      scrollToIndex: vi.fn()
    }

    harness.beginRender()
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
    useVirtualizedScrollAnchor({
      anchorRef,
      getRowKey: (row) => row,
      rows: Array.from({ length: 9 }, (_, index) => `row-${index}`),
      scrollElementRef,
      scrollOffsetRef,
      totalSize: 30_000,
      virtualizer
    } as never)

    harness.effects[1]?.effect()

    expect(scrollElementRef.current.scrollTop).toBe(4116)
    // Why: the anchor identity is preserved through the transitional restore;
    // only its source scrollTop is refreshed to the restored offset.
    expect(anchorRef.current).toEqual({ key: 'row-1', offset: 3358, scrollTop: 4116 })
  })

  it('can ignore generic scroll anchor recording while preserving the saved anchor', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const { useVirtualizedScrollAnchor } = await import('./useVirtualizedScrollAnchor')

    const capturedScrollHandler: { current: (() => void) | null } = { current: null }
    const savedAnchor = { key: 'row-1', offset: 3358 }
    const anchorRef = { current: savedAnchor }
    const scrollElementRef = {
      current: {
        clientHeight: 880,
        scrollHeight: 30_000,
        scrollTop: 746,
        addEventListener: vi.fn((eventName: string, handler: () => void) => {
          if (eventName === 'scroll') {
            capturedScrollHandler.current = handler
          }
        }),
        removeEventListener: vi.fn()
      }
    }
    const scrollOffsetRef = { current: 0 }
    const virtualizer = {
      getVirtualItems: () => [
        { index: 0, start: 0, end: 3_000 },
        { index: 1, start: 3_000, end: 7_000 }
      ],
      isScrolling: false,
      scrollToIndex: vi.fn()
    }

    harness.beginRender()
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
    useVirtualizedScrollAnchor({
      anchorRef,
      getRowKey: (row) => row,
      recordAnchorOnScroll: false,
      rows: ['row-0', 'row-1'],
      scrollElementRef,
      scrollOffsetRef,
      totalSize: 30_000,
      virtualizer
    } as never)

    harness.effects[0]?.effect()
    expect(capturedScrollHandler.current).not.toBeNull()
    capturedScrollHandler.current?.()

    expect(scrollOffsetRef.current).toBe(0)
    expect(anchorRef.current).toBe(savedAnchor)
  })
})
