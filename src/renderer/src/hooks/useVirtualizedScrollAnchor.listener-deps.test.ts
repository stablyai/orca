import { afterEach, describe, expect, it, vi } from 'vitest'
import { runVirtualizedScrollAnchorRestore } from './virtualized-scroll-anchor-restore'

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

// Sidebar geometry from the reported jump: 12 rows x 100px in a 300px viewport,
// scrolled to 520 so the parent worktree ("p") sits 20px above the top edge.
type FakeRow = { key: string; size: number }
const VIEWPORT_HEIGHT = 300
const ITEM_SELECTOR = '[data-worktree-virtual-row]'
const PARENT_KEY = 'wt:sec:p'
const GROUP_KEY = 'lineage-group:sec:lineage:p'

function row(key: string, size = 100): FakeRow {
  return { key, size }
}

const LEADING_ROWS = ['r0', 'r1', 'r2', 'r3', 'r4'].map((id) => row(`wt:sec:${id}`))
const TRAILING_ROWS = ['s0', 's1', 's2', 'r10', 'r11'].map((id) => row(`wt:sec:${id}`))
// Before the child exists: parent and its (future) child are separate rows.
const UNFOLDED_ROWS = [...LEADING_ROWS, row(PARENT_KEY), row('wt:sec:c'), ...TRAILING_ROWS]
// After the child is created: both fold into one 200px lineage-group row that
// still starts at 500px, so nothing on screen actually moved.
const FOLDED_ROWS = [...LEADING_ROWS, row(GROUP_KEY, 200), ...TRAILING_ROWS]
// Parent genuinely deleted: the rows below slide up by 200px.
const DELETED_ROWS = [...LEADING_ROWS, ...TRAILING_ROWS]
// Last child deleted: the 200px group collapses back to a 100px card.
const DISSOLVED_ROWS = [...LEADING_ROWS, row(PARENT_KEY), ...TRAILING_ROWS]

function createFakeScroller(rows: readonly FakeRow[], scrollTop: number) {
  const starts: number[] = []
  let total = 0
  for (const item of rows) {
    starts.push(total)
    total += item.size
  }

  const el = {
    clientHeight: VIEWPORT_HEIGHT,
    scrollHeight: total,
    scrollTop,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ top: 0, bottom: VIEWPORT_HEIGHT, height: VIEWPORT_HEIGHT }),
    querySelectorAll: () => elements
  }
  const elements = rows.map((item, index) => ({
    isConnected: true,
    rowKey: item.key,
    getBoundingClientRect: () => {
      const top = (starts[index] as number) - el.scrollTop
      return { top, bottom: top + item.size, height: item.size }
    }
  }))

  return {
    el,
    elements,
    rowIndexByKey: new Map(rows.map((item, index) => [item.key, index])),
    virtualizer: {
      getVirtualItems: () =>
        rows.map((item, index) => ({
          index,
          size: item.size,
          start: starts[index] as number,
          end: (starts[index] as number) + item.size
        })),
      isScrolling: false,
      scrollToIndex: vi.fn()
    }
  }
}

function restore(args: {
  anchor: { key: string; offset: number; fallbackKeys?: string[]; scrollTop?: number }
  rekeyedRowKeys?: ReadonlyMap<string, string>
  rows: readonly FakeRow[]
  scrollTop: number
  useDom: boolean
}): number {
  const scroller = createFakeScroller(args.rows, args.scrollTop)
  runVirtualizedScrollAnchorRestore({
    anchor: args.anchor,
    el: scroller.el,
    ...(args.useDom
      ? {
          getItemElementKey: (element: { rowKey: string }) => element.rowKey,
          itemElementSelector: ITEM_SELECTOR
        }
      : {}),
    pendingRestoreRef: { current: false },
    recordScrollAnchor: vi.fn(),
    ...(args.rekeyedRowKeys ? { rekeyedRowKeys: args.rekeyedRowKeys } : {}),
    rowIndexByKey: scroller.rowIndexByKey,
    scrollOffsetRef: { current: args.scrollTop },
    virtualizer: scroller.virtualizer
  } as never)
  return scroller.el.scrollTop
}

// What WorktreeList's buildLineageRowRekeyMap produces for FOLDED_ROWS.
const FOLD_REKEYS: ReadonlyMap<string, string> = new Map([
  [PARENT_KEY, GROUP_KEY],
  ['wt:sec:c', GROUP_KEY]
])

const ANCHORED_ON_PARENT = {
  key: PARENT_KEY,
  offset: 20,
  fallbackKeys: ['wt:sec:s0', 'wt:sec:s1', 'wt:sec:s2'],
  scrollTop: 520
}

describe('runVirtualizedScrollAnchorRestore lineage re-keying', () => {
  it.each([
    ['dom', true],
    ['measured', false]
  ])(
    'keeps the sidebar still (%s path) when the anchored parent folds into a lineage group',
    (_label, useDom) => {
      // The anchored row did not move — only its key changed from `wt:` to
      // `lineage-group:`. Resolving a fallback here jumped the list +180px.
      expect(
        restore({
          anchor: { ...ANCHORED_ON_PARENT },
          rekeyedRowKeys: FOLD_REKEYS,
          rows: FOLDED_ROWS,
          scrollTop: 520,
          useDom
        })
      ).toBe(520)
    }
  )

  it.each([
    ['dom', true],
    ['measured', false]
  ])(
    'still pins a genuine fallback at offset 0 (%s path) when no rekey map is supplied',
    (_label, useDom) => {
      // CombinedDiffViewer never passes a map; its behaviour must not change.
      expect(
        restore({
          anchor: { ...ANCHORED_ON_PARENT },
          rows: FOLDED_ROWS,
          scrollTop: 520,
          useDom
        })
      ).toBe(700)
    }
  )

  it('pins a fallback at offset 0 when the anchored row was genuinely deleted', () => {
    // A rekey map is supplied but has no entry for the removed row, so the
    // fallback path (different row, offset dropped) must still win.
    expect(
      restore({
        anchor: { ...ANCHORED_ON_PARENT },
        rekeyedRowKeys: new Map(),
        rows: DELETED_ROWS,
        scrollTop: 520,
        useDom: true
      })
    ).toBe(500)
  })

  it.each([
    ['dom', true],
    ['measured', false]
  ])(
    'clamps the followed offset to the shorter row (%s path) when a group dissolves',
    (_label, useDom) => {
      // Anchor recorded 150px into the 200px group row; the dissolved card is
      // only 100px tall, so the offset clamps the way recording does.
      expect(
        restore({
          anchor: { key: GROUP_KEY, offset: 150, fallbackKeys: ['wt:sec:s0'], scrollTop: 650 },
          rekeyedRowKeys: new Map([[GROUP_KEY, PARENT_KEY]]),
          rows: DISSOLVED_ROWS,
          scrollTop: 650,
          useDom
        })
      ).toBe(600)
    }
  )

  it('ignores a rekey target that is not rendered this pass', () => {
    // Stale map entry pointing at an absent row must degrade to the fallback,
    // not leave the anchor unresolved.
    expect(
      restore({
        anchor: { ...ANCHORED_ON_PARENT },
        rekeyedRowKeys: new Map([[PARENT_KEY, 'lineage-group:sec:lineage:gone']]),
        rows: DELETED_ROWS,
        scrollTop: 520,
        useDom: true
      })
    ).toBe(500)
  })
})

describe('useVirtualizedScrollAnchor with sidebar row re-keying', () => {
  afterEach(() => {
    vi.doUnmock('react')
    vi.resetModules()
  })

  it('does not scroll when a child worktree folds the anchored parent into a group', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const { useVirtualizedScrollAnchor, VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } =
      await import('./useVirtualizedScrollAnchor')

    const anchorRef: { current: unknown } = { current: null }
    const scrollOffsetRef = { current: 520 }
    let scroller = createFakeScroller(UNFOLDED_ROWS, 520)
    const scrollElementRef: { current: unknown } = { current: scroller.el }
    const listeners = new Map<string, () => void>()
    scroller.el.addEventListener.mockImplementation((name: string, handler: () => void) => {
      listeners.set(name, handler)
    })

    // Sidebar's real config: DOM-confirmed rows, no restoreSignal, no marks.
    const render = (rows: readonly FakeRow[], rekeyedRowKeys?: ReadonlyMap<string, string>) => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      useVirtualizedScrollAnchor({
        anchorRef,
        getItemElementKey: (element: { rowKey: string }) => element.rowKey,
        getRowKey: (item: FakeRow) => item.key,
        itemElementSelector: ITEM_SELECTOR,
        rekeyedRowKeys,
        rows,
        scrollElementRef,
        scrollOffsetRef,
        totalSize: rows.reduce((sum, item) => sum + item.size, 0),
        virtualizer: scroller.virtualizer
      } as never)
    }

    render(UNFOLDED_ROWS)
    harness.effects[0]?.effect()
    listeners.get(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT)?.()
    expect(anchorRef.current).toMatchObject({ key: PARENT_KEY, offset: 20, scrollTop: 520 })

    // Child created: same pixels, new key for the parent's row.
    scroller = createFakeScroller(FOLDED_ROWS, 520)
    scrollElementRef.current = scroller.el
    render(FOLDED_ROWS, FOLD_REKEYS)
    harness.effects[1]?.effect()

    expect(scroller.el.scrollTop).toBe(520)
    // The anchor re-records against the row's new key so later restores hit the
    // exact-key path.
    expect(anchorRef.current).toMatchObject({ key: GROUP_KEY, offset: 20 })
  })
})
