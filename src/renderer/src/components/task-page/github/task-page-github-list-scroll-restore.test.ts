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

  describe('user takeover', () => {
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
  })
})
