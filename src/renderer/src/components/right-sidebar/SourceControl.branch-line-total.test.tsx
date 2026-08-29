// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitBranchCompareSummary } from '../../../../shared/git-diff-compare-types'
import {
  clearBranchLineTotalRequestGateForTests,
  getBranchLineTotalMergeBase
} from './branch-line-total-request-gate'
import SourceControl from './SourceControl'

const MERGE_BASE = '1f3c0d9a5b6e7f8091a2b3c4d5e6f708192a3b4c'

const mocks = vi.hoisted(() => {
  const activeRepo = {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git' as string
  }
  const activeWorktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt',
    head: 'head-1',
    branch: 'refs/heads/feature/line-total',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature/line-total',
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

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(true)
}))

vi.mock('./git-status-refresh', () => ({
  refreshGitStatusForWorktree: vi.fn().mockResolvedValue(undefined),
  refreshGitStatusForWorktreeStrict: vi.fn().mockResolvedValue(undefined)
}))

function noopAsync(value: unknown = undefined): () => Promise<unknown> {
  return vi.fn().mockResolvedValue(value)
}

const readySummary: GitBranchCompareSummary = {
  baseRef: 'refs/remotes/origin/main',
  baseOid: 'base-oid',
  compareRef: 'feature/line-total',
  headOid: 'head-1',
  mergeBase: MERGE_BASE,
  changedFiles: 2,
  commitsAhead: 1,
  status: 'ready'
}

function resetState(overrides: Partial<Record<string, unknown>> = {}): void {
  vi.clearAllMocks()
  mocks.activeRepo.kind = 'git'
  mocks.state = {
    activeWorktreeId: mocks.activeWorktree.id,
    activeGroupIdByWorktree: { [mocks.activeWorktree.id]: 'group-1' },
    groupsByWorktree: { [mocks.activeWorktree.id]: [{ id: 'group-1', activeTabId: null }] },
    repos: [mocks.activeRepo],
    worktreesByRepo: { [mocks.activeRepo.id]: [mocks.activeWorktree] },
    rightSidebarOpen: true,
    rightSidebarTab: 'source-control',
    gitStatusByWorktree: { [mocks.activeWorktree.id]: [] },
    gitBranchChangesByWorktree: { [mocks.activeWorktree.id]: [] },
    gitBranchCompareSummaryByWorktree: { [mocks.activeWorktree.id]: readySummary },
    gitBranchLineTotalByWorktree: {},
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

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  clearBranchLineTotalRequestGateForTests()
  resetState()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearBranchLineTotalRequestGateForTests()
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

function chip(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="source-control-branch-line-total"]')
}

function loadingChip(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="source-control-branch-line-total-loading"]'
  )
}

describe('SourceControl branch line total request gate', () => {
  it('asks for a total when the panel is visible and compare is ready', () => {
    renderSourceControl()

    expect(getBranchLineTotalMergeBase(mocks.activeWorktree.id)).toBe(MERGE_BASE)
  })

  it('asks for nothing while the sidebar is closed', () => {
    resetState({ rightSidebarOpen: false })
    renderSourceControl()

    expect(getBranchLineTotalMergeBase(mocks.activeWorktree.id)).toBeUndefined()
  })

  it('asks for nothing while another right-sidebar tab is showing', () => {
    resetState({ rightSidebarTab: 'checks' })
    renderSourceControl()

    expect(getBranchLineTotalMergeBase(mocks.activeWorktree.id)).toBeUndefined()
  })

  it('asks for nothing until branch compare is ready', () => {
    resetState({
      gitBranchCompareSummaryByWorktree: {
        [mocks.activeWorktree.id]: { ...readySummary, status: 'loading' }
      }
    })
    renderSourceControl()

    expect(getBranchLineTotalMergeBase(mocks.activeWorktree.id)).toBeUndefined()
  })

  it('asks for nothing when compare has no merge base', () => {
    resetState({
      gitBranchCompareSummaryByWorktree: {
        [mocks.activeWorktree.id]: { ...readySummary, status: 'invalid-base' }
      }
    })
    renderSourceControl()

    expect(getBranchLineTotalMergeBase(mocks.activeWorktree.id)).toBeUndefined()
  })

  it('asks for nothing in a folder workspace', () => {
    resetState()
    mocks.activeRepo.kind = 'folder'
    renderSourceControl()

    expect(getBranchLineTotalMergeBase(mocks.activeWorktree.id)).toBeUndefined()
  })

  it('releases the gate when the panel unmounts', () => {
    renderSourceControl()
    expect(getBranchLineTotalMergeBase(mocks.activeWorktree.id)).toBe(MERGE_BASE)

    act(() => root.render(<TooltipProvider>{null}</TooltipProvider>))

    expect(getBranchLineTotalMergeBase(mocks.activeWorktree.id)).toBeUndefined()
  })
})

describe('SourceControl branch line total chip', () => {
  it('renders a total measured against the current fork point', () => {
    resetState({
      gitBranchLineTotalByWorktree: {
        [mocks.activeWorktree.id]: { added: 8259, removed: 670, mergeBase: MERGE_BASE }
      }
    })
    renderSourceControl()

    expect(chip()?.getAttribute('aria-label')).toBe('8259 lines added, 670 lines deleted')
    // Grouping is pinned to the app locale (`en`), not the runner's host locale.
    expect(chip()?.textContent).toBe('+8,259-670')
  })

  it('drops a total whose fork point has since moved', () => {
    // Why: status and branch compare refresh on different cadences, so a total
    // can outlive the merge base it measured. Stale digits must not render.
    resetState({
      gitBranchLineTotalByWorktree: {
        [mocks.activeWorktree.id]: { added: 8259, removed: 670, mergeBase: 'stale-merge-base' }
      }
    })
    renderSourceControl()

    expect(chip()).toBeNull()
    expect(loadingChip()).toBeNull()
  })

  it('drops a published total while branch compare has no ready summary', () => {
    resetState({
      gitBranchCompareSummaryByWorktree: {
        [mocks.activeWorktree.id]: { ...readySummary, status: 'loading', mergeBase: '' }
      },
      gitBranchLineTotalByWorktree: {
        [mocks.activeWorktree.id]: { added: 8259, removed: 670, mergeBase: MERGE_BASE }
      }
    })
    renderSourceControl()

    expect(chip()).toBeNull()
    expect(loadingChip()).toBeNull()
  })

  // Why: a pending total and one this host will never send look identical from
  // here, so a pulsing placeholder would keep pulsing forever on an old host,
  // after a hard failure, or during the ranged-diff cooldown.
  it('shows no placeholder while the total is still pending', () => {
    vi.useFakeTimers()
    try {
      renderSourceControl()

      expect(chip()).toBeNull()
      act(() => {
        vi.advanceTimersByTime(20_000)
      })
      expect(chip()).toBeNull()
      expect(loadingChip()).toBeNull()
      expect(container.innerHTML).not.toContain('animate-pulse')
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders nothing for an exact zero total', () => {
    resetState({
      gitBranchLineTotalByWorktree: {
        [mocks.activeWorktree.id]: { added: 0, removed: 0, mergeBase: MERGE_BASE }
      }
    })
    renderSourceControl()

    expect(chip()).toBeNull()
    expect(loadingChip()).toBeNull()
  })

  it('omits the zero half of a one-sided total', () => {
    resetState({
      gitBranchLineTotalByWorktree: {
        [mocks.activeWorktree.id]: { added: 42, removed: 0, mergeBase: MERGE_BASE }
      }
    })
    renderSourceControl()

    expect(chip()?.textContent).toBe('+42')
    expect(chip()?.getAttribute('aria-label')).toBe('42 lines added')
  })
})
