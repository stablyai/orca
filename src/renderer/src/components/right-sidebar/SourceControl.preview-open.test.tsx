// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitStatusEntry
} from '../../../../shared/types'
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
    branch: 'refs/heads/feature/source-control-preview',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature/source-control-preview',
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
  const calls = {
    openDiff: vi.fn(),
    openFile: vi.fn(),
    openConflictFile: vi.fn(),
    openConflictReview: vi.fn(),
    openBranchDiff: vi.fn(),
    openAllDiffs: vi.fn(),
    openBranchAllDiffs: vi.fn(),
    createEmptySplitGroup: vi.fn(),
    activateAndRevealWorktree: vi.fn(),
    discardRuntimeGitPath: vi.fn(),
    refreshGitStatusForWorktree: vi.fn(),
    requestEditorSaveQuiesce: vi.fn(),
    notifyEditorExternalFileChange: vi.fn()
  }
  return {
    activeRepo,
    activeWorktree,
    calls,
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

vi.mock('@/runtime/runtime-git-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    discardRuntimeGitPath: mocks.calls.discardRuntimeGitPath
  }
})

vi.mock('@/components/editor/editor-autosave', () => ({
  requestEditorSaveQuiesce: mocks.calls.requestEditorSaveQuiesce,
  notifyEditorExternalFileChange: mocks.calls.notifyEditorExternalFileChange
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.calls.activateAndRevealWorktree
}))

vi.mock('./git-status-refresh', () => ({
  refreshGitStatusForWorktree: mocks.calls.refreshGitStatusForWorktree
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

function branchEntry(overrides: Partial<GitBranchChangeEntry> = {}): GitBranchChangeEntry {
  return {
    path: 'src/branch.ts',
    status: 'modified',
    added: 2,
    removed: 1,
    ...overrides
  }
}

function branchSummary(): GitBranchCompareSummary {
  return {
    baseRef: 'origin/main',
    baseOid: 'base',
    compareRef: 'feature/source-control-preview',
    headOid: 'head',
    mergeBase: 'base',
    changedFiles: 1,
    commitsAhead: 1,
    status: 'ready'
  }
}

function noopAsync(value: unknown = undefined): () => Promise<unknown> {
  return vi.fn().mockResolvedValue(value)
}

function resetState(overrides: Partial<Record<string, unknown>> = {}): void {
  vi.clearAllMocks()
  mocks.calls.createEmptySplitGroup.mockReturnValue('group-2')
  mocks.calls.discardRuntimeGitPath.mockResolvedValue(undefined)
  mocks.calls.refreshGitStatusForWorktree.mockResolvedValue(undefined)
  mocks.calls.requestEditorSaveQuiesce.mockResolvedValue(undefined)
  mocks.state = {
    activeWorktreeId: mocks.activeWorktree.id,
    getKnownWorktreeById: vi.fn((worktreeId: string) =>
      worktreeId === mocks.activeWorktree.id ? mocks.activeWorktree : null
    ),
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
    openDiff: mocks.calls.openDiff,
    openFile: mocks.calls.openFile,
    setEditorViewMode: vi.fn(),
    setMarkdownViewMode: vi.fn(),
    setPendingEditorReveal: vi.fn(),
    openConflictFile: mocks.calls.openConflictFile,
    openConflictReview: mocks.calls.openConflictReview,
    openBranchDiff: mocks.calls.openBranchDiff,
    createEmptySplitGroup: mocks.calls.createEmptySplitGroup,
    openAllDiffs: mocks.calls.openAllDiffs,
    openBranchAllDiffs: mocks.calls.openBranchAllDiffs,
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderSourceControl(props: React.ComponentProps<typeof SourceControl> = {}): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <SourceControl {...props} />
      </TooltipProvider>
    )
  })
}

function clickUncommitted(path: string, init: MouseEventInit = {}): void {
  const row = container.querySelector<HTMLDivElement>(`[data-source-control-path="${path}"]`)
  expect(row).not.toBeNull()
  act(() => {
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
}

function doubleClickUncommitted(path: string): void {
  const row = container.querySelector<HTMLDivElement>(`[data-source-control-path="${path}"]`)
  expect(row).not.toBeNull()
  act(() => {
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
}

function clickBranchRow(init: MouseEventInit = {}): void {
  const label = [...container.querySelectorAll('span')].find(
    (candidate) => candidate.textContent === 'branch.ts'
  )
  const row = label?.closest('div')
  expect(row).not.toBeNull()
  act(() => {
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
}

function clickViewAllButton(): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === 'View all'
  )
  expect(button).not.toBeNull()
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function waitForCondition(assertion: () => void): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
  }
  throw lastError
}

describe('SourceControl preview row opens', () => {
  it('shows Create PR chrome in embedded scoped worktree source control', async () => {
    resetState({
      rightSidebarOpen: true,
      getHostedReviewCreationEligibility: vi.fn().mockResolvedValue({
        provider: 'github',
        review: null,
        canCreate: true,
        blockedReason: null,
        nextAction: null
      }),
      remoteStatusesByWorktree: {
        [mocks.activeWorktree.id]: {
          hasUpstream: true,
          upstreamName: 'origin/feature/source-control-preview',
          ahead: 0,
          behind: 0
        }
      },
      gitBranchCompareSummaryByWorktree: {
        [mocks.activeWorktree.id]: branchSummary()
      }
    })

    renderSourceControl({ worktreeId: mocks.activeWorktree.id, embedded: true })

    await waitForCondition(() => {
      expect(container.textContent).toContain('Create PR')
    })
  })

  it('passes preview=true when plain uncommitted row clicks open diff tabs', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({ path: 'src/file.ts' }),
          gitEntry({ path: 'src/staged.ts', area: 'staged' })
        ]
      }
    })
    renderSourceControl()

    clickUncommitted('src/file.ts')
    clickUncommitted('src/staged.ts')

    expect(mocks.calls.openDiff).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt/src/file.ts',
      'src/file.ts',
      'typescript',
      false,
      { targetGroupId: undefined, preview: true }
    )
    expect(mocks.calls.openDiff).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt/src/staged.ts',
      'src/staged.ts',
      'typescript',
      true,
      { targetGroupId: undefined, preview: true }
    )
  })

  it('keeps modifier split row opens permanent and targeted at the split group', () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: [gitEntry({ path: 'src/file.ts' })] }
    })
    renderSourceControl()

    clickUncommitted('src/file.ts', { ctrlKey: true })

    expect(mocks.calls.createEmptySplitGroup).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      'group-1',
      'right'
    )
    expect(mocks.calls.openDiff).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt/src/file.ts',
      'src/file.ts',
      'typescript',
      false,
      { targetGroupId: 'group-2', preview: false }
    )
  })

  it('keeps explicit permanent uncommitted opens permanent', () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: [gitEntry({ path: 'src/file.ts' })] }
    })
    renderSourceControl()

    doubleClickUncommitted('src/file.ts')

    expect(mocks.calls.openDiff).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt/src/file.ts',
      'src/file.ts',
      'typescript',
      false,
      { targetGroupId: undefined, preview: false }
    )
  })

  it('passes preview through markdown edit-in-changes and conflict file opens', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({ path: 'docs/readme.md' }),
          gitEntry({
            path: 'src/conflict.ts',
            conflictKind: 'both_modified',
            conflictStatus: 'unresolved'
          })
        ]
      }
    })
    renderSourceControl()

    clickUncommitted('docs/readme.md')
    clickUncommitted('src/conflict.ts')

    expect(mocks.calls.openFile).toHaveBeenCalledWith(
      {
        filePath: '/repo/wt/docs/readme.md',
        relativePath: 'docs/readme.md',
        worktreeId: mocks.activeWorktree.id,
        language: 'markdown',
        mode: 'edit'
      },
      { targetGroupId: undefined, preview: true }
    )
    expect(mocks.calls.openConflictFile).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt',
      expect.objectContaining({ path: 'src/conflict.ts' }),
      'typescript',
      { targetGroupId: undefined, preview: true }
    )
  })

  it('scopes discard autosave quiesce and reload notifications to the active runtime', async () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: [gitEntry({ path: 'src/file.ts' })] }
    })
    renderSourceControl()
    mocks.state.settings = { activeRuntimeEnvironmentId: 'runtime-remote' }

    const row = container.querySelector<HTMLDivElement>('[data-source-control-path="src/file.ts"]')
    const discardButton = row?.querySelector<HTMLButtonElement>(
      'button[aria-label="Discard changes"]'
    )
    expect(discardButton).not.toBeNull()
    act(() => {
      discardButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const confirmButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Discard'
    )
    expect(confirmButton).not.toBeNull()
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mocks.calls.requestEditorSaveQuiesce).toHaveBeenCalledWith({
      worktreeId: mocks.activeWorktree.id,
      worktreePath: '/repo/wt',
      relativePath: 'src/file.ts',
      runtimeEnvironmentId: 'runtime-remote'
    })
    expect(mocks.calls.notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: mocks.activeWorktree.id,
      worktreePath: '/repo/wt',
      relativePath: 'src/file.ts',
      runtimeEnvironmentId: 'runtime-remote'
    })
  })

  it('routes embedded git mutations through the scoped worktree host owner', async () => {
    const hostedWorktree = { ...mocks.activeWorktree, hostId: 'runtime:worktree-env' }
    resetState({
      activeWorktreeId: 'folder:folder-1',
      settings: { activeRuntimeEnvironmentId: 'focused-env' },
      getKnownWorktreeById: vi.fn((worktreeId: string) =>
        worktreeId === hostedWorktree.id ? hostedWorktree : null
      ),
      worktreesByRepo: { [mocks.activeRepo.id]: [hostedWorktree] },
      gitStatusByWorktree: { [hostedWorktree.id]: [gitEntry({ path: 'src/file.ts' })] }
    })
    renderSourceControl({ worktreeId: hostedWorktree.id, embedded: true })

    const row = container.querySelector<HTMLDivElement>('[data-source-control-path="src/file.ts"]')
    const discardButton = row?.querySelector<HTMLButtonElement>(
      'button[aria-label="Discard changes"]'
    )
    expect(discardButton).not.toBeNull()
    act(() => {
      discardButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const confirmButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Discard'
    )
    expect(confirmButton).not.toBeNull()
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mocks.calls.discardRuntimeGitPath).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ activeRuntimeEnvironmentId: 'worktree-env' }),
        worktreeId: hostedWorktree.id
      }),
      'src/file.ts'
    )
  })

  it('does not inherit an SSH connection from a duplicate repo on another host', async () => {
    const sshRepo = {
      ...mocks.activeRepo,
      connectionId: 'ssh-target',
      executionHostId: 'ssh:ssh-target'
    }
    const localRepo = { ...mocks.activeRepo, connectionId: null, executionHostId: 'local' }
    const localWorktree = { ...mocks.activeWorktree, hostId: 'local' }
    resetState({
      repos: [sshRepo, localRepo],
      worktreesByRepo: { [mocks.activeRepo.id]: [localWorktree] },
      getKnownWorktreeById: vi.fn((worktreeId: string) =>
        worktreeId === localWorktree.id ? localWorktree : null
      ),
      gitStatusByWorktree: { [localWorktree.id]: [gitEntry({ path: 'src/file.ts' })] }
    })
    renderSourceControl({ worktreeId: localWorktree.id, embedded: true })

    const row = container.querySelector<HTMLDivElement>('[data-source-control-path="src/file.ts"]')
    const discardButton = row?.querySelector<HTMLButtonElement>(
      'button[aria-label="Discard changes"]'
    )
    expect(discardButton).not.toBeNull()
    act(() => {
      discardButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const confirmButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Discard'
    )
    expect(confirmButton).not.toBeNull()
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mocks.calls.discardRuntimeGitPath).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: undefined,
        worktreeId: localWorktree.id
      }),
      'src/file.ts'
    )
  })

  it('keeps nested-only submodule rows non-stageable from the parent repo', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({
            path: 'packages/nested',
            submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }
          })
        ]
      }
    })
    renderSourceControl()

    const row = container.querySelector<HTMLDivElement>(
      '[data-source-control-path="packages/nested"]'
    )
    expect(row?.textContent).toContain('Submodule changes - stage inside submodule')

    const stageButton = row?.querySelector<HTMLButtonElement>(
      'button[aria-label="Stage these changes inside the submodule"]'
    )
    expect(stageButton).not.toBeNull()
    expect(stageButton?.getAttribute('aria-disabled')).toBe('true')
  })

  it('passes preview=true when a plain branch row click opens a branch diff tab', () => {
    resetState({
      gitBranchChangesByWorktree: { [mocks.activeWorktree.id]: [branchEntry()] },
      gitBranchCompareSummaryByWorktree: { [mocks.activeWorktree.id]: branchSummary() }
    })
    renderSourceControl()

    clickBranchRow()

    expect(mocks.calls.openBranchDiff).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt',
      expect.objectContaining({ path: 'src/branch.ts' }),
      expect.objectContaining({ status: 'ready' }),
      'typescript',
      { targetGroupId: undefined, preview: true }
    )
  })

  it('opens embedded uncommitted View all in the parent folder workspace', () => {
    resetState({
      activeWorktreeId: 'folder:folder-1',
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [gitEntry({ path: 'src/file.ts' })],
        'folder:folder-1': [gitEntry({ path: 'wrong.ts' })]
      }
    })
    renderSourceControl({ worktreeId: mocks.activeWorktree.id, embedded: true })

    clickViewAllButton()

    expect(mocks.calls.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.calls.openAllDiffs).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt',
      undefined,
      'unstaged',
      [expect.objectContaining({ path: 'src/file.ts' })],
      { displayWorktreeId: 'folder:folder-1' }
    )
  })

  it('opens embedded branch View all in the parent folder workspace', () => {
    resetState({
      activeWorktreeId: 'folder:folder-1',
      gitBranchChangesByWorktree: { [mocks.activeWorktree.id]: [branchEntry()] },
      gitBranchCompareSummaryByWorktree: { [mocks.activeWorktree.id]: branchSummary() }
    })
    renderSourceControl({ worktreeId: mocks.activeWorktree.id, embedded: true })

    clickViewAllButton()

    expect(mocks.calls.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.calls.openBranchAllDiffs).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt',
      expect.objectContaining({ status: 'ready' }),
      undefined,
      { displayWorktreeId: 'folder:folder-1' }
    )
  })

  it('opens embedded rows in the parent folder workspace', () => {
    resetState({
      activeWorktreeId: 'folder:folder-1',
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [gitEntry({ path: 'src/file.ts' })],
        'folder:folder-1': [gitEntry({ path: 'wrong.ts' })]
      }
    })
    renderSourceControl({ worktreeId: mocks.activeWorktree.id, embedded: true })

    clickUncommitted('src/file.ts', { ctrlKey: true })

    expect(mocks.calls.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.calls.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.calls.openDiff).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt/src/file.ts',
      'src/file.ts',
      'typescript',
      false,
      { targetGroupId: undefined, preview: true, displayWorktreeId: 'folder:folder-1' }
    )
  })
})
