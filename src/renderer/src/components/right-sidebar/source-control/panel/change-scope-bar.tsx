import React, { useRef } from 'react'
import { ChevronDown, FileDiff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { openGitGraph } from '@/lib/source-control/graph/git-graph-tab'
import { formatSourceControlRefLabel } from './branch-context-stats'
import { SourceControlChangeScopeMenuContent, commitMetaLine } from './change-scope-menu'
import {
  ALL_CHANGES_SCOPE,
  summarizeChangeScopeEntries,
  type ChangeScopeSummary,
  type SourceControlChangeScope
} from './change-scope'
import type { SourceControlPanelReadyProps } from './panel-props'
import {
  SourceControlFilterRow,
  SourceControlFilterToggle,
  type SourceControlFileFilterProps
} from './file-filter-controls'

function fileCountLabel(t: Translate, count: number): string {
  return t('auto.components.right.sidebar.SourceControl.scopeFileCount', '{{count}} files', {
    count,
    defaultValue_one: '{{count}} file'
  })
}

function commitCountLabel(t: Translate, count: number): string {
  return t('auto.components.right.sidebar.SourceControl.scopeCommitCount', '{{count}} commits', {
    count,
    defaultValue_one: '{{count}} commit'
  })
}

function allScopeDetail(t: Translate, files: number, commitsAhead: number): string {
  return commitsAhead > 0
    ? `${fileCountLabel(t, files)} · ${commitCountLabel(t, commitsAhead)}`
    : fileCountLabel(t, files)
}

function uncommittedScopeDetail(t: Translate, files: number): string {
  return files > 0
    ? fileCountLabel(t, files)
    : t('auto.components.right.sidebar.SourceControl.scopeNone', 'None')
}

function scopeCountTitle(
  t: Translate,
  files: number,
  lines: { added: number; removed: number } | null,
  locale: string
): string {
  const fileLabel = fileCountLabel(t, files)
  return lines && files > 0
    ? `${fileLabel} · +${lines.added.toLocaleString(locale)} −${lines.removed.toLocaleString(locale)}`
    : fileLabel
}

function scopeTriggerLabel(t: Translate, scope: SourceControlChangeScope): string {
  if (scope.kind === 'commit') {
    return scope.commit.subject
  }
  return scope.kind === 'uncommitted'
    ? t('auto.components.right.sidebar.SourceControl.scopeUncommitted', 'Uncommitted')
    : t('auto.components.right.sidebar.SourceControl.scopeAllChanges', 'All changes')
}

export function SourceControlChangeScopeBar({
  currentWorktreeId,
  worktreePath,
  model,
  graphSupported,
  filter,
  graphControl,
  overflowMenu
}: SourceControlPanelReadyProps & {
  graphSupported: boolean
  /** Null where a folder card's header owns the filter toggle and its row. */
  filter?: SourceControlFileFilterProps | null
  graphControl?: React.ReactNode
  overflowMenu?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
  // The toggle remounts when the filter row closes; focus returns to it on Escape or clear.
  const restoreFilterToggleFocus = useRef(false)
  const {
    branchEntries,
    branchLineTotal,
    branchSummary,
    changeScope,
    changeScopeMenuOpen,
    commitScopeFiles,
    compareBaseRef,
    entries,
    gitHistoryContextKey,
    gitHistoryState,
    openAllDiffs,
    openHistoryCommitDiff,
    refreshGitHistory,
    resolveSplitTargetGroupId,
    setBaseRefDialogOpen,
    setChangeScope,
    setChangeScopeMenuOpen
  } = model

  const branchReady = branchSummary?.status === 'ready'
  // Each summary walks every row: build only what the shown scope or the open menu reads.
  const uncommitted =
    changeScopeMenuOpen || changeScope.kind === 'uncommitted'
      ? summarizeChangeScopeEntries(entries)
      : null
  let all: ChangeScopeSummary | null = null
  if (changeScopeMenuOpen || changeScope.kind === 'all') {
    const allRows = summarizeChangeScopeEntries(
      branchReady ? [...entries, ...branchEntries] : entries
    )
    // Committed + uncommitted rows overlap per path, so only the deduplicated merge-base total is a true sum.
    all = {
      files: allRows.files,
      lines: !branchReady
        ? allRows.lines
        : branchLineTotal && branchLineTotal.mergeBase === branchSummary.mergeBase
          ? { added: branchLineTotal.added, removed: branchLineTotal.removed }
          : null
    }
  }
  const commitsAhead = branchReady ? (branchSummary.commitsAhead ?? 0) : 0
  const commitFiles =
    changeScope.kind === 'commit' &&
    commitScopeFiles?.commitId === changeScope.commit.id &&
    commitScopeFiles.status === 'ready'
      ? summarizeChangeScopeEntries(commitScopeFiles.entries)
      : null
  const scoped =
    changeScope.kind === 'all'
      ? all
      : changeScope.kind === 'uncommitted'
        ? uncommitted
        : commitFiles

  // Whole-scope ruling: All changes waits for branch compare instead of opening a partial diff.
  const branchCompareLoading =
    changeScope.kind === 'all' &&
    Boolean(compareBaseRef) &&
    (!branchSummary || branchSummary.status === 'loading')
  const openDiffDisabled =
    changeScope.kind === 'commit' ? !commitFiles?.files : (scoped?.files ?? 0) === 0
  const openDiff = (): void => {
    if (branchCompareLoading || openDiffDisabled) {
      return
    }
    if (changeScope.kind === 'commit') {
      void openHistoryCommitDiff(changeScope.commit)
      return
    }
    // The store re-checks compare readiness when building the tab; failed or unavailable
    // compare opens the uncommitted changes under their own title.
    openAllDiffs(
      currentWorktreeId,
      worktreePath,
      undefined,
      undefined,
      undefined,
      changeScope.kind === 'uncommitted' ? { uncommittedOnly: true } : { wholeScope: true }
    )
  }
  const openDiffLabel = t('auto.components.right.sidebar.SourceControl.scopeOpenDiff', 'Open diff')
  const openDiffButton = (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className={cn(
        'aria-disabled:cursor-default',
        !(openDiffDisabled && !branchCompareLoading) && 'mx-0.5'
      )}
      disabled={openDiffDisabled && !branchCompareLoading}
      // Stays focusable while loading so the tooltip can say why.
      aria-disabled={branchCompareLoading || undefined}
      aria-label={openDiffLabel}
      onClick={openDiff}
      data-testid="source-control-change-scope-open-diff"
    >
      <FileDiff className="size-3.5" />
      {t('auto.components.right.sidebar.SourceControl.scopeDiffButton', 'Diff')}
    </Button>
  )
  const showAllLabel = t(
    'auto.components.right.sidebar.SourceControl.scopeShowAll',
    'Show all changes'
  )
  const scopeLabel = scopeTriggerLabel(t, changeScope)
  const commitMeta =
    changeScope.kind === 'commit' ? commitMetaLine(changeScope.commit, intlLocale) : null
  const countTitle = scoped ? scopeCountTitle(t, scoped.files, scoped.lines, intlLocale) : null
  return (
    <DropdownMenu open={changeScopeMenuOpen} onOpenChange={setChangeScopeMenuOpen}>
      <div
        className="@container/change-scope flex h-[34px] shrink-0 items-center px-3"
        data-testid="source-control-change-scope"
      >
        {filter?.filterExpanded ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <SourceControlFilterRow
              {...filter}
              onCollapsed={() => {
                restoreFilterToggleFocus.current = true
              }}
            />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  {/* Quiet text, not a padded Button: the label sits on the 12px edge and keeps its words at 240px. */}
                  <button
                    ref={scopeTriggerRef}
                    type="button"
                    className="-ml-1 inline-flex h-6 min-w-0 shrink items-center gap-0.5 rounded-md px-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    data-testid="source-control-change-scope-trigger"
                  >
                    <span className="min-w-0 truncate">{scopeLabel}</span>
                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              {/* Always available: the label may truncate and the count hides when narrow. */}
              <TooltipContent className="max-w-xs break-words">
                {scopeLabel}
                {commitMeta ? <div className="text-muted-foreground">{commitMeta}</div> : null}
                {countTitle ? <div className="text-muted-foreground">{countTitle}</div> : null}
              </TooltipContent>
            </Tooltip>
            {changeScope.kind !== 'all' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="-ml-1 size-5 shrink-0"
                    aria-label={showAllLabel}
                    onClick={() => {
                      scopeTriggerRef.current?.focus()
                      setChangeScope(ALL_CHANGES_SCOPE)
                    }}
                  >
                    <X className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{showAllLabel}</TooltipContent>
              </Tooltip>
            ) : null}
            {/* The number yields first when narrow (or a scrollbar takes width); its text equivalent stays. */}
            {scoped && countTitle ? (
              <>
                <span
                  aria-hidden="true"
                  className="ml-0.5 shrink-0 text-2xs tabular-nums text-muted-foreground @max-[228px]/change-scope:hidden"
                  data-testid="source-control-change-scope-count"
                >
                  {scoped.files.toLocaleString(intlLocale)}
                </span>
                <span className="sr-only">{countTitle}</span>
              </>
            ) : null}
            {commitMeta ? <span className="sr-only">{commitMeta}</span> : null}
            <div className="ml-auto flex shrink-0 items-center">
              {filter ? (
                <SourceControlFilterToggle
                  {...filter}
                  embedded={false}
                  className="size-5"
                  ref={(node: HTMLButtonElement | null) => {
                    if (node && restoreFilterToggleFocus.current) {
                      restoreFilterToggleFocus.current = false
                      node.focus()
                    }
                  }}
                />
              ) : null}
              {graphControl}
              {/* Disabled buttons swallow pointer events, so a wrapper carries the tooltip. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  {openDiffDisabled && !branchCompareLoading ? (
                    <span className="mx-0.5 inline-flex">{openDiffButton}</span>
                  ) : (
                    openDiffButton
                  )}
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {branchCompareLoading
                    ? t(
                        'auto.components.right.sidebar.SourceControl.scopeLoadingBranchChanges',
                        'Loading branch changes…'
                      )
                    : openDiffLabel}
                </TooltipContent>
              </Tooltip>
              {overflowMenu}
            </div>
          </div>
        )}
      </div>
      {/* An open menu always has both summaries; the checks only narrow their types. */}
      {changeScopeMenuOpen && all && uncommitted ? (
        <SourceControlChangeScopeMenuContent
          scope={changeScope}
          onScopeChange={setChangeScope}
          baseRef={branchSummary?.baseRef ?? null}
          onChangeBaseRef={() => setBaseRefDialogOpen(true)}
          allDetail={
            branchSummary?.status === 'no-merge-base' && branchSummary.baseRef === compareBaseRef
              ? t(
                  'auto.components.right.sidebar.SourceControl.scopeNoSharedHistory',
                  'No shared history with {{ref}}',
                  { ref: formatSourceControlRefLabel(branchSummary.baseRef) }
                )
              : allScopeDetail(t, all.files, commitsAhead)
          }
          uncommittedDetail={uncommittedScopeDetail(t, uncommitted.files)}
          historyContextKey={gitHistoryContextKey}
          historyState={gitHistoryState}
          graphSupported={graphSupported}
          onOpenGitGraph={() => {
            void openGitGraph(currentWorktreeId, () => resolveSplitTargetGroupId())
          }}
          onRetry={() => void refreshGitHistory({ wakeWslDistro: true })}
        />
      ) : null}
    </DropdownMenu>
  )
}
