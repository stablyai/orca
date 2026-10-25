// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  startGitHubListScrollRestore,
  supersedeGitHubListScrollRestore,
  type GitHubListRestoreWrite
} from './task-page-github-list-scroll-restore'

type FakeResizeObserver = {
  targets: Set<Element>
  notify: () => void
}

const observers: FakeResizeObserver[] = []

/** Notifies every observer watching `target`, mirroring a real content/box resize. */
function resize(target: Element): void {
  for (const observer of observers) {
    if (observer.targets.has(target)) {
      observer.notify()
    }
  }
}

/** Scroll container whose scrollTop clamps to `maxScrollTop`, like a real overflow box. */
function createScrollList(maxScrollTop: number): {
  element: HTMLDivElement
  rows: HTMLDivElement
  setMaxScrollTop: (next: number) => void
} {
  const element = document.createElement('div')
  const rows = document.createElement('div')
  element.append(rows)
  let max = maxScrollTop
  let value = 0
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = Math.max(0, Math.min(next, max))
    }
  })
  return {
    element,
    rows,
    setMaxScrollTop: (next: number) => {
      max = next
      value = Math.min(value, next)
    }
  }
}

function ref<T>(current: T): { current: T } {
  return { current }
}

describe('GitHub task list scroll restore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    observers.length = 0
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly entry: FakeResizeObserver
        constructor(callback: () => void) {
          this.entry = { targets: new Set(), notify: callback }
          observers.push(this.entry)
        }
        observe(target: Element): void {
          this.entry.targets.add(target)
        }
        disconnect(): void {
          this.entry.targets.clear()
        }
      }
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('lands on the remembered offset once the rows finally paint', () => {
    const list = createScrollList(0)
    const pendingRestoreRef = ref<number | null>(360)
    const restoreWriteRef = ref<GitHubListRestoreWrite | null>(null)
    const applied: number[] = []

    startGitHubListScrollRestore({
      target: 360,
      scrollElementRef: ref<HTMLElement | null>(list.element),
      pendingRestoreRef,
      restoreWriteRef,
      onScrollTopApplied: (scrollTop) => applied.push(scrollTop)
    })

    expect(list.element.scrollTop).toBe(0)

    list.setMaxScrollTop(900)
    resize(list.rows)

    expect(list.element.scrollTop).toBe(360)
    expect(pendingRestoreRef.current).toBeNull()
    expect(applied.at(-1)).toBe(360)
  })

  it('retries when the rows mount after the restore starts', async () => {
    const list = createScrollList(0)
    list.element.removeChild(list.rows)
    const pendingRestoreRef = ref<number | null>(360)
    const restoreWriteRef = ref<GitHubListRestoreWrite | null>(null)

    startGitHubListScrollRestore({
      target: 360,
      scrollElementRef: ref<HTMLElement | null>(list.element),
      pendingRestoreRef,
      restoreWriteRef,
      onScrollTopApplied: () => {}
    })

    list.setMaxScrollTop(900)
    list.element.append(list.rows)
    await Promise.resolve()

    expect(list.element.scrollTop).toBe(360)
    expect(pendingRestoreRef.current).toBeNull()
  })

  it('keeps the remembered offset armed when the list never becomes tall enough', () => {
    const list = createScrollList(0)
    const pendingRestoreRef = ref<number | null>(360)
    const restoreWriteRef = ref<GitHubListRestoreWrite | null>(null)
    const applied: number[] = []

    startGitHubListScrollRestore({
      target: 360,
      scrollElementRef: ref<HTMLElement | null>(list.element),
      pendingRestoreRef,
      restoreWriteRef,
      onScrollTopApplied: (scrollTop) => applied.push(scrollTop)
    })

    vi.advanceTimersByTime(30_000)

    // The remembered offset must survive an arbitrarily slow paint instead of being
    // overwritten with the committed 0 — that is what lost the position for good.
    expect(applied).not.toContain(0)
    expect(pendingRestoreRef.current).toBe(360)

    list.setMaxScrollTop(900)
    resize(list.rows)

    expect(list.element.scrollTop).toBe(360)
    expect(pendingRestoreRef.current).toBeNull()
  })

  it('retries when only the scroll container itself resizes', () => {
    const list = createScrollList(0)
    const pendingRestoreRef = ref<number | null>(360)
    const restoreWriteRef = ref<GitHubListRestoreWrite | null>(null)

    startGitHubListScrollRestore({
      target: 360,
      scrollElementRef: ref<HTMLElement | null>(list.element),
      pendingRestoreRef,
      restoreWriteRef,
      onScrollTopApplied: () => {}
    })

    // A pagination bar appearing or the window resizing shrinks only the container,
    // which alone can make the remembered offset reachable.
    list.setMaxScrollTop(900)
    resize(list.element)

    expect(list.element.scrollTop).toBe(360)
    expect(pendingRestoreRef.current).toBeNull()
  })

  it('stops observing once the cleanup runs', () => {
    const list = createScrollList(0)
    const pendingRestoreRef = ref<number | null>(360)
    const restoreWriteRef = ref<GitHubListRestoreWrite | null>(null)

    const stop = startGitHubListScrollRestore({
      target: 360,
      scrollElementRef: ref<HTMLElement | null>(list.element),
      pendingRestoreRef,
      restoreWriteRef,
      onScrollTopApplied: () => {}
    })
    stop()

    list.setMaxScrollTop(900)
    resize(list.rows)

    expect(list.element.scrollTop).toBe(0)
  })

  it('leaves the pending restore alone when the list is not mounted', () => {
    const pendingRestoreRef = ref<number | null>(360)

    const stop = startGitHubListScrollRestore({
      target: 360,
      scrollElementRef: ref<HTMLElement | null>(null),
      pendingRestoreRef,
      restoreWriteRef: ref<GitHubListRestoreWrite | null>(null),
      onScrollTopApplied: () => {
        throw new Error('nothing to apply without a list')
      }
    })
    stop()

    expect(pendingRestoreRef.current).toBe(360)
  })

  describe('user takeover', () => {
    it('ignores the scroll event the restore itself produced', () => {
      // Half-painted: the restore commits 200 of the 360 it wants, and that clamped
      // write is what the browser echoes back as a scroll event.
      const list = createScrollList(200)
      const pendingRestoreRef = ref<number | null>(360)
      const restoreWriteRef = ref<GitHubListRestoreWrite | null>(null)

      startGitHubListScrollRestore({
        target: 360,
        scrollElementRef: ref<HTMLElement | null>(list.element),
        pendingRestoreRef,
        restoreWriteRef,
        onScrollTopApplied: () => {}
      })

      expect(
        supersedeGitHubListScrollRestore({
          scrollTop: list.element.scrollTop,
          pendingRestoreRef,
          restoreWriteRef
        })
      ).toBe(false)
      expect(pendingRestoreRef.current).toBe(360)
    })

    it('ends a restore the list can never satisfy when the user scrolls', () => {
      const list = createScrollList(0)
      const pendingRestoreRef = ref<number | null>(360)
      const restoreWriteRef = ref<GitHubListRestoreWrite | null>(null)

      startGitHubListScrollRestore({
        target: 360,
        scrollElementRef: ref<HTMLElement | null>(list.element),
        pendingRestoreRef,
        restoreWriteRef,
        onScrollTopApplied: () => {}
      })

      list.setMaxScrollTop(900)
      list.element.scrollTop = 120
      expect(
        supersedeGitHubListScrollRestore({ scrollTop: 120, pendingRestoreRef, restoreWriteRef })
      ).toBe(true)
      expect(pendingRestoreRef.current).toBeNull()
      expect(restoreWriteRef.current).toBeNull()

      // Without the takeover the next resize would drag the user back to the old offset.
      resize(list.rows)
      expect(list.element.scrollTop).toBe(120)
    })

    it('does not read a write left over from an earlier target as an echo', () => {
      const pendingRestoreRef = ref<number | null>(120)
      const restoreWriteRef = ref<GitHubListRestoreWrite | null>({ target: 360, committed: 200 })

      expect(
        supersedeGitHubListScrollRestore({ scrollTop: 200, pendingRestoreRef, restoreWriteRef })
      ).toBe(true)
      expect(pendingRestoreRef.current).toBeNull()
    })

    it('records the offset once no restore is pending', () => {
      const pendingRestoreRef = ref<number | null>(null)
      const restoreWriteRef = ref<GitHubListRestoreWrite | null>({ target: 360, committed: 200 })

      expect(
        supersedeGitHubListScrollRestore({ scrollTop: 200, pendingRestoreRef, restoreWriteRef })
      ).toBe(true)
    })
  })
})
