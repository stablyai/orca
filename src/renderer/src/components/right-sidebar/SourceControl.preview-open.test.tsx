// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
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
    createBrowserTab: vi.fn(),
    openDiff: vi.fn(),
    openFile: vi.fn(),
    openConflictFile: vi.fn(),
    openBranchDiff: vi.fn(),
    createEmptySplitGroup: vi.fn(),
    discardRuntimeGitPath: vi.fn(),
    bulkStageRuntimeGitPaths: vi.fn(),
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

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(true)
}))

vi.mock('@/runtime/runtime-git-working-tree-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    discardRuntimeGitPath: mocks.calls.discardRuntimeGitPath,
    bulkStageRuntimeGitPaths: mocks.calls.bulkStageRuntimeGitPaths
  }
})

vi.mock('@/components/editor/editor-autosave', () => ({
  requestEditorSaveQuiesce: mocks.calls.requestEditorSaveQuiesce,
  notifyEditorExternalFileChange: mocks.calls.notifyEditorExternalFileChange
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
  mocks.calls.bulkStageRuntimeGitPaths.mockResolvedValue(undefined)
  mocks.calls.refreshGitStatusForWorktree.mockResolvedValue(undefined)
  mocks.calls.requestEditorSaveQuiesce.mockResolvedValue(undefined)
  mocks.state = {
    activeWorktreeId: mocks.activeWorktree.id,
    activeGroupIdByWorktree: { [mocks.activeWorktree.id]: 'group-1' },
    groupsByWorktree: { [mocks.activeWorktree.id]: [{ id: 'group-1', activeTabId: null }] },
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    createBrowserTab: mocks.calls.createBrowserTab,
    getKnownWorktreeById: () => mocks.activeWorktree,
    repos: [mocks.activeRepo],
    worktreesByRepo: { [mocks.activeRepo.id]: [mocks.activeWorktree] },
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
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
    openDiff: mocks.calls.openDiff,
    openFile: mocks.calls.openFile,
    setEditorViewMode: vi.fn(),
    setMarkdownViewMode: vi.fn(),
    setPendingEditorReveal: vi.fn(),
    openConflictFile: mocks.calls.openConflictFile,
    openConflictReview: vi.fn(),
    openBranchDiff: mocks.calls.openBranchDiff,
    createEmptySplitGroup: mocks.calls.createEmptySplitGroup,
    openAllDiffs: vi.fn(),
    openBranchAllDiffs: vi.fn(),
    openCommitAllDiffs: vi.fn(),
    deleteDiffComment: noopAsync(true),
    clearDiffComments: noopAsync(true),
    clearDiffCommentsForFile: noopAsync(true),
    setScrollToDiffCommentId: vi.fn(),
    closeAgentSendPopoverTargetMode: vi.fn(),
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

function renderSourceControl(): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <SourceControl />
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

function clickBranchRow(path = 'src/branch.ts', init: MouseEventInit = {}): void {
  const row = container.querySelector<HTMLDivElement>(
    `[data-source-control-area="branch"][data-source-control-path="${path}"]`
  )
  expect(row).not.toBeNull()
  act(() => {
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
}

describe('SourceControl preview row opens', () => {
  it.each(['untracked', 'unstaged', 'staged'] as const)(
    'keeps the current-file indicator on an HTML browser preview in %s',
    (area) => {
      resetState({
        gitStatusByWorktree: {
          [mocks.activeWorktree.id]: [
            gitEntry({
              path: 'report one.html',
              area,
              status: area === 'untracked' ? area : 'modified'
            })
          ]
        },
        activeTabTypeByWorktree: { [mocks.activeWorktree.id]: 'browser' },
        activeBrowserTabIdByWorktree: { [mocks.activeWorktree.id]: 'browser-1' },
        browserTabsByWorktree: {
          [mocks.activeWorktree.id]: [{ id: 'browser-1', activePageId: 'page-html' }]
        },
        browserPagesByWorkspace: {
          'browser-1': [
            { id: 'page-web', url: 'https://example.com' },
            { id: 'page-html', url: 'file:///repo/wt/report%20one.html#section' }
          ]
        }
      })
      renderSourceControl()

      expect(
        container
          .querySelector('[data-source-control-path="report one.html"]')
          ?.getAttribute('data-current')
      ).toBe('true')
    }
  )

  it.each([mocks.activeWorktree.id, 'other-workspace'])(
    'matches a workspace document only to its owning workspace: %s',
    (documentWorktreeId) => {
      resetState({
        repos: [{ ...mocks.activeRepo, connectionId: 'ssh-1' }],
        gitStatusByWorktree: { [mocks.activeWorktree.id]: [gitEntry({ path: 'test.html' })] },
        activeTabTypeByWorktree: { [mocks.activeWorktree.id]: 'browser' },
        activeBrowserTabIdByWorktree: { [mocks.activeWorktree.id]: 'browser-1' },
        browserTabsByWorktree: {
          [mocks.activeWorktree.id]: [{ id: 'browser-1', activePageId: 'page-html' }]
        },
        browserPagesByWorkspace: {
          'browser-1': [
            {
              id: 'page-html',
              url: 'data:text/html,',
              docLocation: {
                kind: 'workspace-doc',
                worktreeId: documentWorktreeId,
                filePath: '/repo/wt/test.html'
              }
            }
          ]
        }
      })
      renderSourceControl()

      expect(
        container
          .querySelector('[data-source-control-path="test.html"]')
          ?.getAttribute('data-current')
      ).toBe(documentWorktreeId === mocks.activeWorktree.id ? 'true' : null)
    }
  )

  it.each(['untracked', 'unstaged', 'staged'] as const)(
    'renders HTML when opening a row in %s',
    (area) => {
      resetState({
        gitStatusByWorktree: {
          [mocks.activeWorktree.id]: [
            gitEntry({ path: 'test.html', area, status: area === 'untracked' ? area : 'modified' })
          ]
        }
      })
      renderSourceControl()

      clickUncommitted('test.html')

      expect(mocks.calls.createBrowserTab).toHaveBeenCalledWith(
        mocks.activeWorktree.id,
        'file:///repo/wt/test.html',
        { title: 'test.html', targetGroupId: undefined, activate: true }
      )
      expect(mocks.calls.openDiff).not.toHaveBeenCalled()
      expect(mocks.calls.openFile).not.toHaveBeenCalled()
    }
  )

  it('targets the requested split when previewing HTML', () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: [gitEntry({ path: 'test.html' })] }
    })
    renderSourceControl()

    clickUncommitted('test.html', { ctrlKey: true })

    expect(mocks.calls.createBrowserTab).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      'file:///repo/wt/test.html',
      { title: 'test.html', targetGroupId: 'group-2', activate: true }
    )
    expect(mocks.calls.openDiff).not.toHaveBeenCalled()
  })

  it('previews HTML through its SSH owner', () => {
    resetState({
      repos: [{ ...mocks.activeRepo, connectionId: 'ssh-1' }],
      gitStatusByWorktree: { [mocks.activeWorktree.id]: [gitEntry({ path: 'test.html' })] }
    })
    renderSourceControl()

    clickUncommitted('test.html')

    expect(mocks.calls.createBrowserTab).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      'data:text/html,',
      expect.objectContaining({
        docLocation: {
          kind: 'workspace-doc',
          worktreeId: mocks.activeWorktree.id,
          filePath: '/repo/wt/test.html'
        },
        browserRuntimeEnvironmentId: null,
        activate: true
      })
    )
    expect(mocks.calls.openDiff).not.toHaveBeenCalled()
  })

  it('keeps deleted HTML and HTML conflicts in their diff surfaces', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({ path: 'deleted.html', status: 'deleted' }),
          gitEntry({
            path: 'conflict.html',
            conflictKind: 'both_modified',
            conflictStatus: 'unresolved'
          })
        ]
      }
    })
    renderSourceControl()

    clickUncommitted('deleted.html')
    clickUncommitted('conflict.html')

    expect(mocks.calls.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.calls.openDiff).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt/deleted.html',
      'deleted.html',
      'html',
      false,
      { targetGroupId: undefined, preview: true }
    )
    expect(mocks.calls.openConflictFile).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt',
      expect.objectContaining({ path: 'conflict.html' }),
      'html',
      { targetGroupId: undefined, preview: true }
    )
  })

  it('falls back to the diff when this client cannot preview HTML', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: [gitEntry({ path: 'test.html' })] }
    })
    renderSourceControl()

    clickUncommitted('test.html')

    expect(mocks.calls.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.calls.openDiff).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt/test.html',
      'test.html',
      'html',
      false,
      { targetGroupId: undefined, preview: true }
    )
  })

  it.each(['uncommitted', 'branch'] as const)('opens a %s HTML review note in the diff', (area) => {
    resetState({
      worktreesByRepo: {
        [mocks.activeRepo.id]: [
          {
            ...mocks.activeWorktree,
            diffComments: [
              {
                id: 'html-note',
                worktreeId: mocks.activeWorktree.id,
                filePath: 'test.html',
                lineNumber: 1,
                side: 'modified',
                body: 'Review this heading',
                createdAt: 1
              }
            ]
          }
        ]
      },
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: area === 'uncommitted' ? [gitEntry({ path: 'test.html' })] : []
      },
      gitBranchChangesByWorktree: {
        [mocks.activeWorktree.id]: area === 'branch' ? [branchEntry({ path: 'test.html' })] : []
      },
      gitBranchCompareSummaryByWorktree: { [mocks.activeWorktree.id]: branchSummary() }
    })
    renderSourceControl()

    const expandNotes = container.querySelector<HTMLButtonElement>('button[title="Expand notes"]')
    expect(expandNotes).not.toBeNull()
    act(() => expandNotes?.click())
    const note = container.querySelector<HTMLButtonElement>('button[aria-label^="Open note on"]')
    expect(note?.textContent).toContain('Review this heading')
    act(() => note?.click())

    expect(mocks.calls.createBrowserTab).not.toHaveBeenCalled()
    if (area === 'uncommitted') {
      expect(mocks.calls.openDiff).toHaveBeenCalledWith(
        mocks.activeWorktree.id,
        '/repo/wt/test.html',
        'test.html',
        'html',
        false,
        { preview: true }
      )
    } else {
      expect(mocks.calls.openBranchDiff).toHaveBeenCalledWith(
        mocks.activeWorktree.id,
        '/repo/wt',
        expect.objectContaining({ path: 'test.html' }),
        branchSummary(),
        'html',
        { preview: true }
      )
    }
    expect(mocks.state.setScrollToDiffCommentId).toHaveBeenLastCalledWith('html-note')
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

  it('passes preview through new markdown rich editor and conflict file opens', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({ path: 'docs/readme.md', status: 'untracked', area: 'untracked' }),
          gitEntry({ path: 'docs/existing.md' }),
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
    clickUncommitted('docs/existing.md')
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
    expect(mocks.calls.openDiff).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      '/repo/wt/docs/existing.md',
      'docs/existing.md',
      'markdown',
      false,
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

  it('scopes discard autosave quiesce and reload notifications to the repo owner runtime', async () => {
    resetState({
      gitStatusByWorktree: { [mocks.activeWorktree.id]: [gitEntry({ path: 'src/file.ts' })] }
    })
    // Why: the owner stamp routes the discard; a different focused server must not.
    Object.assign(mocks.activeRepo, { executionHostId: 'runtime:runtime-remote' })
    onTestFinished(() => {
      Reflect.deleteProperty(mocks.activeRepo, 'executionHostId')
    })
    renderSourceControl()
    mocks.state.settings = { activeRuntimeEnvironmentId: 'runtime-other' }

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
    expect(row?.textContent).toContain('Stage inside submodule')
    expect(
      row?.querySelector('[title*="cannot stage file changes inside a submodule"]')
    ).not.toBeNull()

    expect(row?.querySelector<HTMLButtonElement>('button[aria-label="Stage"]')).toBeNull()
  })

  it('does not render a commit-area Stage All primary for submodule worktree-only rows', () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({
            path: 'june-11th-launch',
            submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }
          })
        ]
      }
    })
    renderSourceControl()

    const row = container.querySelector<HTMLDivElement>(
      '[data-source-control-path="june-11th-launch"]'
    )
    expect(row?.textContent).toContain('Stage inside submodule')

    const stageAllButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Stage All'
    )
    expect(stageAllButton).toBeUndefined()

    const commitButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Commit'
    )
    expect(commitButton).toBeDefined()
    expect(commitButton?.disabled).toBe(true)

    act(() => {
      commitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.calls.bulkStageRuntimeGitPaths).not.toHaveBeenCalled()
  })

  it('keeps the commit-area Stage All primary for changed submodule gitlinks', async () => {
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [
          gitEntry({
            path: 'packages/nested',
            submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
          })
        ]
      }
    })
    renderSourceControl()

    const stageAllButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Stage All'
    )
    expect(stageAllButton).toBeDefined()
    expect(stageAllButton?.disabled).toBe(false)

    await act(async () => {
      stageAllButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(mocks.calls.bulkStageRuntimeGitPaths).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: mocks.activeWorktree.id, worktreePath: '/repo/wt' }),
      ['packages/nested']
    )
  })

  it.each([false, true])('previews committed HTML from a branch row (split: %s)', (split) => {
    resetState({
      gitBranchChangesByWorktree: {
        [mocks.activeWorktree.id]: [branchEntry({ path: 'test.html' })]
      },
      gitBranchCompareSummaryByWorktree: { [mocks.activeWorktree.id]: branchSummary() }
    })
    renderSourceControl()

    clickBranchRow('test.html', { ctrlKey: split })

    expect(mocks.calls.createBrowserTab).toHaveBeenCalledWith(
      mocks.activeWorktree.id,
      'file:///repo/wt/test.html',
      { title: 'test.html', targetGroupId: split ? 'group-2' : undefined, activate: true }
    )
    expect(mocks.calls.openBranchDiff).not.toHaveBeenCalled()
  })

  it.each(['branch-deleted', 'worktree-deleted', 'worktree-conflict'] as const)(
    'keeps a %s HTML branch row in the diff',
    (kind) => {
      resetState({
        gitBranchChangesByWorktree: {
          [mocks.activeWorktree.id]: [
            branchEntry({
              path: 'test.html',
              status: kind === 'branch-deleted' ? 'deleted' : 'added'
            })
          ]
        },
        gitBranchCompareSummaryByWorktree: { [mocks.activeWorktree.id]: branchSummary() },
        gitStatusByWorktree: {
          [mocks.activeWorktree.id]:
            kind === 'branch-deleted'
              ? []
              : [
                  gitEntry({
                    path: 'test.html',
                    ...(kind === 'worktree-deleted'
                      ? { status: 'deleted' }
                      : { conflictKind: 'both_modified', conflictStatus: 'unresolved' })
                  })
                ]
        }
      })
      renderSourceControl()

      clickBranchRow('test.html')

      expect(mocks.calls.createBrowserTab).not.toHaveBeenCalled()
      expect(mocks.calls.openBranchDiff).toHaveBeenCalledWith(
        mocks.activeWorktree.id,
        '/repo/wt',
        expect.objectContaining({ path: 'test.html' }),
        branchSummary(),
        'html',
        { targetGroupId: undefined, preview: true }
      )
    }
  )

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
})
