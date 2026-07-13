// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitStatusEntry } from '../../../../shared/types'
import SourceControl from './SourceControl'
import {
  SOURCE_CONTROL_FILE_ROW_HEIGHT_PX,
  SOURCE_CONTROL_FILE_ROW_OVERSCAN,
  SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS
} from './source-control-virtual-file-list'

const mocks = vi.hoisted(() => {
  const activeRepo = {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0
  }
  const activeWorktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt',
    head: 'abcdef123',
    branch: 'refs/heads/feature/virtual-list',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature/virtual-list',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  return {
    activeRepo,
    activeWorktree,
    state: {} as Record<string, unknown>
  }
})

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) =>
      selector ? selector(mocks.state) : mocks.state,
    {
      getState: () => mocks.state
    }
  )
  return { useAppStore }
})

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => mocks.activeWorktree,
  useRepoById: (repoId: string | null) =>
    repoId === mocks.activeRepo.id ? mocks.activeRepo : null,
  useWorktreeMap: () => new Map([[mocks.activeWorktree.id, mocks.activeWorktree]])
}))

vi.mock('@/components/confirmation-dialog', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(true)
}))

vi.mock('./git-status-refresh', () => ({
  refreshGitStatusForWorktree: vi.fn().mockResolvedValue(undefined)
}))

const VIEWPORT_HEIGHT_PX = 600
// Rows the viewport can show plus overscan on both edges plus the partial
// rows clipped at each edge of the window.
const MAX_MOUNTED_ROWS =
  Math.ceil(VIEWPORT_HEIGHT_PX / SOURCE_CONTROL_FILE_ROW_HEIGHT_PX) +
  2 * SOURCE_CONTROL_FILE_ROW_OVERSCAN +
  2

function gitEntry(overrides: Partial<GitStatusEntry>): GitStatusEntry {
  return {
    path: 'src/file.ts',
    area: 'unstaged',
    status: 'modified',
    added: 1,
    removed: 0,
    ...overrides
  }
}

function manyEntries(count: number): GitStatusEntry[] {
  return Array.from({ length: count }, (_, index) =>
    gitEntry({ path: `src/file-${String(index).padStart(3, '0')}.ts` })
  )
}

function noopAsync(value: unknown = undefined): () => Promise<unknown> {
  return vi.fn().mockResolvedValue(value)
}

function resetState(overrides: Partial<Record<string, unknown>> = {}): void {
  vi.clearAllMocks()
  mocks.state = {
    activeWorktreeId: mocks.activeWorktree.id,
    activeGroupIdByWorktree: { [mocks.activeWorktree.id]: 'group-1' },
    groupsByWorktree: { [mocks.activeWorktree.id]: [{ id: 'group-1', activeTabId: null }] },
    repos: [mocks.activeRepo],
    worktreesByRepo: { [mocks.activeRepo.id]: [mocks.activeWorktree] },
    rightSidebarOpen: false,
    rightSidebarTab: 'source-control',
    gitStatusByWorktree: { [mocks.activeWorktree.id]: [] },
    gitBranchChangesByWorktree: { [mocks.activeWorktree.id]: [] },
    gitBranchCompareSummaryByWorktree: { [mocks.activeWorktree.id]: null },
    gitConflictOperationByWorktree: {},
    remoteStatusesByWorktree: {},
    isRemoteOperationActive: false,
    inFlightRemoteOpKind: null,
    settings: null,
    hostedReviewCache: {},
    prCache: {},
    commitMessageGenerationRecords: {},
    pullRequestGenerationRecords: {},
    openFiles: [],
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    getDiffComments: vi.fn(() => []),
    updateSettings: noopAsync(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    fetchHostedReviewForBranch: noopAsync(),
    getHostedReviewCreationEligibility: noopAsync(null),
    createHostedReview: noopAsync({ ok: false, error: 'not available' }),
    updateWorktreeMeta: noopAsync(),
    fetchPRForBranch: noopAsync(),
    enqueueGitHubPRRefresh: vi.fn(),
    updateRepo: noopAsync(),
    setGitStatus: vi.fn(),
    updateWorktreeGitIdentity: vi.fn(),
    beginGitBranchCompareRequest: vi.fn(() => 'request-key'),
    setGitBranchCompareResult: vi.fn(),
    clearGitBranchCompare: vi.fn(),
    fetchUpstreamStatus: noopAsync(),
    setUpstreamStatus: vi.fn(),
    pushBranch: noopAsync(),
    pullBranch: noopAsync(),
    fastForwardBranch: noopAsync(),
    syncBranch: noopAsync(),
    rebaseFromBase: noopAsync(),
    fetchBranch: noopAsync(),
    revealInExplorer: vi.fn(),
    trackConflictPath: vi.fn(),
    openDiff: vi.fn(),
    openFile: vi.fn(),
    setEditorViewMode: vi.fn(),
    setMarkdownViewMode: vi.fn(),
    setPendingEditorReveal: vi.fn(),
    openConflictFile: vi.fn(),
    openConflictReview: vi.fn(),
    openBranchDiff: vi.fn(),
    createEmptySplitGroup: vi.fn(() => 'group-2'),
    openAllDiffs: vi.fn(),
    openBranchAllDiffs: vi.fn(),
    openCommitAllDiffs: vi.fn(),
    deleteDiffComment: noopAsync(true),
    clearDiffComments: noopAsync(true),
    clearDiffCommentsForFile: noopAsync(true),
    setScrollToDiffCommentId: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    setRightSidebarTab: vi.fn(),
    allocateCommitMessageGenerationRequestId: vi.fn(() => 'commit-generation-1'),
    setCommitMessageGenerationRecord: vi.fn(),
    updateCommitMessageGenerationRecord: vi.fn(),
    pruneCommitMessageGenerationRecords: vi.fn(),
    allocatePullRequestGenerationRequestId: vi.fn(() => 'pr-generation-1'),
    setPullRequestGenerationRecord: vi.fn(),
    updatePullRequestGenerationRecord: vi.fn(),
    prunePullRequestGenerationRecords: vi.fn(),
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  resetState()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  // Why: happy-dom has no layout. Give the virtualizer a 600px scroll viewport
  // and 24px rows (both rect + row measurement read offsetHeight), and keep
  // the observer path inert so measurements stay deterministic.
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('overflow-auto')
        ? VIEWPORT_HEIGHT_PX
        : SOURCE_CONTROL_FILE_ROW_HEIGHT_PX
    }
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    // The panel scroller acts as the fixed viewport; everything inside it
    // shifts up by scrollTop, which is what the list's scroll-margin math
    // reads. Leaf rows only ever contribute their 24px height.
    const isScroller = this.classList.contains('overflow-auto')
    const scroller = isScroller ? null : this.closest('.overflow-auto')
    const top = isScroller ? 0 : -(scroller?.scrollTop ?? 0)
    return {
      top,
      bottom: top + SOURCE_CONTROL_FILE_ROW_HEIGHT_PX,
      height: SOURCE_CONTROL_FILE_ROW_HEIGHT_PX,
      left: 0,
      right: 240,
      width: 240,
      x: 0,
      y: top,
      toJSON: () => ({})
    } as DOMRect
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderSourceControl(): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <SourceControl />
      </TooltipProvider>
    )
  })
}

function scroller(): HTMLDivElement {
  const element = container.querySelector<HTMLDivElement>('.overflow-auto')
  if (!element) {
    throw new Error('source control scroller not found')
  }
  return element
}

function scrollTo(offset: number): void {
  const element = scroller()
  // Why: happy-dom clamps scrollTop against its zero-height layout; pin the
  // property so the virtualizer's scroll handler reads the intended offset.
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    writable: true,
    value: offset
  })
  act(() => {
    element.dispatchEvent(new Event('scroll'))
  })
}

function mountedRows(): HTMLDivElement[] {
  return Array.from(
    container.querySelectorAll<HTMLDivElement>('[data-testid="source-control-entry"]')
  )
}

function row(path: string): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>(
    `[data-source-control-path="${path}"][data-source-control-area="unstaged"]`
  )
}

function virtualList(): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>('[data-testid="source-control-virtual-list"]')
}

describe('SourceControl virtualized changed-files list', () => {
  it('bounds mounted rows by viewport + overscan with 500 entries', () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: manyEntries(500) }
    })
    renderSourceControl()

    expect(virtualList()).toBeTruthy()
    const mounted = mountedRows().length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
  })

  it('windows rows while scrolling instead of mounting the tail', () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: manyEntries(500) }
    })
    renderSourceControl()

    expect(row('src/file-000.ts')).toBeTruthy()
    expect(row('src/file-250.ts')).toBeNull()

    scrollTo(250 * SOURCE_CONTROL_FILE_ROW_HEIGHT_PX)

    expect(row('src/file-250.ts')).toBeTruthy()
    expect(row('src/file-000.ts')).toBeNull()
    expect(mountedRows().length).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
  })

  it('keeps row selection across the virtualized boundary', () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: manyEntries(500) }
    })
    renderSourceControl()

    const target = row('src/file-000.ts')
    expect(target).toBeTruthy()
    act(() => {
      target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    expect(row('src/file-000.ts')?.className).toContain('bg-accent/60')
    expect(container.textContent).toContain('1 selected')

    // The selected row scrolls out of the mounted window but stays selected.
    scrollTo(240 * SOURCE_CONTROL_FILE_ROW_HEIGHT_PX)
    expect(row('src/file-000.ts')).toBeNull()
    expect(container.textContent).toContain('1 selected')

    scrollTo(0)
    expect(row('src/file-000.ts')?.className).toContain('bg-accent/60')
  })

  it('collapses and re-expands a virtualized section', () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: manyEntries(500) }
    })
    renderSourceControl()
    expect(mountedRows().length).toBeGreaterThan(0)

    const changesHeader = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Changes')
    )
    expect(changesHeader).toBeTruthy()

    act(() => {
      changesHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mountedRows().length).toBe(0)
    expect(virtualList()).toBeNull()

    act(() => {
      changesHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mountedRows().length).toBeGreaterThan(0)
    expect(mountedRows().length).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
  })

  it('keeps the scroll offset and window when a refresh delivers identical entries', () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: manyEntries(500) }
    })
    renderSourceControl()

    scrollTo(100 * SOURCE_CONTROL_FILE_ROW_HEIGHT_PX)
    expect(row('src/file-100.ts')).toBeTruthy()
    const heightBefore = virtualList()?.style.height

    // A status refresh rebuilds every entry object with identical content.
    mocks.state = {
      ...mocks.state,
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: manyEntries(500).map((entry) => ({ ...entry }))
      }
    }
    renderSourceControl()

    expect(scroller().scrollTop).toBe(100 * SOURCE_CONTROL_FILE_ROW_HEIGHT_PX)
    expect(row('src/file-100.ts')).toBeTruthy()
    expect(virtualList()?.style.height).toBe(heightBefore)
  })

  it('renders small changesets in full without the virtualization container', () => {
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts']
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: paths.map((path) => gitEntry({ path }))
      }
    })
    renderSourceControl()

    expect(paths.length).toBeLessThan(SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS)
    expect(virtualList()).toBeNull()
    expect(mountedRows().length).toBe(paths.length)
    for (const path of paths) {
      expect(row(path)).toBeTruthy()
    }
  })

  it('bounds mounted tree-view rows for large changesets', () => {
    resetState({
      settings: { sourceControlViewMode: 'tree' },
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: Array.from({ length: 500 }, (_, index) =>
          gitEntry({
            path: `src/dir-${String(Math.floor(index / 20)).padStart(2, '0')}/file-${String(
              index
            ).padStart(3, '0')}.ts`
          })
        )
      }
    })
    renderSourceControl()

    expect(virtualList()).toBeTruthy()
    const mounted = container.querySelectorAll(
      '[data-testid="source-control-virtual-list"] [data-index]'
    ).length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
  })
})
