// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import type { GitBranchCompareSummary } from '../../../../shared/git-diff-compare-types'
import { toBranchCompareSnapshot } from '@/store/slices/editor/git/git-status-reconciliation'
import SourceControl from './SourceControl'

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
    branch: 'refs/heads/feature/open-file-highlight',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature/open-file-highlight',
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
    isFolder: false,
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
    repoId === mocks.activeRepo.id
      ? { ...mocks.activeRepo, kind: mocks.isFolder ? 'folder' : 'git' }
      : null,
  useWorktreeMap: () => new Map([[mocks.activeWorktree.id, mocks.activeWorktree]])
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(true)
}))

vi.mock('./git-status-refresh', () => ({
  refreshGitStatusForWorktree: vi.fn().mockResolvedValue(undefined)
}))

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

type OpenFileStub = {
  id: string
  worktreeId: string
  relativePath: string
  diffSource?: string
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
    openFiles: [] as OpenFileStub[],
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
  resetState()
  mocks.isFolder = false
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderSourceControl(renderKey = 0): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <SourceControl key={renderKey} />
      </TooltipProvider>
    )
  })
}

function row(path: string, area: GitStatusEntry['area'] | 'branch'): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>(
    `[data-source-control-path="${path}"][data-source-control-area="${area}"]`
  )
}

function isHighlighted(element: HTMLElement | null): boolean {
  if (!element) {
    return false
  }
  return (
    element.getAttribute('data-current') === 'true' &&
    element.classList.contains('bg-accent') &&
    !element.classList.contains('bg-accent/60')
  )
}

describe('SourceControl open-file highlight', () => {
  it.each(['list', 'tree'] as const)('marks the active committed comparison in %s mode', (mode) => {
    const summary: GitBranchCompareSummary = {
      baseRef: 'main',
      baseOid: 'base-1',
      compareRef: 'feature',
      headOid: 'head-1',
      mergeBase: 'merge-1',
      changedFiles: 2,
      status: 'ready'
    }
    const entry = { path: 'src/file.ts', status: 'modified' as const, added: 1, removed: 0 }
    resetState({
      settings: { sourceControlViewMode: mode },
      gitStatusByWorktree: { 'wt-1': [gitEntry({})] },
      gitBranchChangesByWorktree: { 'wt-1': [entry, { ...entry, path: 'src/other.ts' }] },
      gitBranchCompareSummaryByWorktree: { 'wt-1': summary }
    })
    renderSourceControl()
    const branchRow = row(entry.path, 'branch')
    expect(branchRow).not.toBeNull()
    act(() => branchRow?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(mocks.state.openBranchDiff).toHaveBeenCalledWith(
      'wt-1',
      '/repo/wt',
      entry,
      summary,
      'typescript',
      { targetGroupId: undefined, preview: true }
    )

    const tab = {
      id: 'branch-tab',
      worktreeId: 'wt-1',
      relativePath: entry.path,
      diffSource: 'branch',
      branchCompare: toBranchCompareSnapshot(summary)
    }
    mocks.state.openFiles = [tab]
    mocks.state.activeFileIdByWorktree = { 'wt-1': tab.id }
    mocks.state.activeTabTypeByWorktree = { 'wt-1': 'editor' }
    renderSourceControl(1)
    expect(isHighlighted(row(entry.path, 'branch'))).toBe(true)
    expect(isHighlighted(row('src/other.ts', 'branch'))).toBe(false)
    expect(isHighlighted(row(entry.path, 'unstaged'))).toBe(false)

    mocks.state.gitBranchCompareSummaryByWorktree = { 'wt-1': { ...summary, headOid: 'head-2' } }
    renderSourceControl(2)
    expect(isHighlighted(row(entry.path, 'branch'))).toBe(false)
    mocks.state.gitBranchCompareSummaryByWorktree = { 'wt-1': summary }
    mocks.state.activeTabTypeByWorktree = { 'wt-1': 'terminal' }
    renderSourceControl(3)
    expect(isHighlighted(row(entry.path, 'branch'))).toBe(false)
    mocks.state.activeTabTypeByWorktree = { 'wt-1': 'editor' }
    mocks.state.openFiles = [{ ...tab, worktreeId: 'another-workspace' }]
    renderSourceControl(4)
    expect(isHighlighted(row(entry.path, 'branch'))).toBe(false)
    mocks.state.openFiles = [{ ...tab, diffSource: 'combined-branch' }]
    renderSourceControl(5)
    expect(isHighlighted(row(entry.path, 'branch'))).toBe(false)
  })

  it('renders no committed row for a folder workspace without a branch summary', () => {
    mocks.isFolder = true
    resetState({
      gitBranchChangesByWorktree: { 'wt-1': [{ path: 'src/file.ts', status: 'modified' }] }
    })
    renderSourceControl()
    expect(row('src/file.ts', 'branch')).toBeNull()
    expect(mocks.state.beginGitBranchCompareRequest).not.toHaveBeenCalled()
  })

  it('highlights the row whose unstaged diff is the active editor tab', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({ path: 'src/file.ts', area: 'unstaged' }),
          gitEntry({ path: 'src/other.ts', area: 'unstaged' })
        ]
      },
      openFiles: [
        {
          id: 'tab-1',
          worktreeId: mocks.activeWorktree.id,
          relativePath: 'src/file.ts',
          diffSource: 'unstaged'
        }
      ],
      activeFileIdByWorktree: { [mocks.activeWorktree.id]: 'tab-1' },
      activeTabTypeByWorktree: { [mocks.activeWorktree.id]: 'editor' }
    })
    renderSourceControl()

    expect(isHighlighted(row('src/file.ts', 'unstaged'))).toBe(true)
    expect(isHighlighted(row('src/other.ts', 'unstaged'))).toBe(false)
  })

  it('matches by area so only the staged row of a partially staged file lights up', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({ path: 'src/file.ts', area: 'staged' }),
          gitEntry({ path: 'src/file.ts', area: 'unstaged' })
        ]
      },
      openFiles: [
        {
          id: 'tab-1',
          worktreeId: mocks.activeWorktree.id,
          relativePath: 'src/file.ts',
          diffSource: 'staged'
        }
      ],
      activeFileIdByWorktree: { [mocks.activeWorktree.id]: 'tab-1' },
      activeTabTypeByWorktree: { [mocks.activeWorktree.id]: 'editor' }
    })
    renderSourceControl()

    expect(isHighlighted(row('src/file.ts', 'staged'))).toBe(true)
    expect(isHighlighted(row('src/file.ts', 'unstaged'))).toBe(false)
  })

  it('highlights the untracked row when an untracked file is open as an unstaged diff', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({ path: 'src/new.ts', area: 'untracked', status: 'untracked' })
        ]
      },
      openFiles: [
        {
          id: 'tab-1',
          worktreeId: mocks.activeWorktree.id,
          relativePath: 'src/new.ts',
          diffSource: 'unstaged'
        }
      ],
      activeFileIdByWorktree: { [mocks.activeWorktree.id]: 'tab-1' },
      activeTabTypeByWorktree: { [mocks.activeWorktree.id]: 'editor' }
    })
    renderSourceControl()

    expect(isHighlighted(row('src/new.ts', 'untracked'))).toBe(true)
  })

  it('does not highlight any row when the visible tab is not an editor', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [gitEntry({ path: 'src/file.ts', area: 'unstaged' })]
      },
      openFiles: [
        {
          id: 'tab-1',
          worktreeId: mocks.activeWorktree.id,
          relativePath: 'src/file.ts',
          diffSource: 'unstaged'
        }
      ],
      activeFileIdByWorktree: { [mocks.activeWorktree.id]: 'tab-1' },
      activeTabTypeByWorktree: { [mocks.activeWorktree.id]: 'terminal' }
    })
    renderSourceControl()

    expect(isHighlighted(row('src/file.ts', 'unstaged'))).toBe(false)
  })

  it('does not highlight pending rows for branch compare tabs with the same path', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [gitEntry({ path: 'src/file.ts', area: 'unstaged' })]
      },
      openFiles: [
        {
          id: 'tab-1',
          worktreeId: mocks.activeWorktree.id,
          relativePath: 'src/file.ts',
          diffSource: 'branch'
        }
      ],
      activeFileIdByWorktree: { [mocks.activeWorktree.id]: 'tab-1' },
      activeTabTypeByWorktree: { [mocks.activeWorktree.id]: 'editor' }
    })
    renderSourceControl()

    expect(isHighlighted(row('src/file.ts', 'unstaged'))).toBe(false)
  })

  it('falls back to a staged-only row for an ordinary editor tab', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [gitEntry({ path: 'src/file.ts', area: 'staged' })]
      },
      openFiles: [
        {
          id: 'tab-1',
          worktreeId: mocks.activeWorktree.id,
          relativePath: 'src/file.ts'
        }
      ],
      activeFileIdByWorktree: { [mocks.activeWorktree.id]: 'tab-1' },
      activeTabTypeByWorktree: { [mocks.activeWorktree.id]: 'editor' }
    })
    renderSourceControl()

    expect(isHighlighted(row('src/file.ts', 'staged'))).toBe(true)
  })

  it('falls back to the visible staged row when the working-tree section is collapsed', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({ path: 'src/file.ts', area: 'staged' }),
          gitEntry({ path: 'src/file.ts', area: 'unstaged' })
        ]
      },
      openFiles: [
        {
          id: 'tab-1',
          worktreeId: mocks.activeWorktree.id,
          relativePath: 'src/file.ts'
        }
      ],
      activeFileIdByWorktree: { [mocks.activeWorktree.id]: 'tab-1' },
      activeTabTypeByWorktree: { [mocks.activeWorktree.id]: 'editor' }
    })
    renderSourceControl()

    const changesHeader = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Changes')
    )
    expect(changesHeader).toBeTruthy()
    act(() => {
      changesHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(row('src/file.ts', 'unstaged')).toBeNull()
    expect(isHighlighted(row('src/file.ts', 'staged'))).toBe(true)
  })
})
