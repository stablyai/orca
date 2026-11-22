import React, { useRef } from 'react'
import { ChevronDown, FileDiff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { openGitGraph } from '@/lib/source-control/graph/git-graph-tab'
import { useGitGraphSupport } from '../sync/git-graph-open-button'
import { SourceControlChangeScopeMenuContent, commitMetaLine } from './change-scope-menu'
import {
  ALL_CHANGES_SCOPE,
  summarizeChangeScopeEntries,
  type ChangeScopeSummary,
  type SourceControlChangeScope
} from './change-scope'
import type { SourceControlPanelReadyProps } from './panel-props'

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

function LineCounts({ added, removed }: { added: number; removed: number }): React.JSX.Element {
  return (
    <>
      {' '}
      <span className="font-mono text-3xs text-[color:var(--git-decoration-added)]">
        +{added}
      </span>{' '}
      <span className="font-mono text-3xs text-[color:var(--git-decoration-deleted)]">
        −{removed}
      </span>
    </>
  )
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
  model
}: SourceControlPanelReadyProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
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
  const graphSupported = useGitGraphSupport(currentWorktreeId) === true

  const uncommitted = summarizeChangeScopeEntries(entries)
  const branchReady = branchSummary?.status === 'ready'
  const allRows = summarizeChangeScopeEntries(
    branchReady ? [...entries, ...branchEntries] : entries
  )
  // Committed + uncommitted rows overlap per path, so only the deduplicated merge-base total is a true sum.
  const all: ChangeScopeSummary = {
    files: allRows.files,
    lines: !branchReady
      ? allRows.lines
      : branchLineTotal && branchLineTotal.mergeBase === branchSummary.mergeBase
        ? { added: branchLineTotal.added, removed: branchLineTotal.removed }
        : null
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

  const allDetail =
    commitsAhead > 0
      ? `${fileCountLabel(t, all.files)} · ${commitCountLabel(t, commitsAhead)}`
      : fileCountLabel(t, all.files)
  const uncommittedDetail =
    uncommitted.files > 0
      ? fileCountLabel(t, uncommitted.files)
      : t('auto.components.right.sidebar.SourceControl.scopeNone', 'None')

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
  const openDiffButton = (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="aria-disabled:cursor-default"
      disabled={openDiffDisabled && !branchCompareLoading}
      // Stays focusable while loading so the tooltip can say why.
      aria-disabled={branchCompareLoading || undefined}
      onClick={openDiff}
      data-testid="source-control-change-scope-open-diff"
    >
      <FileDiff className="size-3.5" />
      {t('auto.components.right.sidebar.SourceControl.scopeOpenDiff', 'Open diff')}
    </Button>
  )
  const showAllLabel = t(
    'auto.components.right.sidebar.SourceControl.scopeShowAll',
    'Show all changes'
  )

  return (
    <DropdownMenu open={changeScopeMenuOpen} onOpenChange={setChangeScopeMenuOpen}>
      <div
        className="flex shrink-0 flex-col gap-1 border-b border-border px-2.5 py-1.5"
        data-testid="source-control-change-scope"
      >
        <div className="flex min-w-0 items-center gap-1">
          <DropdownMenuTrigger asChild>
            <Button
              ref={scopeTriggerRef}
              type="button"
              variant="outline"
              size="xs"
              className="min-w-0 shrink justify-start"
              data-testid="source-control-change-scope-trigger"
            >
              <span className="min-w-0 truncate">{scopeTriggerLabel(t, changeScope)}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          {changeScope.kind !== 'all' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
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
          <span className="min-w-0 flex-1" aria-hidden="true" />
          {branchCompareLoading ? (
            <Tooltip>
              <TooltipTrigger asChild>{openDiffButton}</TooltipTrigger>
              <TooltipContent>
                {t(
                  'auto.components.right.sidebar.SourceControl.scopeLoadingBranchChanges',
                  'Loading branch changes…'
                )}
              </TooltipContent>
            </Tooltip>
          ) : (
            openDiffButton
          )}
        </div>
        <div className="truncate text-2xs text-muted-foreground">
          {changeScope.kind === 'commit'
            ? `${commitMetaLine(changeScope.commit, intlLocale)} · `
            : null}
          {scoped ? (
            <>
              {fileCountLabel(t, scoped.files)}
              {scoped.lines && scoped.files > 0 ? (
                <LineCounts added={scoped.lines.added} removed={scoped.lines.removed} />
              ) : null}
            </>
          ) : null}
          {changeScope.kind === 'all' && commitsAhead > 0 ? (
            <>
              {' · '}
              <button
                type="button"
                className="rounded-sm text-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => setChangeScopeMenuOpen(true)}
              >
                {commitCountLabel(t, commitsAhead)}
              </button>
            </>
          ) : null}
        </div>
      </div>
      {changeScopeMenuOpen ? (
        <SourceControlChangeScopeMenuContent
          scope={changeScope}
          onScopeChange={setChangeScope}
          baseRef={branchSummary?.baseRef ?? null}
          onChangeBaseRef={() => setBaseRefDialogOpen(true)}
          allDetail={allDetail}
          uncommittedDetail={uncommittedDetail}
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
