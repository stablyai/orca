import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAllWorktrees } from '@/store/selectors'
import { useAppStore } from '@/store'
import { findGithubIssueWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubItemDialogProps } from '../load-item-details/github-item-dialog-types'
import { GitHubItemDialogIssueBody } from './github-item-dialog-issue-body'
import { GitHubItemDialogIssueHeader } from './github-item-dialog-issue-header'
import { GitHubItemDialogPRHeader } from './github-item-dialog-pr-header'
import { GitHubItemDialogPRTabs } from './github-item-dialog-pr-tabs'
import { GHEditSection } from '../edit-item-fields/gh-edit-section'
import { useGitHubItemDialogDetails } from '../load-item-details/use-github-item-dialog-details'
import { useGitHubItemDialogLinkCopy } from './use-github-item-dialog-link-copy'

export default function GitHubItemDialog({
  workItem,
  repoPath,
  repoId,
  sourceContext,
  initialTab,
  backLabel = 'Back',
  projectOrigin,
  onUse,
  onReviewRequestsChange,
  onClose
}: GitHubItemDialogProps): React.JSX.Element {
  const [localState, setLocalState] = useState<GitHubWorkItem['state']>(workItem?.state ?? 'open')
  const [localLabels, setLocalLabels] = useState<string[]>(workItem?.labels ?? [])
  const workItemId = workItem?.id
  const workItemState = workItem?.state
  const workItemLabels = workItem?.labels
  const effectiveRepoId = repoId ?? workItem?.repoId ?? null
  const allWorktrees = useAllWorktrees()
  const issueAttachedWorkspace = useMemo(
    () =>
      workItem?.type === 'issue'
        ? findGithubIssueWorkspaceAttachment(allWorktrees, effectiveRepoId, workItem.number)
        : null,
    [allWorktrees, effectiveRepoId, workItem]
  )
  const issueAttachedWorkspaceLabel = issueAttachedWorkspace
    ? getWorktreeAttachmentLabel(issueAttachedWorkspace)
    : null

  const handleOpenOrUseIssueWorkspace = useCallback(
    (item: GitHubWorkItem): void => {
      const currentAttached = findGithubIssueWorkspaceAttachment(
        useAppStore.getState().allWorktrees(),
        effectiveRepoId,
        item.number
      )
      if (!currentAttached) {
        onUse(item)
        return
      }

      const result = activateAndRevealWorktree(currentAttached.id)
      if (result === false) {
        toast.error(
          translate(
            'auto.components.GitHubItemDialog.2ef631437e',
            'Unable to open the workspace attached to this issue.'
          )
        )
      }
    },
    [effectiveRepoId, onUse]
  )

  const {
    tab,
    setTab,
    canUseDetailsRepoContext,
    detailsCacheKey,
    details,
    loading,
    error,
    detailsLoaded,
    displayWorkItem,
    appendOptimisticComment,
    invalidateCurrentDetailsCache,
    handlePRFileViewedChange,
    pendingViewedPaths,
    isIssuePage
  } = useGitHubItemDialogDetails({
    workItem,
    repoPath,
    effectiveRepoId,
    sourceContext,
    initialTab,
    projectOrigin,
    onReviewRequestsChange
  })
  const { linkCopied, setLinkCopyButtonRef, handleCopyWorkItemLink } =
    useGitHubItemDialogLinkCopy(workItem)

  const resolvedWorkItemState = details?.item.state ?? workItemState
  // Why: the opening list row can be stale; the detail payload has authoritative state, so refresh the local edit UI from it.
  useEffect(() => {
    if (resolvedWorkItemState) {
      setLocalState(resolvedWorkItemState)
    }
    if (workItemLabels) {
      setLocalLabels(workItemLabels)
    }
  }, [workItemId, resolvedWorkItemState, workItemLabels])

  // Why: a just-closed Radix overlay can leave `pointer-events: none` on <body>, killing header button clicks; poll a few frames to clear it.
  useEffect(() => {
    if (!workItem) {
      return
    }
    let cancelled = false
    let count = 0
    let frameId: number | null = null
    const tick = (): void => {
      frameId = null
      if (cancelled) {
        return
      }
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = ''
      }
      if (count++ < 5) {
        frameId = requestAnimationFrame(tick)
      }
    }
    tick()
    return () => {
      cancelled = true
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [workItem])

  const content = workItem ? (
    <div className="flex h-full min-h-0 flex-col">
      {isIssuePage ? (
        <GitHubItemDialogIssueHeader
          workItem={workItem}
          backLabel={backLabel}
          onClose={onClose}
          linkCopied={linkCopied}
          setLinkCopyButtonRef={setLinkCopyButtonRef}
          handleCopyWorkItemLink={handleCopyWorkItemLink}
          issueAttachedWorkspace={issueAttachedWorkspace}
          handleOpenOrUseIssueWorkspace={handleOpenOrUseIssueWorkspace}
          onUse={onUse}
          localState={localState}
          effectiveRepoId={effectiveRepoId}
          repoPath={repoPath}
          issueAttachedWorkspaceLabel={issueAttachedWorkspaceLabel}
        />
      ) : (
        <GitHubItemDialogPRHeader
          workItem={workItem}
          backLabel={backLabel}
          onClose={onClose}
          localState={localState}
          issueAttachedWorkspaceLabel={issueAttachedWorkspaceLabel}
          effectiveRepoId={effectiveRepoId}
          repoPath={repoPath}
          onUse={onUse}
          linkCopied={linkCopied}
          setLinkCopyButtonRef={setLinkCopyButtonRef}
          handleCopyWorkItemLink={handleCopyWorkItemLink}
        />
      )}

      {!isIssuePage && (canUseDetailsRepoContext || projectOrigin) && (
        <GHEditSection
          item={workItem}
          repoPath={repoPath}
          repoId={effectiveRepoId}
          sourceContext={sourceContext}
          projectOrigin={projectOrigin}
          localState={localState}
          localLabels={localLabels}
          onStateChange={setLocalState}
          onLabelsChange={setLocalLabels}
          onMutated={invalidateCurrentDetailsCache}
          assignees={details?.assignees ?? []}
          onUse={onUse}
          onOpenOrUse={handleOpenOrUseIssueWorkspace}
          attachedWorkspaceLabel={issueAttachedWorkspaceLabel}
        />
      )}

      <div className="min-h-0 flex-1">
        {error ? (
          <div className="px-4 py-6 text-[12px] text-destructive">{error}</div>
        ) : isIssuePage ? (
          <GitHubItemDialogIssueBody
            workItem={workItem}
            displayWorkItem={displayWorkItem}
            repoPath={repoPath}
            effectiveRepoId={effectiveRepoId}
            sourceContext={sourceContext}
            projectOrigin={projectOrigin}
            details={details}
            detailsCacheKey={detailsCacheKey}
            loading={loading}
            detailsLoaded={detailsLoaded}
            localState={localState}
            localLabels={localLabels}
            onStateChange={setLocalState}
            onLabelsChange={setLocalLabels}
            onMutated={invalidateCurrentDetailsCache}
            onUse={onUse}
            onOpenOrUse={handleOpenOrUseIssueWorkspace}
            attachedWorkspaceLabel={issueAttachedWorkspaceLabel}
            onCommentAdded={appendOptimisticComment}
            onReviewRequestsChange={onReviewRequestsChange}
            canUseDetailsRepoContext={canUseDetailsRepoContext}
          />
        ) : (
          <GitHubItemDialogPRTabs
            workItem={workItem}
            displayWorkItem={displayWorkItem}
            repoPath={repoPath}
            effectiveRepoId={effectiveRepoId}
            sourceContext={sourceContext}
            projectOrigin={projectOrigin}
            details={details}
            detailsCacheKey={detailsCacheKey}
            loading={loading}
            detailsLoaded={detailsLoaded}
            localState={localState}
            onStateChange={setLocalState}
            onMutated={invalidateCurrentDetailsCache}
            onCommentAdded={appendOptimisticComment}
            onReviewRequestsChange={onReviewRequestsChange}
            tab={tab}
            setTab={setTab}
            pendingViewedPaths={pendingViewedPaths}
            onViewedChange={handlePRFileViewedChange}
          />
        )}
      </div>
    </div>
  ) : null

  return (
    // Why: rendered inline (not a Radix dialog), so e2e needs a stable hook to scope assertions to this detail surface.
    <div
      data-testid="github-item-detail"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm"
    >
      {content}
    </div>
  )
}
