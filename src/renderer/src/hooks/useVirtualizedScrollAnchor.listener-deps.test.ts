import { afterEach, describe, expect, it, vi } from 'vitest'

function createReactHookHarness() {
  const refs: { current: unknown }[] = []
  const effects: { deps: readonly unknown[] | undefined }[] = []
  let refIndex = 0

  return {
    beginRender: () => {
      refIndex = 0
      effects.length = 0
    },
    effects,
    react: {
      useCallback: <T extends (...args: never[]) => unknown>(callback: T): T => callback,
      useLayoutEffect: (_effect: () => void | (() => void), deps?: readonly unknown[]) => {
        effects.push({ deps })
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
    expect(initialDeps).toEqual([scrollElementRef, scrollOffsetRef])
    expect(nextDeps).toEqual(initialDeps)
  })
})
