// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { GIT_HISTORY_DEFAULT_LIMIT, type GitHistoryResult } from '../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../shared/types'
import { GitHistoryPanel } from './GitHistoryPanel'
import {
  GIT_HISTORY_ROW_HEIGHT_PX,
  GIT_HISTORY_VIRTUALIZE_MIN_ROWS
} from './git-history-virtual-rows'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

afterEach(() => {
  cleanup()
})

const timestamp = new Date(2026, 5, 15, 12).getTime()

function commitId(index: number): string {
  return String(index + 1).padStart(40, 'a')
}

// `offset` shifts the commit ids so a later result can drop the originally expanded commit,
// which is what a base-ref change or branch switch does.
function makeHistoryResult(count: number, offset = 0): GitHistoryResult {
  const items = Array.from({ length: count }, (_, index) => {
    const id = commitId(index + offset)
    return {
      id,
      parentIds: index + 1 < count ? [commitId(index + 1 + offset)] : [],
      subject: `Commit ${index + 1 + offset}`,
      message: `Commit ${index + 1 + offset}`,
      displayId: id.slice(0, 7),
      author: 'Taylor',
      timestamp: timestamp - index * 60_000,
      references: []
    }
  })
  return {
    items,
    currentRef: {
      id: 'refs/heads/main',
      name: 'main',
      revision: items[0]?.id,
      category: 'branches'
    },
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: true,
    limit: count
  }
}

const fileEntries: GitBranchChangeEntry[] = [
  { path: 'src/app.ts', status: 'modified', added: 1, removed: 0 }
]

function renderPanel(
  result: GitHistoryResult,
  onLoadCommitFiles: () => Promise<GitBranchChangeEntry[]>,
  worktreeId = 'wt-a'
): React.JSX.Element {
  return (
    <GitHistoryPanel
      state={{ status: 'ready', result }}
      worktreeId={worktreeId}
      collapsed={false}
      onToggle={vi.fn()}
      onRefresh={vi.fn()}
      onLoadMore={vi.fn()}
      onOpenCommit={vi.fn()}
      onLoadCommitFiles={onLoadCommitFiles}
      onOpenCommitFile={vi.fn()}
    />
  )
}

function expandLabelFor(index: number): string {
  return `Show files in commit ${commitId(index).slice(0, 7)}: Commit ${index + 1}`
}

describe('GitHistoryPanel expansion persistence', () => {
  // Load more appends: the commits already on screen are the same commits, so collapsing them
  // (and dropping their file lists) destroys the inspection context the action exists to extend.
  it('keeps an expanded commit expanded, and its files cached, when Load more appends a page', async () => {
    const onLoadCommitFiles = vi.fn(async () => fileEntries)
    const view = render(renderPanel(makeHistoryResult(3), onLoadCommitFiles))

    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)

    view.rerender(renderPanel(makeHistoryResult(6), onLoadCommitFiles))

    await waitFor(() => {
      expect(screen.getAllByTestId('git-history-row')).toHaveLength(6)
    })
    expect(screen.getByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)
  })

  // The other half of the prune: state for a commit the new result dropped must not survive,
  // so a later result that reintroduces the id refetches rather than showing a retained list.
  it('drops expansion and cached files for a commit the new result no longer contains', async () => {
    const onLoadCommitFiles = vi.fn(async () => fileEntries)
    const view = render(renderPanel(makeHistoryResult(3), onLoadCommitFiles))

    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()

    view.rerender(renderPanel(makeHistoryResult(3, 10), onLoadCommitFiles))

    await waitFor(() => {
      expect(screen.queryByText('app.ts')).toBeNull()
    })

    view.rerender(renderPanel(makeHistoryResult(3), onLoadCommitFiles))
    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(2)
  })

  // Sibling worktrees of one repo share almost all history, so a commit can survive the switch.
  // useGitHistoryCommitActions drops its commit-compare cache per worktree, so a row retained
  // across the switch would look expanded while every file click resolved to nothing.
  it('drops expansion and cached files when the worktree changes, even if the commit survives', async () => {
    const onLoadCommitFiles = vi.fn(async () => fileEntries)
    const view = render(renderPanel(makeHistoryResult(3), onLoadCommitFiles, 'wt-a'))

    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)

    view.rerender(renderPanel(makeHistoryResult(3), onLoadCommitFiles, 'wt-b'))

    await waitFor(() => {
      expect(screen.queryByText('app.ts')).toBeNull()
    })

    // Re-expanding must refetch so the sibling commit-compare cache is repopulated.
    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(2)
  })

  // Why: the virtualize threshold equals the page size, so a real first page is already over it and
  // every Load more click by definition operates on a virtualized list. The cases above run the
  // plain path only, which is the one production never takes.
  describe('on the virtualized path a real page takes', () => {
    const virtualized = GIT_HISTORY_VIRTUALIZE_MIN_ROWS + 5
    const VIEWPORT_HEIGHT_PX = 1200

    // happy-dom has no layout, so every rect is zero and the virtualizer would window to nothing.
    // Give the scroller a viewport and the rows their height, and let the test re-fire the
    // observers the way a browser would after content changes a row's height.
    const observers = new Set<{ callback: ResizeObserverCallback; elements: Set<Element> }>()

    function fireResizeObservers(): void {
      for (const observer of observers) {
        const entries = Array.from(observer.elements).map((element) => {
          const rect = element.getBoundingClientRect()
          const size = { blockSize: rect.height, inlineSize: rect.width }
          return {
            target: element,
            contentRect: rect,
            borderBoxSize: [size],
            contentBoxSize: [size],
            devicePixelContentBoxSize: [size]
          } as unknown as ResizeObserverEntry
        })
        if (entries.length > 0) {
          observer.callback(entries, observer as unknown as ResizeObserver)
        }
      }
    }

    beforeEach(() => {
      observers.clear()
      vi.stubGlobal(
        'ResizeObserver',
        class {
          readonly elements = new Set<Element>()
          constructor(readonly callback: ResizeObserverCallback) {
            observers.add(this)
          }
          observe(element: Element): void {
            this.elements.add(element)
            fireResizeObservers()
          }
          unobserve(element: Element): void {
            this.elements.delete(element)
          }
          disconnect(): void {
            this.elements.clear()
            observers.delete(this)
          }
        }
      )
      // The virtualizer sizes its viewport from offsetHeight and measures rows from the rect.
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains('overflow-y-auto')
            ? VIEWPORT_HEIGHT_PX
            : GIT_HISTORY_ROW_HEIGHT_PX
        }
      )
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320)
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: Element) {
          const expandedExtra =
            this.classList.contains('absolute') && this.textContent?.includes('app.ts') ? 120 : 0
          const height = this.classList.contains('overflow-y-auto')
            ? VIEWPORT_HEIGHT_PX
            : GIT_HISTORY_ROW_HEIGHT_PX + expandedExtra
          return {
            top: 0,
            bottom: height,
            height,
            left: 0,
            right: 320,
            width: 320,
            x: 0,
            y: 0,
            toJSON: () => ({})
          } as DOMRect
        }
      )
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    // Why: assert the relationship, not the number. A threshold above the page size would leave
    // production permanently on the unvirtualized path that the cases above already cover.
    it('virtualizes at or before a full first page', () => {
      expect(GIT_HISTORY_VIRTUALIZE_MIN_ROWS).toBeLessThanOrEqual(GIT_HISTORY_DEFAULT_LIMIT)
    })

    it('virtualizes once a page-sized result is on screen, and not before', () => {
      const view = render(
        renderPanel(
          makeHistoryResult(3),
          vi.fn(async () => fileEntries)
        )
      )
      expect(screen.queryByTestId('git-history-virtual-list')).toBeNull()

      view.rerender(
        renderPanel(
          makeHistoryResult(GIT_HISTORY_DEFAULT_LIMIT),
          vi.fn(async () => fileEntries)
        )
      )
      expect(screen.getByTestId('git-history-virtual-list')).toBeTruthy()
    })

    // Why: rows are absolutely positioned off an estimate that assumes one 26px line. An expanded
    // row carries a file list and is far taller, so without measurement the rows below it are
    // positioned on top of it.
    it('measures an expanded row instead of leaving it at the collapsed estimate', async () => {
      const view = render(
        renderPanel(
          makeHistoryResult(virtualized),
          vi.fn(async () => fileEntries)
        )
      )
      const list = screen.getByTestId('git-history-virtual-list')
      const collapsedHeight = Number.parseFloat(list.style.height)
      expect(collapsedHeight).toBe(virtualized * GIT_HISTORY_ROW_HEIGHT_PX)

      fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
      expect(await screen.findByText('app.ts')).toBeTruthy()

      fireResizeObservers()

      await waitFor(() => {
        expect(Number.parseFloat(list.style.height)).toBeGreaterThan(collapsedHeight)
      })
      view.unmount()
    })

    it('keeps an expanded commit expanded, and its files cached, when Load more appends a page', async () => {
      const onLoadCommitFiles = vi.fn(async () => fileEntries)
      const view = render(renderPanel(makeHistoryResult(virtualized), onLoadCommitFiles))

      fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
      expect(await screen.findByText('app.ts')).toBeTruthy()
      expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)

      view.rerender(renderPanel(makeHistoryResult(virtualized + 50), onLoadCommitFiles))

      expect(screen.getByTestId('git-history-virtual-list')).toBeTruthy()
      expect(screen.getByText('app.ts')).toBeTruthy()
      expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)
    })

    // Why: a base-ref change replaces the list, putting different commits at the same indices.
    // State keyed by position rather than commit id would show one commit's files under another.
    it('drops expansion when a replacing result reuses the same row positions', async () => {
      const onLoadCommitFiles = vi.fn(async () => fileEntries)
      const view = render(renderPanel(makeHistoryResult(virtualized), onLoadCommitFiles))

      fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
      expect(await screen.findByText('app.ts')).toBeTruthy()

      view.rerender(
        renderPanel(makeHistoryResult(virtualized, virtualized + 100), onLoadCommitFiles)
      )

      await waitFor(() => {
        expect(screen.queryByText('app.ts')).toBeNull()
      })
    })
  })
})
