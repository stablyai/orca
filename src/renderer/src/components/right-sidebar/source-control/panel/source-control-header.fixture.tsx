import { useState } from 'react'
import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type {
  GitBranchLineTotal,
  GitStatusEntry
} from '../../../../../../shared/git/status/git-status-types'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { getWorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/row-display/git-identity-display'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { BranchPicker } from '../branches/BranchPicker'
import { CommitArea } from '../commit/commit-area'
import { UncommittedEntryRow } from '../listing/uncommitted-entry-row'
import { resolveCommitAreaPrimaryAction } from '../review/source-control-primary-action'
import type {
  PrimaryAction,
  PrimaryActionInputs
} from '../review/source-control-primary-action-types'
import { SourceControlChangeScopeBar } from './change-scope-bar'
import { ALL_CHANGES_SCOPE, type SourceControlChangeScope } from './change-scope'
import { SourceControlHeaderOverflowMenu } from './header-overflow-menu'
import { SourceControlHeaderToolbar } from './header-toolbar'
import { OperationRow } from './operation-row'
import type { SourceControlPanelReadyProps } from './panel-props'
import { resolveDropdownItems } from './source-control-dropdown-items'

type Scenario = {
  branch?: string
  detached?: boolean
  behind?: number
  ahead?: number
  lines?: { added: number; removed: number } | null
  compare?: 'ready' | 'loading' | 'error'
  review?: 'create' | 'creating' | 'disabled' | 'open' | 'unlinked' | null
  filterExpanded?: boolean
  filterQuery?: string
  scope?: SourceControlChangeScope
  graphSupported?: boolean
  /** A paused rebase on this branch, which replaces the HEAD row. */
  rebasing?: string
}

const FILES: GitStatusEntry[] = [
  { path: 'src/settings/settings-pane.tsx', status: 'modified', area: 'unstaged' },
  { path: 'src/settings/use-settings.ts', status: 'modified', area: 'unstaged' },
  { path: 'src/panel/header-toolbar.tsx', status: 'added', area: 'unstaged' }
]

const COMMIT = {
  id: '4be1f02000000000000000000000000000000000',
  displayId: '4be1f02',
  parentIds: [],
  subject: 'Move settings sections into tabs',
  message: 'Move settings sections into tabs',
  author: 'Sam Rivera',
  timestamp: 1_763_000_000_000
}

const OPEN_REVIEW: HostedReviewInfo = {
  provider: 'github',
  number: 812,
  title: 'Settings panel',
  state: 'open',
  url: 'https://example.com/pr/812',
  status: 'pending',
  updatedAt: '2026-11-20T00:00:00Z',
  mergeable: 'MERGEABLE'
}

function createPrAction(disabled: boolean): PrimaryAction {
  return {
    kind: 'create_pr',
    label: 'Create PR',
    title: disabled ? 'Push this branch before creating a PR' : 'Create a pull request',
    disabled
  }
}

function summaryFor(scenario: Scenario): GitBranchCompareSummary {
  const base = {
    baseRef: 'origin/main',
    baseOid: 'b1',
    compareRef: scenario.branch ?? 'feature/settings-panel',
    headOid: 'h1',
    mergeBase: 'm1',
    changedFiles: 34,
    commitsAhead: scenario.ahead ?? 0,
    commitsBehind: scenario.behind ?? 0
  }
  if (scenario.compare === 'loading') {
    return { ...base, status: 'loading' }
  }
  if (scenario.compare === 'error') {
    return { ...base, status: 'error', errorMessage: 'Could not read origin/main' }
  }
  return { ...base, status: 'ready' }
}

function Composer() {
  const inputs = {
    stagedCount: 0,
    hasUnstagedChanges: true,
    hasStageableChanges: true,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
  } satisfies PrimaryActionInputs
  return (
    <CommitArea
      worktreeId="fixture-workspace"
      groupId={null}
      commitMessage=""
      commitError={null}
      commitFailureRecoveryPrompt={null}
      pushRecovery={null}
      remoteActionError={null}
      isCommitting={false}
      isFixingCommitFailureWithAI={false}
      isFixingPushFailureWithAI={false}
      sourceControlAiActionsVisible
      aiAgentConfigured
      isGenerating={false}
      generateError={null}
      stagedCount={0}
      hasPartiallyStagedChanges={false}
      hasUnresolvedConflicts={false}
      isRemoteOperationActive={false}
      inFlightRemoteOpKind={null}
      primaryAction={resolveCommitAreaPrimaryAction(inputs)}
      dropdownItems={resolveDropdownItems(inputs)}
      onCommitMessageChange={() => {}}
      onGenerate={() => {}}
      onCancelGenerate={() => {}}
      onFixCommitFailureWithAI={() => false}
      onFixPushFailureWithAI={() => false}
      onPrimaryAction={() => {}}
      onDropdownAction={() => {}}
    />
  )
}

function Panel(scenario: Scenario) {
  const [filterQuery, setFilterQuery] = useState(scenario.filterQuery ?? '')
  const [filterExpanded, setFilterExpanded] = useState(scenario.filterExpanded ?? false)
  const [changeScope, setChangeScope] = useState(scenario.scope ?? ALL_CHANGES_SCOPE)
  const [menuOpen, setMenuOpen] = useState(false)
  const branch = scenario.branch ?? 'feature/settings-panel'
  const headDisplay = scenario.detached
    ? getWorktreeGitIdentityDisplay({ head: '3f9c2a1d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a' })
    : getWorktreeGitIdentityDisplay({ branch })
  const summary = summaryFor(scenario)
  const lines = scenario.lines === undefined ? { added: 1530, removed: 145 } : scenario.lines
  const branchLineTotal: GitBranchLineTotal | null = lines ? { ...lines, mergeBase: 'm1' } : null
  const graphSupport = { support: scenario.graphSupported ?? true, recheck: () => {} }
  const panelActions = {
    sourceControlViewMode: 'list' as const,
    viewModeToggleDisabled: false,
    onToggleViewMode: () => {},
    onChangeBaseRef: () => {},
    onRefreshBranchCompare: () => {},
    branchCompareRefreshDisabled: false,
    diffCommentCount: 2,
    onExpandNotes: () => {},
    onOpenGitGraph: () => {},
    gitGraphDisabled: graphSupport.support !== true
  }
  const filter = {
    filterQuery,
    filterExpanded,
    onFilterQueryChange: setFilterQuery,
    onFilterExpandedChange: setFilterExpanded
  }
  const review = scenario.review === undefined ? 'create' : scenario.review
  const model = {
    branchEntries: FILES.map((entry) => ({ ...entry, added: 40, removed: 4 })),
    branchLineTotal,
    branchSummary: summary,
    changeScope,
    changeScopeMenuOpen: menuOpen,
    commitScopeFiles:
      changeScope.kind === 'commit'
        ? { commitId: changeScope.commit.id, status: 'ready', entries: FILES }
        : null,
    compareBaseRef: 'origin/main',
    entries: FILES.map((entry) => ({ ...entry, added: 12, removed: 3 })),
    gitHistoryContextKey: 'fixture-history',
    gitHistoryState: { status: 'ready', result: null },
    openAllDiffs: () => {},
    openHistoryCommitDiff: async () => {},
    refreshGitHistory: async () => {},
    resolveSplitTargetGroupId: () => undefined,
    setBaseRefDialogOpen: () => {},
    setChangeScope,
    setChangeScopeMenuOpen: setMenuOpen
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bar reads only the fields above.
  const props = {
    currentWorktreeId: 'fixture-workspace',
    worktreePath: '/workspace/settings-panel',
    model
  } as unknown as SourceControlPanelReadyProps
  return (
    <div className="flex flex-col bg-sidebar text-foreground">
      <SourceControlHeaderToolbar
        {...filter}
        headControl={
          headDisplay?.kind === 'branch' ? (
            <BranchPicker
              branch={branch}
              blocker={null}
              context={{ target: { kind: 'local' }, worktreeId: 'w', worktreePath: '/w' }}
              repoId="repo"
              hostId="local"
              hostLabel="This Mac"
              workspaceLabel="settings-panel"
              workspaces={new Map()}
              onOpenWorkspace={() => {}}
              onSwitched={() => {}}
            />
          ) : undefined
        }
        headDisplay={headDisplay}
        visibleCreatePrHeaderAction={
          review === 'create' || review === 'creating'
            ? createPrAction(false)
            : review === 'disabled'
              ? createPrAction(true)
              : null
        }
        hostedReview={review === 'open' ? OPEN_REVIEW : null}
        isCreatePrIntentInFlight={false}
        isCreatingPr={review === 'creating'}
        onCreatePrHeaderClick={() => {}}
        onOpenHostedReviewInChecks={() => {}}
        suppressedGitHubPRNumber={review === 'unlinked' ? 812 : null}
        onRelinkSuppressedGitHubPR={() => {}}
        panelActions={panelActions}
        onRefreshBranchCompare={() => {}}
        branchSummary={summary}
        compareBaseRef="origin/main"
        branchLineTotal={branchLineTotal}
        operationRow={
          scenario.rebasing ? (
            <OperationRow
              operation="rebase"
              branch={scenario.rebasing}
              primary={{ kind: 'resolve', busy: false, onPress: () => {} }}
              abort={{ unavailable: false, busy: false, onAbort: () => {} }}
              abortTargetKey="fixture|rebase"
            />
          ) : null
        }
        toolsInFileListHeader
      />
      <div className="pt-1">
        <Composer />
        <div className="border-t border-border">
          <SourceControlChangeScopeBar
            {...props}
            graphSupported={graphSupport.support === true}
            filter={filter}
            overflowMenu={
              <SourceControlHeaderOverflowMenu
                panelActions={panelActions}
                triggerClassName="size-5"
              />
            }
          />
        </div>
        {FILES.map((entry) => (
          <UncommittedEntryRow
            key={entry.path}
            entryKey={entry.path}
            entry={entry}
            currentWorktreeId="fixture-workspace"
            worktreePath="/workspace/settings-panel"
            onRevealInExplorer={() => {}}
            onOpen={() => {}}
            onStage={async () => {}}
            onResolveConflict={async () => {}}
            onUnstage={async () => {}}
            onDiscard={() => {}}
            commentCount={0}
          />
        ))}
      </div>
    </div>
  )
}

// The fixture frame pads 16px per side; widths below are the panel's own.
const FRAME_PADDING = 32
function panelWidth(width: number): number {
  return width + FRAME_PADDING
}

const LONG_BRANCH = 'someone/very-long-branch-name-for-the-onboarding-flow-v2'

function variants(scenario: Scenario) {
  return {
    narrow: defineFixture({ width: panelWidth(240), render: () => <Panel {...scenario} /> }),
    standard: defineFixture({ width: panelWidth(264), render: () => <Panel {...scenario} /> }),
    minimum: defineFixture({ width: panelWidth(220), render: () => <Panel {...scenario} /> }),
    wide: defineFixture({ width: panelWidth(400), render: () => <Panel {...scenario} /> })
  }
}

const behind = variants({ behind: 45 })
export const behindMinimum = behind.minimum
export const behindNarrow = behind.narrow
export const behindStandard = behind.standard
export const behindWide = behind.wide

const upToDate = variants({})
export const upToDateMinimum = upToDate.minimum
export const upToDateNarrow = upToDate.narrow
export const upToDateStandard = upToDate.standard
export const upToDateWide = upToDate.wide

const prOpen = variants({ review: 'open', ahead: 3 })
export const prOpenMinimum = prOpen.minimum
export const prOpenNarrow = prOpen.narrow
export const prOpenStandard = prOpen.standard
export const prOpenWide = prOpen.wide

const longBranch = variants({ branch: LONG_BRANCH, behind: 128, ahead: 3, review: 'open' })
export const longBranchMinimum = longBranch.minimum
export const longBranchNarrow = longBranch.narrow
export const longBranchStandard = longBranch.standard
export const longBranchWide = longBranch.wide

const longBranchCreate = variants({ branch: LONG_BRANCH, behind: 128 })
export const longBranchCreatePrMinimum = longBranchCreate.minimum
export const longBranchCreatePrNarrow = longBranchCreate.narrow
export const longBranchCreatePrWide = longBranchCreate.wide

const detached = variants({ detached: true, review: null, behind: 2 })
export const detachedMinimum = detached.minimum
export const detachedNarrow = detached.narrow
export const detachedStandard = detached.standard
export const detachedWide = detached.wide

const remoteOldHost = variants({ behind: 4, graphSupported: false })
export const remoteOldHostNarrow = remoteOldHost.narrow
export const remoteOldHostWide = remoteOldHost.wide

const rebasingLong = variants({ rebasing: 'feature/very-long-example-branch-name-for-testing' })
export const rebasingLongMinimum = rebasingLong.minimum
export const rebasingLongWide = rebasingLong.wide
const rebasingShort = variants({ rebasing: 'feature/ledger' })
export const rebasingShortMinimum = rebasingShort.minimum
export const rebasingShortWide = rebasingShort.wide

export const compareLoading = defineFixture({
  width: panelWidth(264),
  render: () => <Panel compare="loading" />
})
export const compareFailed = defineFixture({
  width: panelWidth(264),
  render: () => <Panel compare="error" />
})
export const nothingToShow = defineFixture({
  width: panelWidth(264),
  render: () => <Panel lines={null} />
})
export const creatingPr = defineFixture({
  width: panelWidth(240),
  render: () => <Panel review="creating" behind={45} />
})
export const createPrDisabled = defineFixture({
  width: panelWidth(264),
  render: () => <Panel review="disabled" />
})
export const unlinkedPr = defineFixture({
  width: panelWidth(264),
  render: () => <Panel review="unlinked" />
})
const filterOpen = variants({ filterExpanded: true, filterQuery: 'settings', behind: 45 })
export const filterOpenMinimum = filterOpen.minimum
export const filterOpenNarrow = filterOpen.narrow
export const filterOpenStandard = filterOpen.standard
export const filterOpenWide = filterOpen.wide

export const filterActive = defineFixture({
  width: panelWidth(240),
  render: () => <Panel filterQuery="settings" behind={45} />
})

const uncommitted = variants({ scope: { kind: 'uncommitted' }, behind: 45 })
export const uncommittedMinimum = uncommitted.minimum
export const uncommittedNarrow = uncommitted.narrow
export const uncommittedStandard = uncommitted.standard
export const uncommittedWide = uncommitted.wide

export const commitScope = defineFixture({
  width: panelWidth(240),
  render: () => (
    <Panel
      scope={{ kind: 'commit', commit: COMMIT, pickedBaseOid: 'b1', pickedFromBranchPage: true }}
    />
  )
})
function openOverflowMenu(frame: HTMLElement): void {
  frame
    .querySelector('button[aria-label="More source control actions"]')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}
export const overflowOpen = defineFixture({
  width: panelWidth(264),
  render: () => <Panel behind={45} />,
  interact: openOverflowMenu
})
export const overflowOpenGraphUnsupported = defineFixture({
  width: panelWidth(264),
  render: () => <Panel behind={45} graphSupported={false} />,
  interact: openOverflowMenu
})
