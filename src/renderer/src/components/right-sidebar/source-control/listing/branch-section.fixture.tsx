import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import { RIGHT_SIDEBAR_MIN_WIDTH } from '../../right-sidebar-width'
import { useSourceControlPanelViewState } from '../panel/use-panel-view-state'
import { SourceControlBranchSection } from './branch-section'

const PR_HEAD = 'a1b2c3d4'
const entries: GitBranchChangeEntry[] = [
  { path: 'src/sync/retry.ts', status: 'modified', added: 42, removed: 7 },
  { path: 'src/sync/retry.test.ts', status: 'added', added: 88, removed: 0 },
  { path: 'docs/sync.md', status: 'modified', added: 5, removed: 1 }
]
const mergedReview: HostedReviewInfo = {
  provider: 'github',
  number: 412,
  title: 'Add retry to sync',
  state: 'merged',
  url: 'https://github.com/acme/app/pull/412',
  status: 'success',
  updatedAt: '2026-11-10T00:00:00Z',
  mergeable: 'UNKNOWN',
  headSha: PR_HEAD
}

function BranchSectionFrame({
  worktreeId,
  review = mergedReview,
  statusHeadOid = PR_HEAD,
  uncommittedCount = 0,
  isMainWorktree = false
}: {
  worktreeId: string
  review?: HostedReviewInfo | null
  statusHeadOid?: string
  uncommittedCount?: number
  isMainWorktree?: boolean
}) {
  const owner = { id: worktreeId }
  const view = useSourceControlPanelViewState({
    activeWorktreeId: worktreeId,
    activeWorktreeOwner: owner,
    settings: null,
    updateSettings: async () => {}
  })
  return (
    <div className="bg-sidebar pb-2 text-foreground">
      <SourceControlBranchSection
        activeOpenRowKeys={new Set()}
        branchSummary={{
          baseRef: 'origin/main',
          baseOid: 'base',
          compareRef: 'HEAD',
          headOid: statusHeadOid,
          mergeBase: 'base',
          changedFiles: entries.length,
          status: 'ready'
        }}
        filteredBranchEntries={entries}
        totalBranchEntryCount={entries.length}
        collapsedSections={view.collapsedSections}
        toggleSection={view.toggleSection}
        setBranchSectionAutoCollapsed={view.setBranchSectionAutoCollapsed}
        worktreeOwner={owner}
        review={review}
        statusHeadOid={statusHeadOid}
        uncommittedCount={uncommittedCount}
        isMainWorktree={isMainWorktree}
        isBranchDiffEditorActive={false}
        sourceControlViewMode="list"
        visibleBranchTreeRows={[]}
        fileListScrollElement={null}
        collapsedTreeDirs={new Set()}
        toggleTreeDir={() => {}}
        currentWorktreeId={worktreeId}
        worktreePath={`/work/${worktreeId}`}
        revealInExplorer={() => {}}
        activeConnectionId={null}
        openCommittedDiff={() => {}}
        openBranchAllDiffs={() => {}}
        diffCommentCountByPath={new Map()}
      />
    </div>
  )
}

async function expandBranchSection(frame: HTMLElement): Promise<void> {
  frame.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
}

export const openReview = defineFixture({
  width: 300,
  render: () => (
    <BranchSectionFrame
      worktreeId="fixture-open-review"
      review={{ ...mergedReview, state: 'open' }}
    />
  )
})

export const autoCollapsed = defineFixture({
  width: 300,
  render: () => <BranchSectionFrame worktreeId="fixture-auto-collapsed" />
})

export const userReExpanded = defineFixture({
  width: 300,
  render: () => <BranchSectionFrame worktreeId="fixture-user-re-expanded" />,
  interact: expandBranchSection
})

export const uncommittedWithChip = defineFixture({
  width: 300,
  render: () => <BranchSectionFrame worktreeId="fixture-uncommitted" uncommittedCount={2} />
})

export const headUnverified = defineFixture({
  width: 300,
  render: () => <BranchSectionFrame worktreeId="fixture-head-unverified" statusHeadOid="e4f5a6b7" />
})

export const mainWorktree = defineFixture({
  width: 300,
  render: () => <BranchSectionFrame worktreeId="fixture-main" isMainWorktree />
})

export const minimumSidebarWidth = defineFixture({
  width: RIGHT_SIDEBAR_MIN_WIDTH,
  render: () => <BranchSectionFrame worktreeId="fixture-min-width" />,
  interact: expandBranchSection
})

const germanSettings = { ...getDefaultSettings('/home/test'), uiLanguage: 'de' as const }

export const longLocale = defineFixture({
  width: 308,
  store: { settings: germanSettings },
  render: () => <BranchSectionFrame worktreeId="fixture-long-locale" />,
  interact: expandBranchSection
})

export const longLocaleMinimumWidth = defineFixture({
  width: RIGHT_SIDEBAR_MIN_WIDTH,
  store: { settings: germanSettings },
  render: () => <BranchSectionFrame worktreeId="fixture-long-locale-min" />,
  interact: expandBranchSection
})
