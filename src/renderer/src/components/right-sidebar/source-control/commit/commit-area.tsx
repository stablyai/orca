import React, { useMemo } from 'react'
import { ArrowDownUp, ArrowUp, Check, CloudUpload, GitPullRequestArrow, Plus } from 'lucide-react'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  hasExpandedCommitFailureDetails,
  summarizeCommitFailure
} from '../../../../../../shared/source-control/recovery/source-control-commit-failure'
import { isCommitMessageFieldDisabled } from '../../../../../../shared/source-control/decisions/source-control-commit-eligibility'
import { CommitActionMenu } from './commit-action-menu'
import type { CommitAreaProps } from './commit-area-types'
import { CommitMessageComposer } from './commit-message-composer'
import { CommitNotices } from './commit-notices'
import { getCommitMessageTextareaRows } from './commit-message-rows'
import type { PrimaryAction } from '../review/source-control-primary-action-types'
import { getSourceControlRecoveryFailureKindLabel } from '../sync/push-recovery'

// Omit Pull's icon because a down arrow reads as download/save; hoist the map to avoid render allocations.
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
  const t = useTranslate()
  // Cap rows so long messages scroll internally instead of pushing Commit offscreen.
  const rows = getCommitMessageTextareaRows(commitMessage)
  // Spin the primary only for its matching operation; Fetch uses the chevron and commits use isCommitting.
  const primaryHostsRemoteOperation =
    primaryAction.kind === inFlightRemoteOpKind ||
    (primaryAction.kind === 'push' && inFlightRemoteOpKind === 'force_push')
  const showSpinner =
    primaryAction.kind === 'create_pr' || primaryAction.kind === 'create_pr_intent'
      ? isCreatingPr
      : primaryAction.kind === 'commit'
        ? isCommitting
        : isRemoteOperationActive &&
          primaryHostsRemoteOperation &&
          !primaryAction.isWaitingForRemoteOperation
  // Spin the chevron for operations absent from the primary; otherwise no-op Fetch has no immediate feedback.
  const showChevronSpinner =
    (isCommitting || isCreatingPr || isRemoteOperationActive) &&
    !showSpinner &&
    !primaryAction.isWaitingForRemoteOperation
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

  // The feature toggle owns visibility; dialogs report config errors, and Create PR intent owns its generation spinner.
  const showGenerate = showComposer && sourceControlAiActionsVisible && !isCreatePrIntentInFlight
  let generateTooltip: string | undefined
  if (isGenerating) {
    generateTooltip = t(
      'auto.components.right.sidebar.source.control.commit.area.cc5739bd1d',
      'Generating commit message…'
    )
  } else if (isCommitting) {
    generateTooltip = t(
      'auto.components.right.sidebar.source.control.commit.area.4cbd0cd9d2',
      'Commit in progress…'
    )
  } else if (stagedCount === 0) {
    generateTooltip = t(
      'auto.components.right.sidebar.source.control.commit.area.e7876a2bde',
      'Stage at least one file to generate a message.'
    )
  } else if (hasMessage) {
    generateTooltip = t(
      'auto.components.right.sidebar.source.control.commit.area.0904be2505',
      'Clear the message to regenerate.'
    )
  } else if (!aiAgentConfigured) {
    generateTooltip = t(
      'auto.components.right.sidebar.source.control.commit.area.1ea9ba37aa',
      'Pick an agent in Settings -> Git -> Source Control AI.'
    )
  }
  const isGenerateDisabled =
    isGenerating || isCommitting || stagedCount === 0 || hasMessage || hasUnresolvedConflicts
  const moreCommitAndRemoteActionsLabel = t(
    'auto.components.right.sidebar.SourceControl.cc199ccc5f',
    'More commit and remote actions'
  )
  const dropdownMenuContent = (
    <DropdownMenuContent align="end" className="w-58 max-w-[calc(100vw-1rem)]">
      {dropdownItems.map((entry) =>
        entry.kind === 'separator' ? (
          <DropdownMenuSeparator key={entry.id} />
        ) : (
          <DropdownMenuItem
            key={entry.kind}
            className="min-h-7"
            aria-disabled={entry.disabled || undefined}
            aria-description={entry.title}
            variant={entry.variant}
            textValue={entry.label}
            onSelect={(event) => {
              if (entry.disabled) {
                event.preventDefault()
                return
              }
              onDropdownAction(entry.kind)
            }}
          >
            <span className={cn('min-w-0 truncate', entry.idle && 'text-muted-foreground')}>
              {entry.label}
            </span>
            {entry.status && (
              <span
                className={cn(
                  'ml-auto shrink-0 pl-3 text-2xs whitespace-nowrap tabular-nums',
                  entry.statusTone === 'warning'
                    ? 'text-status-warning-text'
                    : entry.statusTone === 'active'
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                )}
              >
                {entry.status}
              </span>
            )}
          </DropdownMenuItem>
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
