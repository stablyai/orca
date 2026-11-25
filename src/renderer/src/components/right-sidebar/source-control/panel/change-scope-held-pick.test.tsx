// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  GitHistoryItem,
  GitHistoryResult
} from '../../../../../../shared/git/history/git-history-types'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitCommitCompareResult
} from '../../../../../../shared/git/diff/git-diff-compare-types'

const mocks = vi.hoisted(() => ({
  getRuntimeGitCommitCompare: vi.fn(),
  openCommitAllDiffs: vi.fn(),
  openCommitDiff: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) => {
    const template =
      values?.count === 1 && typeof values.defaultValue_one === 'string'
        ? values.defaultValue_one
        : fallback
    return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))
  }
}))
vi.mock('@/lib/source-control/graph/git-graph-tab', () => ({ openGitGraph: vi.fn() }))
vi.mock('@/runtime/source-control/git/runtime-git-diff-client', () => ({
  getRuntimeGitCommitCompare: mocks.getRuntimeGitCommitCompare
}))
vi.mock('@/runtime/source-control/git/runtime-git-working-tree-client', () => ({
  getRuntimeGitRemoteCommitUrl: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openCommitAllDiffs: mocks.openCommitAllDiffs,
      openCommitDiff: mocks.openCommitDiff
    })
  }
}))
vi.mock('./worktree-scope', () => ({
  useSourceControlScope: () => null,
  sourceControlConnectionId: () => undefined
}))
vi.mock('../sync/explain-commit-with-agent', () => ({ explainCommitWithDefaultAgent: vi.fn() }))
vi.mock('@/lib/browser/workspace/workspace-browser-tab-open', () => ({
  openWorkspaceBrowserTab: vi.fn()
}))

import { SourceControlChangeScopeBar } from './change-scope-bar'
import {
  ALL_CHANGES_SCOPE,
  type SourceControlChangeScope,
  type SourceControlCommitScopeFiles
} from './change-scope'
import { useChangeScopeSync } from './use-change-scope-sync'
import { useGitHistoryCommitActions } from '../sync/use-git-history-commit-actions'
import type { SourceControlPanelReadyProps } from './panel-props'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { GitHistoryPanelState } from '../sync/use-git-history'

// In a shallow checkout the boundary commit has no parents; deepening reveals p0.
const SHALLOW: GitHistoryItem = {
  id: 'a000000000000000000000000000000000000000',
  displayId: 'a000000',
  parentIds: [],
  subject: 'Boundary commit',
  message: 'Boundary commit',
  author: 'Dev',
  timestamp: 1_763_000_000_000
}
const DEEPENED: GitHistoryItem = { ...SHALLOW, parentIds: ['p0'] }

function page(item: GitHistoryItem): GitHistoryResult {
  return {
    items: [item],
    currentRef: { id: 'refs/heads/feature', name: 'feature', revision: 'h1' },
    branch: {
      baseRef: { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'b1' }
    },
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: false,
    limit: 50
  }
}

const BRANCH: GitBranchCompareSummary = {
  baseRef: 'origin/main',
  baseOid: 'b1',
  compareRef: 'feature',
  headOid: 'h1',
  mergeBase: 'm1',
  changedFiles: 1,
  commitsAhead: 1,
  status: 'ready'
}

const ROOT_ROWS: GitBranchChangeEntry[] = [
  { path: 'older-unchanged.ts', status: 'added' },
  { path: 'changed.ts', status: 'added' }
]
const DEEP_ROWS: GitBranchChangeEntry[] = [{ path: 'changed.ts', status: 'modified' }]

function compare(
  parentOid: string | null,
  entries: GitBranchChangeEntry[]
): GitCommitCompareResult {
  return {
    summary: {
      commitOid: SHALLOW.id,
      parentOid,
      compareRef: SHALLOW.displayId!,
      baseRef: parentOid ?? 'empty tree',
      changedFiles: entries.length,
      status: 'ready'
    },
    entries
  }
}

// Stable like the panel's own owner target and callbacks, so the loaders keep their identity.
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }
const noGroup = (): undefined => undefined
const noop = vi.fn()
const refreshGitHistory = vi.fn(async () => {})

let latest: {
  changeScope: SourceControlChangeScope
  commitScopeFiles: SourceControlCommitScopeFiles | null
  actions: ReturnType<typeof useGitHistoryCommitActions>
} | null = null

function Panel({ history }: { history: GitHistoryPanelState }): React.JSX.Element {
  const [changeScope, setChangeScope] = useState<SourceControlChangeScope>(ALL_CHANGES_SCOPE)
  const [menuOpen, setMenuOpen] = useState(false)
  const [commitScopeFiles, setCommitScopeFiles] = useState<SourceControlCommitScopeFiles | null>(
    null
  )
  const actions = useGitHistoryCommitActions({
    activeWorktreeId: 'wt-1',
    worktreePath: '/repo',
    activeRepoTarget: LOCAL_TARGET,
    resolveSplitTargetGroupId: noGroup
  })
  useChangeScopeSync({
    changeScope,
    setChangeScope,
    setCommitScopeFiles,
    gitHistoryState: history,
    statusHead: 'h1',
    loadCommitFiles: actions.loadCommitFiles
  })
  latest = { changeScope, commitScopeFiles, actions }
  const model = {
    branchEntries: [{ path: 'b.ts', status: 'modified' }],
    branchLineTotal: null,
    branchSummary: BRANCH,
    changeScope,
    changeScopeMenuOpen: menuOpen,
    commitScopeFiles,
    compareBaseRef: 'origin/main',
    entries: [],
    gitHistoryContextKey: 'history-context',
    gitHistoryState: history,
    resolveSplitTargetGroupId: noGroup,
    setBaseRefDialogOpen: noop,
    setChangeScope,
    setChangeScopeMenuOpen: setMenuOpen,
    openAllDiffs: noop,
    openHistoryCommitDiff: actions.openHistoryCommitDiff,
    refreshGitHistory
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bar reads only the fields above.
  const props = {
    currentWorktreeId: 'wt-1',
    worktreePath: '/repo',
    model
  } as unknown as SourceControlPanelReadyProps
  return <SourceControlChangeScopeBar {...props} graphSupported />
}

function renderPanel(history: GitHistoryPanelState): (next: GitHistoryPanelState) => void {
  const root = render(
    <TooltipProvider>
      <Panel history={history} />
    </TooltipProvider>
  )
  return (next) =>
    root.rerender(
      <TooltipProvider>
        <Panel history={next} />
      </TooltipProvider>
    )
}

async function pickBoundaryCommit(): Promise<void> {
  fireEvent.pointerDown(screen.getByTestId('source-control-change-scope-trigger'), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  fireEvent.click(await screen.findByRole('menuitemradio', { name: /Boundary commit/ }))
  await waitFor(() => expect(latest?.changeScope.kind).toBe('commit'))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.getRuntimeGitCommitCompare.mockReset()
  latest = null
})

describe('a commit picked from retained shallow history', () => {
  it('follows the deepened page and keeps the old root compare out of rows and Open', async () => {
    // Every owner read gets its own deferred reply, so none is left without one.
    const reads: PromiseWithResolvers<GitCommitCompareResult>[] = []
    mocks.getRuntimeGitCommitCompare.mockImplementation(() => {
      const read = Promise.withResolvers<GitCommitCompareResult>()
      reads.push(read)
      return read.promise
    })
    const settleRest = (): void => {
      for (const read of reads.slice(2)) {
        read.resolve(compare('extra', [{ path: 'extra.ts', status: 'modified' }]))
      }
    }
    try {
      const setHistory = renderPanel({ status: 'ready', result: page(SHALLOW) })
      // Pick A while shallow; its root comparison stays held. Then return to All changes.
      await pickBoundaryCommit()
      expect(reads).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: 'Show all changes' }))
      expect(latest?.changeScope).toEqual(ALL_CHANGES_SCOPE)

      // The checkout is deepened; the menu refreshes but still shows the retained shallow page.
      await act(async () => setHistory({ status: 'refreshing', result: page(SHALLOW) }))
      await pickBoundaryCommit()
      expect(latest?.changeScope).toMatchObject({ commit: { parentIds: [] } })
      expect(reads).toHaveLength(1)

      // The refreshed page shows A's parent: the pick follows it and reads again.
      await act(async () => setHistory({ status: 'ready', result: page(DEEPENED) }))
      expect(reads).toHaveLength(2)
      expect(latest?.changeScope).toMatchObject({ commit: { parentIds: ['p0'] } })

      await act(async () => reads[1].resolve(compare('p0', DEEP_ROWS)))
      // The deepened rows publish while the old root comparison is still held.
      expect(latest?.commitScopeFiles).toEqual({
        commitId: SHALLOW.id,
        status: 'ready',
        entries: DEEP_ROWS
      })
      // The old root comparison settles last, and does not replace them.
      await act(async () => {
        reads[0].resolve(compare(null, ROOT_ROWS))
        settleRest()
      })

      expect(latest?.commitScopeFiles).toEqual({
        commitId: SHALLOW.id,
        status: 'ready',
        entries: DEEP_ROWS
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('source-control-change-scope-open-diff'))
      })
      await waitFor(() => expect(mocks.openCommitAllDiffs).toHaveBeenCalledTimes(1))
      expect(mocks.openCommitAllDiffs.mock.lastCall?.[2]).toMatchObject({ parentOid: 'p0' })
      expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual(DEEP_ROWS)
      // A row opens with the selected commit, as the commit file list does.
      const selected = latest!.changeScope
      if (selected.kind !== 'commit') {
        throw new Error('expected a picked commit')
      }
      latest!.actions.openCommitFile(selected.commit, DEEP_ROWS[0])
      expect(mocks.openCommitDiff.mock.lastCall?.[2]).toEqual(DEEP_ROWS[0])
      expect(mocks.openCommitDiff.mock.lastCall?.[3]).toMatchObject({ parentOid: 'p0' })
      expect(reads).toHaveLength(2)
    } finally {
      // Settle every dispatch even when an assertion fails, so no waiter is stranded.
      for (const read of reads) {
        read.resolve(compare('cleanup', []))
      }
    }
  })
})
