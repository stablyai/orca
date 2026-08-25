import React from 'react'
import { Check, LoaderCircle, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import HostedReviewActions from '../HostedReviewActions'
import { GitHubPRStackMap } from '../GitHubPRStackMap'
import { SourceControlAgentActionDialog } from '../SourceControlAgentActionDialog'
import { ChecksPanelUpdatedAtMetadata } from '../checks-panel-updated-at-metadata'
import { getChecksPanelRefreshErrorBannerLine } from '../github-refresh-error-copy'
import { resolveChecksPanelHostedReviewModifierDestination } from '../checks-panel-hosted-review-click-routing'
import { readSourceControlLaunchRecipeAgentId } from '@/lib/source-control-launch-agent-selection'
import { resolveSourceControlActionRecipe } from '../../../../../shared/source-control-ai'
import { clearPendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import { getBrokenChecks } from '../../pr-checks-fix-prompt'
import { PRTriageStrip } from './triage-strip'
import { ConflictingFilesSection, MergeConflictNotice } from './conflict-summary'
import { ChecksList } from './checks-list'
import { PRCommentsList } from './comments-list'
import { translate } from '@/i18n/i18n'
import type { ChecksPanelReview } from '../checks-panel-review'
import type { ChecksPanelHostedReviewModifierDestination } from '../checks-panel-hosted-review-click-routing'
import type { ChecksPanelActiveContentModel } from './active-content-props'
type ReviewHeaderComponentProps = {
  review: ChecksPanelReview
  isRefreshing: boolean
  canUnlinkPullRequest: boolean
  modifierHintDestination: ChecksPanelHostedReviewModifierDestination
  onRefresh: () => void
  onOpenReview: (event: React.MouseEvent<HTMLButtonElement>) => void
  onUnlinkPullRequest: () => void
  onLinkAnotherPullRequest: () => void
}

export function ChecksPanelActiveContent({
  model,
  ReviewHeaderComponent
}: {
  model: ChecksPanelActiveContentModel
  ReviewHeaderComponent: React.ComponentType<ReviewHeaderComponentProps>
}): React.JSX.Element | null {
  const {
    activeConnectionId,
    activeConflictReview,
    activeGitLabReview,
    activeReview,
    activeSourceControlLaunchPlatform,
    activeWorktree,
    activeWorktreeId,
    agentComposerState,
    aiActionDisabledReason,
    canTargetPRComments,
    checks,
    checksLoading,
    claimedCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    comments,
    commentsDisabledReason,
    commentsLoading,
    commentsSelectionClearRequest,
    conflictDetailsRefreshing,
    consumeClaimedCommentResolutionAfterDeliveryRef,
    detachedHeadDisplay,
    editingTitle,
    getGitLabProjectRef,
    handleAddPRComment,
    handleCancelEdit,
    handleDeleteComment,
    handleEditComment,
    handleFixChecksWithAI,
    handleLaunchAborted,
    handleLaunchAccepted,
    handleLinkAnotherPullRequest,
    handleLoadCheckDetails,
    handleOpenPR,
    handleOpenStackPR,
    handleRefresh,
    handleReplyToComment,
    handleResolve,
    handleResolveCommentsWithAI,
    handleResolveConflictsWithAI,
    handleSaveTitle,
    handleSetReaction,
    handleStartEdit,
    handleTitleKeyDown,
    handleUnlinkPullRequest,
    isFixingChecksWithAI,
    isRefreshing,
    isResolvingConflictsWithAI,
    linkedPR,
    pendingCommentResolutionRef,
    pr,
    prRefreshState,
    refreshHostedReviewAfterMutation,
    repo,
    resolveCommentsWithAIDisabledReason,
    saveLaunchActionDefault,
    setAgentComposerState,
    setChecksPanelContentRef,
    settings,
    sourceControlAiActionsVisible,
    stateRequestKey,
    titleDraft,
    titleInputRef,
    titleSaving,
    setTitleDraft
  } = model
  if (!activeReview) {
    return null
  }
  const reviewShortLabel = activeReview.provider === 'gitlab' ? 'MR' : 'PR'
  const shouldShowReviewTriageStrip =
    activeConflictReview !== null || getBrokenChecks(checks).length > 0
  const hostedReviewModifierHintDestination = resolveChecksPanelHostedReviewModifierDestination(
    settings,
    Boolean(activeWorktreeId)
  )
  return (
    <div ref={setChecksPanelContentRef} className="flex-1 overflow-auto scrollbar-sleek">
      {/* Why: surface a background-refresh failure over stale cached PR data so a GitHub outage doesn't look like a normal panel. GitHub-only. */}
      {activeReview?.provider === 'github' && prRefreshState?.status === 'error' ? (
        <div
          role="alert"
          className="border-b border-border/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {getChecksPanelRefreshErrorBannerLine(prRefreshState.errorType)}
        </div>
      ) : null}
      {/* Hosted review header */}
      <div className="px-3 py-3 border-b border-border space-y-2.5">
        {/* Review number + state badge + refresh + open link */}
        <ReviewHeaderComponent
          review={activeReview}
          isRefreshing={isRefreshing}
          canUnlinkPullRequest={linkedPR !== null}
          modifierHintDestination={hostedReviewModifierHintDestination}
          onRefresh={() => void handleRefresh()}
          onOpenReview={handleOpenPR}
          onUnlinkPullRequest={handleUnlinkPullRequest}
          onLinkAnotherPullRequest={handleLinkAnotherPullRequest}
        />

        {detachedHeadDisplay && <DetachedHeadBadge display={detachedHeadDisplay} side="bottom" />}

        {activeReview.provider === 'github' && pr?.stack ? (
          <GitHubPRStackMap
            stack={pr.stack}
            currentPRNumber={pr.number}
            onOpenPullRequest={handleOpenStackPR}
          />
        ) : null}

        {/* Review title */}
        {editingTitle ? (
          <div className="flex items-center gap-1">
            <input
              ref={titleInputRef}
              className="flex-1 text-[12px] bg-background border border-border rounded px-2 py-1 text-foreground outline-none focus:ring-1 focus:ring-ring"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              disabled={titleSaving}
            />
            <button
              className="cursor-pointer rounded p-1 text-emerald-500 transition-colors hover:bg-accent hover:text-emerald-400 disabled:cursor-default disabled:opacity-50"
              title={translate('auto.components.right.sidebar.ChecksPanel.2ab7fd4b6d', 'Save')}
              onClick={() => void handleSaveTitle()}
              disabled={titleSaving}
            >
              {titleSaving ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
            </button>
            <button
              className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
              title={translate('auto.components.right.sidebar.ChecksPanel.058039787c', 'Cancel')}
              onClick={handleCancelEdit}
              disabled={titleSaving}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <div
            className="group/title flex items-start gap-1.5 cursor-pointer -mx-1 px-1 py-0.5 rounded hover:bg-accent/40 transition-colors"
            onClick={handleStartEdit}
          >
            <span className="text-[12px] text-foreground leading-snug flex-1">
              {activeReview.title}
            </span>
            <Pencil className="size-3 text-muted-foreground/40 can-hover:opacity-0 group-hover/title:opacity-100 transition-opacity shrink-0 mt-0.5" />
          </div>
        )}

        {/* Updated at */}
        {activeReview.updatedAt && (
          <ChecksPanelUpdatedAtMetadata
            reviewShortLabel={reviewShortLabel}
            updatedAt={activeReview.updatedAt}
          />
        )}
        {/* Merge / Delete Workspace actions */}
        {activeReview && activeWorktree && repo && (
          <HostedReviewActions
            review={activeReview}
            githubPR={pr}
            repo={repo}
            worktree={activeWorktree}
            onRefreshReview={refreshHostedReviewAfterMutation}
          />
        )}
      </div>

      {shouldShowReviewTriageStrip && sourceControlAiActionsVisible && (
        <PRTriageStrip
          review={activeConflictReview ?? activeReview}
          reviewKind={reviewShortLabel}
          checks={checks}
          isResolvingConflictsWithAI={isResolvingConflictsWithAI}
          onResolveConflictsWithAI={() => void handleResolveConflictsWithAI()}
          resolveConflictsDisabled={Boolean(aiActionDisabledReason)}
          resolveConflictsDisabledReason={aiActionDisabledReason}
          isFixingChecksWithAI={isFixingChecksWithAI}
          onFixChecksWithAI={() => void handleFixChecksWithAI()}
          fixChecksDisabled={Boolean(aiActionDisabledReason)}
          fixChecksDisabledReason={aiActionDisabledReason}
        />
      )}
      {activeConflictReview && (
        <>
          {/* Why: the triage strip owns the single Resolve action; the file list and fallback notice are informational. */}
          <ConflictingFilesSection pr={activeConflictReview} />
          <MergeConflictNotice
            pr={activeConflictReview}
            isRefreshingConflictDetails={isRefreshing || conflictDetailsRefreshing}
          />
        </>
      )}
      {/* Why: with merge conflicts and no checks fetched, "No checks configured" is misleading — checks can't run until conflicts resolve. */}
      {!(activeConflictReview && checks.length === 0 && !checksLoading) && (
        <ChecksList
          checks={checks}
          checksLoading={checksLoading}
          checkDetailsContextKey={stateRequestKey}
          onLoadCheckDetails={handleLoadCheckDetails}
          githubRepository={pr?.prRepo ?? null}
          getGitLabProjectRef={getGitLabProjectRef}
        />
      )}
      <PRCommentsList
        comments={comments}
        commentsLoading={commentsLoading}
        reviewKind={reviewShortLabel}
        commentsDisabled={!canTargetPRComments}
        commentsDisabledReason={commentsDisabledReason}
        selectionContextKey={stateRequestKey}
        selectionClearRequest={commentsSelectionClearRequest}
        resolveCommentsWithAIDisabled={Boolean(resolveCommentsWithAIDisabledReason)}
        resolveCommentsWithAIDisabledReason={resolveCommentsWithAIDisabledReason}
        onAddComment={pr ? handleAddPRComment : undefined}
        onResolveSelectedCommentsWithAI={
          sourceControlAiActionsVisible ? handleResolveCommentsWithAI : undefined
        }
        onReply={pr ? handleReplyToComment : undefined}
        onResolve={pr || activeGitLabReview ? handleResolve : undefined}
        onEditComment={pr ? handleEditComment : undefined}
        onDeleteComment={pr ? handleDeleteComment : undefined}
        onSetReaction={canTargetPRComments ? handleSetReaction : undefined}
      />
      <SourceControlAgentActionDialog
        open={sourceControlAiActionsVisible && agentComposerState !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAgentComposerState(null)
            // Why: a launch in flight owns the payload (claimed ref). Any other close —
            // cancel, or closing after a failed launch — must drop it so the next action
            // (e.g. fix checks) does not post stale fixing replies.
            if (!commentResolutionLaunchAcceptedRef.current) {
              pendingCommentResolutionRef.current = null
              claimedCommentResolutionRef.current = null
              clearPendingPRCommentAiAck()
            }
          }
        }}
        actionId={agentComposerState?.actionId ?? 'fixChecks'}
        title={
          agentComposerState?.title ??
          translate('auto.components.right.sidebar.ChecksPanel.7fad8509fe', 'Fix With AI')
        }
        description={agentComposerState?.description ?? ''}
        baseCommandInput={agentComposerState?.prompt ?? ''}
        worktreeId={activeWorktreeId}
        groupId={activeWorktreeId}
        connectionId={activeConnectionId}
        repoId={repo?.id ?? null}
        promptDelivery="submit-after-ready"
        launchPlatform={activeSourceControlLaunchPlatform}
        launchSource={agentComposerState?.launchSource ?? 'task_page'}
        savedAgentId={
          agentComposerState
            ? readSourceControlLaunchRecipeAgentId(
                resolveSourceControlActionRecipe({
                  settings,
                  repo,
                  actionId: agentComposerState.actionId
                })
              )
            : null
        }
        savedCommandInputTemplate={
          agentComposerState
            ? (resolveSourceControlActionRecipe({
                settings,
                repo,
                actionId: agentComposerState.actionId
              }).commandInputTemplate ?? null)
            : null
        }
        savedAgentArgs={
          agentComposerState
            ? (resolveSourceControlActionRecipe({
                settings,
                repo,
                actionId: agentComposerState.actionId
              }).agentArgs ?? null)
            : null
        }
        onSaveAgentDefault={saveLaunchActionDefault}
        // Why: claims the ack payload when the tab exists; the host writes still wait for delivery.
        onLaunchAccepted={handleLaunchAccepted}
        onLaunchAborted={handleLaunchAborted}
        onLaunched={() => {
          // Why: prompt delivery succeeded — the only point at which host replies/resolves may run.
          consumeClaimedCommentResolutionAfterDeliveryRef.current()
          if (agentComposerState?.actionId === 'resolveConflicts') {
            toast.success(
              translate(
                'auto.components.right.sidebar.ChecksPanel.a0181a8d76',
                'Started an AI agent for the conflicts.'
              )
            )
            return
          }
          if (agentComposerState?.actionId === 'resolveComments') {
            // Why: resolve/reply toast is emitted by resolveSelectedThreadsAfterLaunch.
            return
          }
          toast.success(
            translate(
              'auto.components.right.sidebar.ChecksPanel.2ef90c9819',
              'Started an AI agent for the broken checks.'
            )
          )
        }}
      />
    </div>
  )
}
