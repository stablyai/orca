import React, { useMemo } from 'react'
import { ArrowDownUp, ArrowUp, Check, CloudUpload, GitPullRequestArrow, Plus } from 'lucide-react'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { hasExpandedCommitFailureDetails, summarizeCommitFailure } from './commit-failure-summary'
import { isCommitMessageFieldDisabled } from '../../source-control-commit-eligibility'
import { CommitActionMenu } from './commit-action-menu'
import type { CommitAreaProps } from './commit-area-types'
import { CommitMessageComposer } from './commit-message-composer'
import { CommitNotices } from './commit-notices'
import { getCommitMessageTextareaRows } from './commit-message-rows'
import type { PrimaryAction } from '../../source-control-primary-action'
import { getSourceControlRecoveryFailureKindLabel } from '../sync/push-recovery'

// Why: directional icons per action; Pull stays icon-less (down-arrow read as download/save). Hoisted out of render to avoid per-render alloc.
const PRIMARY_ICONS: Partial<
  Record<
    PrimaryAction['kind'],
    React.ComponentType<{
      className?: string
      'aria-hidden'?: boolean | 'true' | 'false'
    }>
  >
> = {
  commit: Check,
  stage: Plus,
  push: ArrowUp,
  sync: ArrowDownUp,
  publish: CloudUpload,
  create_pr_intent: GitPullRequestArrow,
  create_pr: GitPullRequestArrow
}

export function CommitArea({
  worktreeId,
  groupId,
  connectionId,
  repoId,
  launchPlatform,
  commitMessage,
  commitError,
  commitFailureRecoveryPrompt,
  pushRecovery,
  remoteActionError,
  createPrIntentNotice,
  isCommitting,
  isFixingCommitFailureWithAI,
  isFixingPushFailureWithAI,
  isCreatingPr = false,
  isCreatePrIntentInFlight = false,
  showComposer = true,
  sourceControlAiActionsVisible,
  aiAgentConfigured,
  isGenerating,
  generateError,
  stagedCount,
  hasPartiallyStagedChanges,
  hasUnresolvedConflicts,
  isRemoteOperationActive,
  inFlightRemoteOpKind,
  primaryAction,
  dropdownItems,
  fixCommitFailureRecipe,
  fixPushFailureRecipe,
  onCommitMessageChange,
  onGenerate,
  onCancelGenerate,
  onSaveLaunchActionDefault,
  onOpenSourceControlAiSettings,
  onFixCommitFailureWithAI,
  onFixPushFailureWithAI,
  onPrimaryAction,
  onDropdownAction
}: CommitAreaProps): React.JSX.Element {
  // Why: cap at 12 rows so a pasted multi-page message doesn't push the Commit button off-screen (textarea scrolls internally past that).
  const rows = getCommitMessageTextareaRows(commitMessage)
  // Why: only spin the primary when its label matches the running op; mismatched background ops (Fetch) keep it off. Commit spins via isCommitting instead.
  const primaryHostsRemoteOperation =
    primaryAction.kind === inFlightRemoteOpKind ||
    (primaryAction.kind === 'push' && inFlightRemoteOpKind === 'force_push')
  const showSpinner =
    primaryAction.kind === 'create_pr' || primaryAction.kind === 'create_pr_intent'
      ? isCreatingPr
      : primaryAction.kind === 'commit'
        ? isCommitting
        : isRemoteOperationActive && primaryHostsRemoteOperation
  // Why: spin the chevron when the primary doesn't host the in-flight op (e.g. Fetch), since the click is otherwise silent — no toast until failure, no count change on a no-op fetch.
  const showChevronSpinner =
    (isCommitting || isCreatingPr || isRemoteOperationActive) && !showSpinner
  const commitFailureSummary = useMemo(
    () => (commitError ? summarizeCommitFailure(commitError) : null),
    [commitError]
  )
  const commitFailureKindLabel = useMemo(
    () =>
      commitFailureSummary ? getSourceControlRecoveryFailureKindLabel(commitFailureSummary) : null,
    [commitFailureSummary]
  )
  const hasCommitFailureDetails = useMemo(
    () =>
      commitError && commitFailureSummary
        ? hasExpandedCommitFailureDetails(commitError, commitFailureSummary)
        : false,
    [commitError, commitFailureSummary]
  )
  const PrimaryIcon = PRIMARY_ICONS[primaryAction.kind]
  const hasMessage = commitMessage.trim().length > 0
  const isCommitMessageDisabled = isCommitMessageFieldDisabled({
    stagedCount,
    hasPartiallyStagedChanges,
    hasMessage,
    hasUnresolvedConflicts,
    isCommitting,
    isRemoteOperationActive,
    isPullRequestOperationActive: isCreatingPr
  })
  const describedBy = [
    commitError ? 'commit-area-error' : null,
    pushRecovery ? 'commit-area-push-error' : null,
    remoteActionError ? 'commit-area-remote-error' : null,
    createPrIntentNotice ? 'commit-area-create-pr-intent' : null,
    generateError ? 'commit-area-generate-error' : null
  ]
    .filter(Boolean)
    .join(' ')

  // Why: config errors are surfaced by the generation dialog, so entry-point visibility only follows the feature toggle.
  // Why: Create PR intent owns generation, so a second composer spinner would stack on the primary spinner.
  const showGenerate = showComposer && sourceControlAiActionsVisible && !isCreatePrIntentInFlight
  let generateTooltip: string | undefined
  if (isGenerating) {
    generateTooltip = translate(
      'auto.components.right.sidebar.source.control.commit.area.cc5739bd1d',
      'Generating commit message…'
    )
  } else if (isCommitting) {
    generateTooltip = translate(
      'auto.components.right.sidebar.source.control.commit.area.4cbd0cd9d2',
      'Commit in progress…'
    )
  } else if (stagedCount === 0) {
    generateTooltip = translate(
      'auto.components.right.sidebar.source.control.commit.area.e7876a2bde',
      'Stage at least one file to generate a message.'
    )
  } else if (hasMessage) {
    generateTooltip = translate(
      'auto.components.right.sidebar.source.control.commit.area.0904be2505',
      'Clear the message to regenerate.'
    )
  } else if (!aiAgentConfigured) {
    generateTooltip = translate(
      'auto.components.right.sidebar.source.control.commit.area.1ea9ba37aa',
      'Pick an agent in Settings -> Git -> Source Control AI.'
    )
  }
  const isGenerateDisabled =
    isGenerating || isCommitting || stagedCount === 0 || hasMessage || hasUnresolvedConflicts
  const moreCommitAndRemoteActionsLabel = translate(
    'auto.components.right.sidebar.SourceControl.cc199ccc5f',
    'More commit and remote actions'
  )
  const moreActionsLabel = translate(
    'auto.components.right.sidebar.SourceControl.4d6e1fd7f3',
    'More actions'
  )
  const dropdownMenuContent = (
    <DropdownMenuContent align="end" className="min-w-[14rem]">
      {dropdownItems.map((entry) =>
        entry.kind === 'separator' ? (
          <DropdownMenuSeparator key={entry.id} />
        ) : (
          <Tooltip key={entry.kind}>
            <TooltipTrigger asChild>
              <div className="block">
                <DropdownMenuItem
                  disabled={entry.disabled}
                  title={entry.title}
                  variant={entry.variant}
                  className="w-full"
                  onSelect={(event) => {
                    if (entry.disabled) {
                      event.preventDefault()
                      return
                    }
                    onDropdownAction(entry.kind)
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span>{entry.label}</span>
                    {entry.hint ? (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {entry.hint}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              </div>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8} className="max-w-72">
              {entry.title}
            </TooltipContent>
          </Tooltip>
        )
      )}
    </DropdownMenuContent>
  )

  return (
    <div className="px-3 pb-2">
      {showComposer ? (
        <CommitMessageComposer
          rows={rows}
          commitMessage={commitMessage}
          disabled={isCommitMessageDisabled}
          onCommitMessageChange={onCommitMessageChange}
          describedBy={describedBy}
          showGenerate={showGenerate}
          isGenerating={isGenerating}
          onCancelGenerate={onCancelGenerate}
          isGenerateDisabled={isGenerateDisabled}
          onGenerate={onGenerate}
          generateTooltip={generateTooltip}
        />
      ) : null}
      <CommitActionMenu
        showComposer={showComposer}
        primaryAction={primaryAction}
        PrimaryIcon={PrimaryIcon}
        showSpinner={showSpinner}
        showChevronSpinner={showChevronSpinner}
        moreCommitAndRemoteActionsLabel={moreCommitAndRemoteActionsLabel}
        moreActionsLabel={moreActionsLabel}
        dropdownMenuContent={dropdownMenuContent}
        onPrimaryAction={onPrimaryAction}
      />
      <CommitNotices
        worktreeId={worktreeId}
        groupId={groupId}
        connectionId={connectionId}
        repoId={repoId}
        launchPlatform={launchPlatform}
        commitError={commitError}
        commitFailureSummary={commitFailureSummary}
        commitFailureKindLabel={commitFailureKindLabel}
        hasCommitFailureDetails={hasCommitFailureDetails}
        commitFailureRecoveryPrompt={commitFailureRecoveryPrompt}
        pushRecovery={pushRecovery}
        remoteActionError={remoteActionError}
        createPrIntentNotice={createPrIntentNotice}
        generateError={generateError}
        sourceControlAiActionsVisible={sourceControlAiActionsVisible}
        isFixingCommitFailureWithAI={isFixingCommitFailureWithAI}
        isFixingPushFailureWithAI={isFixingPushFailureWithAI}
        fixCommitFailureRecipe={fixCommitFailureRecipe}
        fixPushFailureRecipe={fixPushFailureRecipe}
        onSaveLaunchActionDefault={onSaveLaunchActionDefault}
        onOpenSourceControlAiSettings={onOpenSourceControlAiSettings}
        onFixCommitFailureWithAI={onFixCommitFailureWithAI}
        onFixPushFailureWithAI={onFixPushFailureWithAI}
      />
    </div>
  )
}
