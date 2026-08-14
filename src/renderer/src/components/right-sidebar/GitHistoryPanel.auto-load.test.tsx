// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { GitHistoryCursor, GitHistoryResult } from '../../../../shared/git-history'
import { GitHistoryPanel, type GitHistoryPanelState } from './GitHistoryPanel'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

type StubObserver = {
  callback: IntersectionObserverCallback
  root: Element | Document | null
  rootMargin: string
  disconnected: boolean
}

let observers: StubObserver[] = []
const realIntersectionObserver = globalThis.IntersectionObserver

// Why a stub rather than the environment's own: happy-dom performs no layout, so a real observer
// would never report an intersection and every assertion here would pass vacuously.
function installObserverStub(): void {
  observers = []
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    private readonly record: StubObserver
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = {
        callback,
        root: (options?.root as Element | null) ?? null,
        rootMargin: options?.rootMargin ?? '',
        disconnected: false
      }
      observers.push(this.record)
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      this.record.disconnected = true
    }
    takeRecords(): [] {
      return []
    }
  }
}

// The panel re-subscribes whenever the cursor moves, so only the newest live observer is the one
// watching the trigger the user can actually see.
function scrollTriggerIntoView(isIntersecting = true): void {
  const observer = observers.findLast((entry) => !entry.disconnected)
  if (!observer) {
    throw new Error('no live IntersectionObserver — the panel never observed a load trigger')
  }
  act(() => {
    observer.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      undefined as unknown as IntersectionObserver
    )
  })
}

afterEach(() => {
  cleanup()
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    realIntersectionObserver
})

beforeEach(() => {
  installObserverStub()
})

function commitId(index: number): string {
  return String(index + 1).padStart(40, 'a')
}

function cursor(loaded: number): GitHistoryCursor {
  return { anchor: commitId(0), loaded, after: { id: commitId(loaded - 1), parentIds: [] } }
}

function makeResult({
  count,
  nextCursor,
  continuedCursor
}: {
  count: number
  nextCursor?: GitHistoryCursor
  continuedCursor?: boolean
}): GitHistoryResult {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      id: commitId(index),
      parentIds: index + 1 < count ? [commitId(index + 1)] : [],
      subject: `Commit ${index + 1}`,
      message: `Commit ${index + 1}`,
      displayId: commitId(index).slice(0, 7),
      author: 'Taylor',
      timestamp: new Date(2026, 5, 15, 12).getTime() - index * 60_000,
      references: []
    })),
    currentRef: {
      id: 'refs/heads/main',
      name: 'main',
      revision: commitId(0),
      category: 'branches'
    },
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: Boolean(nextCursor),
    limit: 50,
    continuedCursor,
    nextCursor
  }
}

function panel(state: GitHistoryPanelState, onLoadMore: () => void): React.JSX.Element {
  return (
    <GitHistoryPanel
      state={state}
      worktreeId="wt-a"
      collapsed={false}
      onToggle={vi.fn()}
      onRefresh={vi.fn()}
      onLoadMore={onLoadMore}
      onOpenCommit={vi.fn()}
    />
  )
}

function ready(result: GitHistoryResult): GitHistoryPanelState {
  return { status: 'ready', result }
}

describe('git history auto-loads the next page on scroll', () => {
  it('fetches the next page when the trigger scrolls near the bottom', () => {
    const onLoadMore = vi.fn()
    render(panel(ready(makeResult({ count: 3, nextCursor: cursor(3) })), onLoadMore))

    expect(onLoadMore).not.toHaveBeenCalled()
    scrollTriggerIntoView()

    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  // Why: the observer's root is the panel's own scroller, and the bottom margin is what buys the
  // fetch a head start. Watching the document instead would fire on page scroll the panel does not
  // own, and a zero margin would make every page land visibly late.
  it('watches the panel scroller with a bottom prefetch margin', () => {
    render(panel(ready(makeResult({ count: 3, nextCursor: cursor(3) })), vi.fn()))

    const observer = observers.findLast((entry) => !entry.disconnected)
    expect(observer?.root).toBeInstanceOf(Element)
    expect(observer?.rootMargin).toMatch(/0px 0px [1-9]\d*px 0px/)
  })

  it('does not fetch the same page twice while it is still on screen', () => {
    const onLoadMore = vi.fn()
    render(panel(ready(makeResult({ count: 3, nextCursor: cursor(3) })), onLoadMore))

    scrollTriggerIntoView()
    scrollTriggerIntoView()
    scrollTriggerIntoView()

    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('keeps fetching as each page lands and the trigger stays in view', () => {
    const onLoadMore = vi.fn()
    const { rerender } = render(
      panel(ready(makeResult({ count: 3, nextCursor: cursor(3) })), onLoadMore)
    )

    scrollTriggerIntoView()
    rerender(
      panel(
        ready(makeResult({ count: 6, nextCursor: cursor(6), continuedCursor: true })),
        onLoadMore
      )
    )
    scrollTriggerIntoView()

    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  // Why: the retry hazard. A failed page leaves the cursor untouched, so without the once-per-cursor
  // rule the trigger would reissue it for as long as it stayed on screen.
  it('does not retry a page that failed', () => {
    const onLoadMore = vi.fn()
    const result = makeResult({ count: 3, nextCursor: cursor(3) })
    const { rerender } = render(panel(ready(result), onLoadMore))

    scrollTriggerIntoView()
    rerender(panel({ status: 'error', result, error: 'boom' }, onLoadMore))
    scrollTriggerIntoView()

    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  // The button is the documented escape hatch from the state above.
  it('still fetches a failed page when the button is pressed', () => {
    const onLoadMore = vi.fn()
    const result = makeResult({ count: 3, nextCursor: cursor(3) })
    const { rerender } = render(panel(ready(result), onLoadMore))

    scrollTriggerIntoView()
    rerender(panel({ status: 'error', result, error: 'boom' }, onLoadMore))
    fireEvent.click(screen.getByRole('button', { name: /Load more commits/ }))

    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  it('does not fetch while a page is already in flight', () => {
    const onLoadMore = vi.fn()
    const result = makeResult({ count: 3, nextCursor: cursor(3) })
    render(panel({ status: 'refreshing', result }, onLoadMore))

    scrollTriggerIntoView()

    expect(onLoadMore).not.toHaveBeenCalled()
  })

  // Why: a replaced list is a different walk. Its first cursor can repeat one already spent on the
  // walk it replaced, and holding that record would leave auto-loading dead after every refresh.
  it('auto-loads again after a refresh replaces the list', () => {
    const onLoadMore = vi.fn()
    const { rerender } = render(
      panel(ready(makeResult({ count: 3, nextCursor: cursor(3) })), onLoadMore)
    )

    scrollTriggerIntoView()
    expect(onLoadMore).toHaveBeenCalledTimes(1)

    // Same cursor as the first page: a refresh that landed on the same HEAD.
    rerender(
      panel(
        ready(makeResult({ count: 3, nextCursor: cursor(3), continuedCursor: false })),
        onLoadMore
      )
    )
    scrollTriggerIntoView()

    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  it('stops when the host reports nothing older', () => {
    const onLoadMore = vi.fn()
    render(panel(ready(makeResult({ count: 3 })), onLoadMore))

    expect(observers.filter((entry) => !entry.disconnected)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Load more commits/ })).toBeNull()
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  // Why: a host too old to page still reports hasMore but echoes no cursor. Auto-loading there
  // would reissue page one forever.
  it('does not auto-load when the host echoed no cursor', () => {
    const onLoadMore = vi.fn()
    const result = { ...makeResult({ count: 3 }), hasMore: true }
    render(panel(ready(result), onLoadMore))

    expect(observers.filter((entry) => !entry.disconnected)).toHaveLength(0)
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('leaves the manual button working where IntersectionObserver is unavailable', () => {
    const onLoadMore = vi.fn()
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined
    render(panel(ready(makeResult({ count: 3, nextCursor: cursor(3) })), onLoadMore))

    fireEvent.click(screen.getByRole('button', { name: /Load more commits/ }))

    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })
})
