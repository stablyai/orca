import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProgrammaticScrollMarks } from './programmatic-scroll-marks'

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

type FakeRowElement = {
  getBoundingClientRect: () => { bottom: number; height: number; top: number }
  isConnected: boolean
  key: string
}

function createScrollElement({
  clientHeight = 880,
  rowElements = [] as FakeRowElement[],
  scrollHeight = 30_000,
  scrollTop = 0
}) {
  const scrollHandlers: ((event: Event) => void)[] = []
  const el = {
    addEventListener: vi.fn((eventName: string, handler: (event: Event) => void) => {
      if (eventName === 'scroll') {
        scrollHandlers.push(handler)
      }
    }),
    clientHeight,
    getBoundingClientRect: () => ({ bottom: clientHeight, top: 0 }),
    querySelectorAll: vi.fn(() => rowElements),
    removeEventListener: vi.fn(),
    scrollHeight,
    scrollTop
  }
  return {
    el,
    emitScroll: (top: number): void => {
      el.scrollTop = top
      const event = new Event('scroll')
      scrollHandlers.forEach((handler) => handler(event))
    }
  }
}

const anchoredRowElement = (key: string, top: number): FakeRowElement => ({
  getBoundingClientRect: () => ({ bottom: top + 4_000, height: 4_000, top }),
  isConnected: true,
  key
})

describe('useVirtualizedScrollAnchor with marks + restoreSignal', () => {
  afterEach(() => {
    vi.doUnmock('react')
    vi.resetModules()
  })

  const loadHook = async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const { useVirtualizedScrollAnchor } = await import('./useVirtualizedScrollAnchor')
    return { harness, useVirtualizedScrollAnchor }
  }

  const virtualizerWithRow1 = () => ({
    getVirtualItems: () => [
      { index: 0, start: 0, end: 758 },
      { index: 1, start: 758, end: 4_512 }
    ],
    isScrolling: false,
    scrollToIndex: vi.fn()
  })

  it('does not re-attempt restore on measurement churn when the signal is unchanged', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    const { el } = createScrollElement({
      rowElements: [anchoredRowElement('row-1', -3_358)],
      scrollTop: 746
    })
    const anchorRef = { current: { key: 'row-1', offset: 3_358, scrollTop: 746 } }
    const virtualizer = virtualizerWithRow1()

    const render = (restoreSignal: string, totalSize: number) => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      useVirtualizedScrollAnchor({
        anchorRef,
        getItemElementKey: (element: FakeRowElement) => element.key,
        getRowKey: (row: string) => row,
        itemElementSelector: '[data-row]',
        programmaticScrollMarks: createProgrammaticScrollMarks(),
        recordAnchorOnScroll: false,
        restoreSignal,
        rows: ['row-0', 'row-1'],
        scrollElementRef: { current: el },
        scrollOffsetRef: { current: 746 },
        totalSize,
        virtualizer
      } as never)
      harness.effects[1]?.effect()
    }

    render('signal-a', 30_000)
    expect(el.querySelectorAll).toHaveBeenCalled()
    const attemptsAfterConfirm = el.querySelectorAll.mock.calls.length

    render('signal-a', 31_500)
    expect(el.querySelectorAll.mock.calls.length).toBe(attemptsAfterConfirm)
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled()
  })

  it('keeps retrying a restore that is still converging when layout moves the viewport', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    let rowTop = -3_000
    const rowElement: FakeRowElement = {
      getBoundingClientRect: () => ({
        bottom: rowTop + 4_000,
        height: 4_000,
        top: rowTop
      }),
      isConnected: true,
      key: 'row-1'
    }
    const { el } = createScrollElement({
      rowElements: [rowElement],
      scrollTop: 746
    })
    const anchorRef = { current: { key: 'row-1', offset: 3_358, scrollTop: 746 } }
    const virtualizer = virtualizerWithRow1()
    // Keep object identities stable so rerenders retain marks and offset bookkeeping.
    const programmaticScrollMarks = createProgrammaticScrollMarks()
    const scrollElementRef = { current: el }
    const scrollOffsetRef = { current: 746 }

    const render = (): void => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      useVirtualizedScrollAnchor({
        anchorRef,
        getItemElementKey: (element: FakeRowElement) => element.key,
        getRowKey: (row: string) => row,
        itemElementSelector: '[data-row]',
        programmaticScrollMarks,
        recordAnchorOnScroll: false,
        restoreSignal: 'signal-a',
        rows: ['row-0', 'row-1'],
        scrollElementRef,
        scrollOffsetRef,
        totalSize: 30_000,
        virtualizer
      } as never)
      harness.effects[1]?.effect()
    }

    render()
    const attemptsAfterFirstPass = el.querySelectorAll.mock.calls.length
    expect(attemptsAfterFirstPass).toBeGreaterThan(0)
    expect(el.scrollTop).toBe(1_104)

    // Monaco grows content above while browser anchoring keeps the row pinned.
    rowTop = -3_358
    el.scrollTop += 196

    render()
    expect(el.querySelectorAll.mock.calls.length).toBeGreaterThan(attemptsAfterFirstPass)
    const attemptsAfterConfirm = el.querySelectorAll.mock.calls.length
    expect(anchorRef.current.scrollTop).toBe(1_300)

    render()
    expect(el.querySelectorAll.mock.calls.length).toBe(attemptsAfterConfirm)
  })

  it('lets an unmarked user scroll disarm a restore that is still converging', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    const { el, emitScroll } = createScrollElement({
      rowElements: [anchoredRowElement('row-1', -3_000)],
      scrollTop: 746
    })
    const anchorRef = { current: { key: 'row-1', offset: 3_358, scrollTop: 746 } }
    const programmaticScrollMarks = createProgrammaticScrollMarks()
    const scrollElementRef = { current: el }
    const scrollOffsetRef = { current: 746 }
    const virtualizer = virtualizerWithRow1()

    const render = (): void => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      useVirtualizedScrollAnchor({
        anchorRef,
        getItemElementKey: (element: FakeRowElement) => element.key,
        getRowKey: (row: string) => row,
        itemElementSelector: '[data-row]',
        programmaticScrollMarks,
        recordAnchorOnScroll: false,
        restoreSignal: 'signal-a',
        rows: ['row-0', 'row-1'],
        scrollElementRef,
        scrollOffsetRef,
        totalSize: 30_000,
        virtualizer
      } as never)
    }

    render()
    harness.effects[0]?.effect()
    harness.effects[1]?.effect()
    const attemptsAfterFirstPass = el.querySelectorAll.mock.calls.length
    expect(el.scrollTop).toBe(1_104)

    emitScroll(1_400)
    render()
    harness.effects[1]?.effect()

    expect(el.scrollTop).toBe(1_400)
    expect(el.querySelectorAll.mock.calls.length).toBe(attemptsAfterFirstPass)
  })

  it('lets the user position win when the viewport moved after the anchor was recorded', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    const { el } = createScrollElement({
      rowElements: [anchoredRowElement('row-1', -3_358)],
      scrollTop: 906
    })
    const anchorRef = { current: { key: 'row-1', offset: 3_358, scrollTop: 746 } }
    const virtualizer = virtualizerWithRow1()

    harness.beginRender()
    useVirtualizedScrollAnchor({
      anchorRef,
      getItemElementKey: (element: FakeRowElement) => element.key,
      getRowKey: (row: string) => row,
      itemElementSelector: '[data-row]',
      programmaticScrollMarks: createProgrammaticScrollMarks(),
      recordAnchorOnScroll: false,
      restoreSignal: 'signal-a',
      rows: ['row-0', 'row-1'],
      scrollElementRef: { current: el },
      scrollOffsetRef: { current: 746 },
      totalSize: 30_000,
      virtualizer
    } as never)
    harness.effects[1]?.effect()

    expect(el.scrollTop).toBe(906)
    expect(el.querySelectorAll).not.toHaveBeenCalled()
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled()
  })

  it('still restores when a browser clamp explains the divergence', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    // Shrinking content clamps the browser below the anchor’s recorded offset.
    const { el } = createScrollElement({
      rowElements: [],
      scrollHeight: 2_000,
      scrollTop: 1_120
    })
    const anchorRef = { current: { key: 'row-1', offset: 3_358, scrollTop: 5_000 } }
    const virtualizer = virtualizerWithRow1()

    harness.beginRender()
    useVirtualizedScrollAnchor({
      anchorRef,
      getItemElementKey: (element: FakeRowElement) => element.key,
      getRowKey: (row: string) => row,
      itemElementSelector: '[data-row]',
      programmaticScrollMarks: createProgrammaticScrollMarks(),
      recordAnchorOnScroll: false,
      restoreSignal: 'signal-a',
      rows: ['row-0', 'row-1'],
      scrollElementRef: { current: el },
      scrollOffsetRef: { current: 5_000 },
      totalSize: 2_000,
      virtualizer
    } as never)
    harness.effects[1]?.effect()

    expect(el.querySelectorAll).toHaveBeenCalled()
  })

  it('yields the mount restore to an unmarked user scroll instead of rewriting it', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    const { el, emitScroll } = createScrollElement({ scrollTop: 0 })
    const anchorRef = { current: null }

    harness.beginRender()
    useVirtualizedScrollAnchor({
      anchorRef,
      getRowKey: (row: string) => row,
      programmaticScrollMarks: createProgrammaticScrollMarks(),
      recordAnchorOnScroll: false,
      restoreSignal: 'signal-a',
      rows: ['row-0', 'row-1'],
      scrollElementRef: { current: el },
      scrollOffsetRef: { current: 4_000 },
      totalSize: 30_000,
      virtualizer: virtualizerWithRow1()
    } as never)
    harness.effects[0]?.effect()
    expect(el.scrollTop).toBe(4_000)

    // An unmarked scroll means user takeover even when jank hid the wheel event from input tracking.
    emitScroll(4_200)
    expect(el.scrollTop).toBe(4_200)
  })

  it('keeps structural restores alive after its own marked writes move the viewport', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    const marks = createProgrammaticScrollMarks()
    const rowElement = anchoredRowElement('row-1', -3_358)
    const { el, emitScroll } = createScrollElement({
      rowElements: [rowElement],
      scrollTop: 746
    })
    const anchorRef = { current: { key: 'row-1', offset: 3_358, scrollTop: 746 } }
    const scrollOffsetRef = { current: 746 }
    const virtualizer = virtualizerWithRow1()

    const render = (restoreSignal: string) => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      useVirtualizedScrollAnchor({
        anchorRef,
        getItemElementKey: (element: FakeRowElement) => element.key,
        getRowKey: (row: string) => row,
        itemElementSelector: '[data-row]',
        programmaticScrollMarks: marks,
        recordAnchorOnScroll: false,
        restoreSignal,
        rows: ['row-0', 'row-1'],
        scrollElementRef: { current: el },
        scrollOffsetRef,
        totalSize: 30_000,
        virtualizer
      } as never)
      harness.effects[0]?.effect()
      harness.effects[1]?.effect()
    }

    render('signal-a')
    marks.mark(946)
    emitScroll(946)
    // Marked-write bookkeeping must prevent a correction from looking like user input.
    expect(anchorRef.current.scrollTop).toBe(946)
    expect(scrollOffsetRef.current).toBe(946)

    const attemptsBefore = el.querySelectorAll.mock.calls.length
    render('signal-b')
    expect(el.querySelectorAll.mock.calls.length).toBeGreaterThan(attemptsBefore)
  })

  it('retries a signal-change restore that was skipped during direct input', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    const { el } = createScrollElement({
      rowElements: [anchoredRowElement('row-1', -3_358)],
      scrollTop: 746
    })
    const anchorRef = { current: { key: 'row-1', offset: 3_358, scrollTop: 746 } }
    const virtualizer = virtualizerWithRow1()
    let directInput = true

    const render = (restoreSignal: string, totalSize: number) => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      useVirtualizedScrollAnchor({
        anchorRef,
        getItemElementKey: (element: FakeRowElement) => element.key,
        getRowKey: (row: string) => row,
        itemElementSelector: '[data-row]',
        programmaticScrollMarks: createProgrammaticScrollMarks(),
        recordAnchorOnScroll: false,
        restoreSignal,
        rows: ['row-0', 'row-1'],
        scrollElementRef: { current: el },
        scrollOffsetRef: { current: 746 },
        shouldSkipRestore: () => directInput,
        totalSize,
        virtualizer
      } as never)
      harness.effects[1]?.effect()
    }

    render('signal-a', 30_000)
    expect(el.querySelectorAll).not.toHaveBeenCalled()

    // After input settles, retry the owed restore even though the structural signal is unchanged.
    directInput = false
    render('signal-a', 31_000)
    expect(el.querySelectorAll).toHaveBeenCalled()
  })

  it('does not stay armed when the anchor row and all fallbacks are gone', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    const { el } = createScrollElement({
      rowElements: [anchoredRowElement('row-1', -3_358)],
      scrollTop: 746
    })
    const anchorRef = { current: { key: 'row-gone', offset: 3_358, scrollTop: 746 } }
    const virtualizer = virtualizerWithRow1()

    const render = (rows: readonly string[], totalSize: number) => {
      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      useVirtualizedScrollAnchor({
        anchorRef,
        getItemElementKey: (element: FakeRowElement) => element.key,
        getRowKey: (row: string) => row,
        itemElementSelector: '[data-row]',
        programmaticScrollMarks: createProgrammaticScrollMarks(),
        recordAnchorOnScroll: false,
        restoreSignal: 'signal-a',
        rows,
        scrollElementRef: { current: el },
        scrollOffsetRef: { current: 746 },
        totalSize,
        virtualizer
      } as never)
      harness.effects[1]?.effect()
    }

    render(['row-0', 'row-2'], 30_000)
    expect(el.querySelectorAll).not.toHaveBeenCalled()

    // An unresolvable anchor must disarm; later resolvability changes require a new signal.
    render(['row-0', 'row-gone'], 31_000)
    expect(el.querySelectorAll).not.toHaveBeenCalled()
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled()
  })

  it('does not treat a browser clamp during the mount restore as user takeover', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    const marks = createProgrammaticScrollMarks()
    const { el, emitScroll } = createScrollElement({ scrollHeight: 3_000, scrollTop: 0 })
    const anchorRef = { current: null }
    const scrollOffsetRef = { current: 4_000 }

    harness.beginRender()
    useVirtualizedScrollAnchor({
      anchorRef,
      getRowKey: (row: string) => row,
      programmaticScrollMarks: marks,
      recordAnchorOnScroll: false,
      restoreSignal: 'signal-a',
      rows: ['row-0', 'row-1'],
      scrollElementRef: { current: el },
      scrollOffsetRef,
      totalSize: 3_000,
      virtualizer: virtualizerWithRow1()
    } as never)
    harness.effects[0]?.effect()

    emitScroll(2_120)
    el.scrollHeight = 2_000
    emitScroll(1_120)
    expect(anchorRef.current).toBeNull()

    // A marked correction retries restoration once the persisted offset becomes reachable.
    el.scrollHeight = 30_000
    marks.mark(1_500)
    emitScroll(1_500)
    expect(el.scrollTop).toBe(4_000)
    expect(scrollOffsetRef.current).toBe(4_000)
  })

  it('keeps rewriting toward the target while its own marked writes settle', async () => {
    const { harness, useVirtualizedScrollAnchor } = await loadHook()
    const marks = createProgrammaticScrollMarks()
    const { el, emitScroll } = createScrollElement({ scrollTop: 0 })
    const anchorRef = { current: null }

    harness.beginRender()
    useVirtualizedScrollAnchor({
      anchorRef,
      getRowKey: (row: string) => row,
      programmaticScrollMarks: marks,
      recordAnchorOnScroll: false,
      restoreSignal: 'signal-a',
      rows: ['row-0', 'row-1'],
      scrollElementRef: { current: el },
      scrollOffsetRef: { current: 4_000 },
      totalSize: 30_000,
      virtualizer: virtualizerWithRow1()
    } as never)
    harness.effects[0]?.effect()

    // A marked write elsewhere during restore must not displace its target.
    marks.mark(3_500)
    emitScroll(3_500)
    expect(el.scrollTop).toBe(4_000)
  })

  it('lands a caller-supplied row index map on the same row as the internally built one', async () => {
    const runRestore = async (rowIndexByKey?: ReadonlyMap<string, number>) => {
      // Reload the hook module per run so harnesses cannot inherit earlier refs.
      vi.resetModules()
      const { harness, useVirtualizedScrollAnchor } = await loadHook()
      const { el } = createScrollElement({ rowElements: [], scrollTop: 0 })
      const anchorRef = { current: { key: 'row-1', offset: 40, scrollTop: 0 } }
      let getRowKeyCalls = 0

      harness.beginRender()
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- test harness mocks React's hook dispatcher directly.
      useVirtualizedScrollAnchor({
        anchorRef,
        getRowKey: (row: string) => {
          getRowKeyCalls += 1
          return row
        },
        programmaticScrollMarks: createProgrammaticScrollMarks(),
        recordAnchorOnScroll: false,
        restoreSignal: 'signal-a',
        rowIndexByKey,
        rows: ['row-0', 'row-1'],
        scrollElementRef: { current: el },
        scrollOffsetRef: { current: 0 },
        totalSize: 30_000,
        virtualizer: virtualizerWithRow1()
      } as never)
      harness.effects[1]?.effect()
      return { getRowKeyCalls, scrollTop: el.scrollTop }
    }

    const builtInternally = await runRestore()
    const supplied = await runRestore(
      new Map([
        ['row-0', 0],
        ['row-1', 1]
      ])
    )

    expect(supplied.scrollTop).toBe(builtInternally.scrollTop)
    expect(builtInternally.getRowKeyCalls).toBeGreaterThan(0)
    expect(supplied.getRowKeyCalls).toBe(0)
  })
})
