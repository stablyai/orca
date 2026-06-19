import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownUp, ArrowUp, Check, CloudUpload, GitPullRequestArrow, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { isCommitMessageFieldDisabled } from './source-control-commit-eligibility'
import {
  PullPolicyRemoteActionNotice,
  isPullPolicyRemoteActionError
} from './source-control-pull-policy-error-notice'
import { hasExpandedCommitFailureDetails, summarizeCommitFailure } from './commit-failure-summary'
import {
  getCommitFailureDialogWorktreeKey,
  shouldShowCommitFailureDialog,
  syncCommitFailureDialogState,
  type CommitFailureDialogState
} from './commit-failure-dialog-state'
import { getCommitFailureKindLabel } from './source-control-commit-failure-action'
import { CommitFailureNotice } from './source-control-commit-failure-notice'
import {
  CommitGenerationControl,
  getCommitGenerationDisabledReason
} from './source-control-commit-generation-controls'
import { CommitPrimaryActions } from './source-control-commit-primary-actions'
import type { PrimaryAction, RemoteOpKind } from './source-control-primary-action'
import type { DropdownActionKind, DropdownEntry } from './source-control-dropdown-items'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'

export type CreatePrIntentTone = 'muted' | 'destructive'
export type CreatePrIntentNotice = {
  message: string
  tone: CreatePrIntentTone
  action?: 'settings'
}

const PRIMARY_ICONS: Partial<
  Record<
    PrimaryAction['kind'],
    React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
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

export type CommitAreaProps = {
  worktreeId: string | null
  groupId: string | null
  connectionId?: string | null
  repoId?: string | null
  launchPlatform?: NodeJS.Platform
  commitMessage: string
  commitError: string | null
  commitFailureRecoveryPrompt: string | null
  remoteActionError: string | null
  createPrIntentNotice?: CreatePrIntentNotice | null
  isCommitting: boolean
  isFixingCommitFailureWithAI: boolean
  isCreatingPr?: boolean
  isCreatePrIntentInFlight?: boolean
  showComposer?: boolean
  aiEnabled: boolean
  aiAgentConfigured: boolean
  isGenerating: boolean
  generateError: string | null
  stagedCount: number
  hasPartiallyStagedChanges: boolean
  hasUnresolvedConflicts: boolean
  isRemoteOperationActive: boolean
  inFlightRemoteOpKind: RemoteOpKind | null
  primaryAction: PrimaryAction
  dropdownItems: DropdownEntry[]
  fixCommitFailureRecipe?: SourceControlActionRecipe
  onCommitMessageChange: (message: string) => void
  onGenerate: () => void
  onCancelGenerate: () => void
  onSaveLaunchActionDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onOpenSourceControlAiSettings?: () => void
  onFixCommitFailureWithAI: (promptOverride?: string) => Promise<boolean> | boolean
  onPrimaryAction: () => void
  onDropdownAction: (kind: DropdownActionKind) => void
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
  remoteActionError,
  createPrIntentNotice,
  isCommitting,
  isFixingCommitFailureWithAI,
  isCreatingPr = false,
  isCreatePrIntentInFlight = false,
  showComposer = true,
  aiEnabled,
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
  onCommitMessageChange,
  onGenerate,
  onCancelGenerate,
  onSaveLaunchActionDefault,
  onOpenSourceControlAiSettings,
  onFixCommitFailureWithAI,
  onPrimaryAction,
  onDropdownAction
}: CommitAreaProps): React.JSX.Element {
  // Why: cap at 12 rows so a pasted multi-page commit message doesn't push
  // the Commit button off-screen. The textarea keeps `resize-none` (matching
  // the existing style) — the browser scrolls internally past 12 rows.
  const rows = Math.min(12, Math.max(2, commitMessage.split('\n').length))
  // Why: only spin the primary when its label matches what's actually
  // running. The commit-area resolver overrides the primary kind to mirror
  // the in-flight op (e.g. user picks Sync from the dropdown → primary
  // becomes "Sync"), so the equality check spins the button for any primary-
  // eligible remote op the user triggered. Background ops the primary
  // doesn't show (Fetch) leave primaryAction.kind unchanged and the
  // mismatch keeps the spinner off — the disabled state alone is enough
  // signal there. Commit still spins on isCommitting because that path
  // doesn't go through inFlightRemoteOpKind.
  const primaryHostsRemoteOperation =
    primaryAction.kind === inFlightRemoteOpKind ||
    (primaryAction.kind === 'push' && inFlightRemoteOpKind === 'force_push')
  const showSpinner =
    primaryAction.kind === 'create_pr' || primaryAction.kind === 'create_pr_intent'
      ? isCreatingPr
      : primaryAction.kind === 'commit'
        ? isCommitting
        : isRemoteOperationActive && primaryHostsRemoteOperation
  // Why: when the primary doesn't host the in-flight op (e.g. Fetch, or any
  // dropdown action that mismatches the primary's natural label) the click
  // would otherwise be silent — the toast only fires on failure and a
  // no-op fetch leaves status counts unchanged. Spinning the chevron gives
  // the user immediate feedback that the action they picked is running,
  // while still leaving the menu reachable to read the disabled-row
  // tooltips.
  const showChevronSpinner =
    (isCommitting || isCreatingPr || isRemoteOperationActive) && !showSpinner
  const commitFailureSummary = useMemo(
    () => (commitError ? summarizeCommitFailure(commitError) : null),
    [commitError]
  )
  const commitFailureKindLabel = useMemo(
    () => (commitFailureSummary ? getCommitFailureKindLabel(commitFailureSummary) : null),
    [commitFailureSummary]
  )
  const hasCommitFailureDetails = useMemo(
    () =>
      commitError && commitFailureSummary
        ? hasExpandedCommitFailureDetails(commitError, commitFailureSummary)
        : false,
    [commitError, commitFailureSummary]
  )
  // Why: the details dialog is scoped to the worktree, not the exact stderr
  // text, so a retried commit can refresh an open dialog with newer output.
  const commitFailureWorktreeKey = getCommitFailureDialogWorktreeKey(worktreeId)
  const [commitFailureDialogState, setCommitFailureDialogState] =
    useState<CommitFailureDialogState>({
      worktreeKey: commitFailureWorktreeKey,
      open: false
    })
  const isCommitFailureDialogOpen = shouldShowCommitFailureDialog(
    commitFailureDialogState,
    commitFailureWorktreeKey,
    hasCommitFailureDetails
  )
  const setCommitFailureDialogOpen = useCallback(
    (open: boolean) => {
      setCommitFailureDialogState({ worktreeKey: commitFailureWorktreeKey, open })
    },
    [commitFailureWorktreeKey]
  )
  const handleFixCommitFailureWithAI = useCallback(
    async (promptOverride?: string): Promise<boolean> => {
      const launched = await onFixCommitFailureWithAI(promptOverride)
      if (launched) {
        setCommitFailureDialogOpen(false)
      }
      return launched
    },
    [onFixCommitFailureWithAI, setCommitFailureDialogOpen]
  )
  const handleCommitFailureAgentPromptDelivered = useCallback(() => {
    setCommitFailureDialogOpen(false)
  }, [setCommitFailureDialogOpen])

  useEffect(() => {
    setCommitFailureDialogState((current) =>
      syncCommitFailureDialogState(current, commitFailureWorktreeKey, hasCommitFailureDetails)
    )
  }, [commitFailureWorktreeKey, hasCommitFailureDetails])

  // Why: most primary-kind labels are anchored by a directional icon so
  // the affirmative Commit (✓) reads distinctly from the remote-state
  // labels sharing this slot — Push (↑), Sync (↕), Publish (☁︎↑). Pull is
  // intentionally icon-less because the down-arrow read as a
  // download/save affordance. The icon is decorative; the label and
  // title attribute carry the meaning for assistive tech.
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
    remoteActionError ? 'commit-area-remote-error' : null,
    createPrIntentNotice ? 'commit-area-create-pr-intent' : null,
    generateError ? 'commit-area-generate-error' : null
  ]
    .filter(Boolean)
    .join(' ')

  // Why: only render Generate when it has a runnable path; otherwise the
  // composer should stay focused on the normal Commit action.
  // Why: Create PR intent owns message generation and surfaces status via the
  // inline notice; a second composer spinner stacks on the primary spinner.
  const showGenerate =
    showComposer && aiEnabled && !isCreatePrIntentInFlight && (aiAgentConfigured || isGenerating)
  const generateDisabledReason = getCommitGenerationDisabledReason({
    isGenerating,
    isCommitting,
    aiAgentConfigured,
    stagedCount,
    hasMessage
  })
  const isGenerateDisabled =
    !aiAgentConfigured ||
    isGenerating ||
    isCommitting ||
    stagedCount === 0 ||
    hasMessage ||
    hasUnresolvedConflicts
  const moreCommitAndRemoteActionsLabel = translate(
    'auto.components.right.sidebar.SourceControl.cc199ccc5f',
    'More commit and remote actions'
  )
  const moreActionsLabel = translate(
    'auto.components.right.sidebar.SourceControl.4d6e1fd7f3',
    'More actions'
  )

  return (
    <div className="px-3 pb-2">
      {showComposer ? (
        <div className="relative">
          <textarea
            rows={rows}
            value={commitMessage}
            disabled={isCommitMessageDisabled}
            onChange={(e) => onCommitMessageChange(e.target.value)}
            placeholder={translate(
              'auto.components.right.sidebar.SourceControl.0d0a8359d3',
              'Message'
            )}
            aria-label={translate(
              'auto.components.right.sidebar.SourceControl.b94112eb9e',
              'Commit message'
            )}
            aria-describedby={describedBy || undefined}
            // Why: reserve right padding so typed text does not slide under the
            // absolute-positioned Generate icon in the top-right corner.
            className={`mt-0.5 min-h-14 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
              showGenerate ? 'pr-8' : ''
            }`}
          />
          {showGenerate && (
            <CommitGenerationControl
              isGenerating={isGenerating}
              isGenerateDisabled={isGenerateDisabled}
              generateDisabledReason={generateDisabledReason}
              onGenerate={onGenerate}
              onCancelGenerate={onCancelGenerate}
            />
          )}
        </div>
      ) : null}
      {/* Why: the current manual action + chevron sit together as a visual
          split button so the edit → commit → push loop stays in a single
          vertical band. The chevron exposes the full action surface without
          forcing morphing labels to carry every possible intent. */}
      <CommitPrimaryActions
        showComposer={showComposer}
        primaryAction={primaryAction}
        PrimaryIcon={PrimaryIcon}
        showSpinner={showSpinner}
        showChevronSpinner={showChevronSpinner}
        dropdownItems={dropdownItems}
        moreCommitAndRemoteActionsLabel={moreCommitAndRemoteActionsLabel}
        moreActionsLabel={moreActionsLabel}
        onPrimaryAction={onPrimaryAction}
        onDropdownAction={onDropdownAction}
      />
      <CommitFailureNotice
        worktreeId={worktreeId}
        groupId={groupId}
        connectionId={connectionId}
        repoId={repoId}
        launchPlatform={launchPlatform}
        commitError={commitError}
        commitFailureSummary={commitFailureSummary}
        commitFailureKindLabel={commitFailureKindLabel}
        hasCommitFailureDetails={Boolean(hasCommitFailureDetails)}
        commitFailureWorktreeKey={commitFailureWorktreeKey}
        isCommitFailureDialogOpen={isCommitFailureDialogOpen}
        commitFailureRecoveryPrompt={commitFailureRecoveryPrompt}
        isFixingCommitFailureWithAI={isFixingCommitFailureWithAI}
        fixCommitFailureRecipe={fixCommitFailureRecipe}
        onSaveLaunchActionDefault={onSaveLaunchActionDefault}
        onOpenSourceControlAiSettings={onOpenSourceControlAiSettings}
        onFixCommitFailureWithAI={handleFixCommitFailureWithAI}
        onPromptDelivered={handleCommitFailureAgentPromptDelivered}
        onCommitFailureDialogOpenChange={setCommitFailureDialogOpen}
      />
      {remoteActionError && isPullPolicyRemoteActionError(remoteActionError) ? (
        <PullPolicyRemoteActionNotice id="commit-area-remote-error" />
      ) : remoteActionError ? (
        <p
          id="commit-area-remote-error"
          role="alert"
          aria-live="polite"
          className="mt-1 text-[11px] text-destructive"
        >
          {remoteActionError}
        </p>
      ) : null}
      {createPrIntentNotice && (
        <div
          id="commit-area-create-pr-intent"
          role={createPrIntentNotice.tone === 'destructive' ? 'alert' : 'status'}
          aria-live="polite"
          className={cn(
            'mt-1 flex min-w-0 items-center gap-1.5 text-[11px]',
            createPrIntentNotice.tone === 'destructive'
              ? 'text-destructive'
              : 'text-muted-foreground'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{createPrIntentNotice.message}</span>
          {createPrIntentNotice.action === 'settings' && onOpenSourceControlAiSettings ? (
            <button
              type="button"
              className="shrink-0 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
              onClick={() => onOpenSourceControlAiSettings()}
            >
              {translate(
                'auto.components.right.sidebar.SourceControl.473f18758e',
                'Source Control AI settings'
              )}
            </button>
          ) : null}
        </div>
      )}
      {generateError && (
        <p
          id="commit-area-generate-error"
          role="alert"
          aria-live="polite"
          className="mt-1 text-[11px] text-destructive"
        >
          {generateError}
        </p>
      )}
    </div>
  )
}
