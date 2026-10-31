import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft
} from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { findGithubPrWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import {
  clearGitHubLinkCopied,
  createGitHubLinkCopyState,
  markGitHubLinkCopied,
  resolveGitHubLinkCopyState
} from '@/components/github-link-copy-state'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { PullRequestPageProps } from '../page-types'
import { GitHubWorkItemTargetContext } from '@/components/github-item-dialog/load-item-details/github-work-item-target-context'
import { useGitHubWorkItemDetails } from '@/components/github-item-dialog/load-item-details/use-github-work-item-details'
import { GHEditSection } from '../edit/section'
import { PullRequestPageHeader } from './header'
import { PullRequestPageTabs } from './tabs-shell'

export default function PullRequestPage(props: PullRequestPageProps): React.JSX.Element {
  const { workItem, sourceContext } = props
  const key = [
    props.repoId ?? workItem?.repoId,
    props.repoPath,
    workItem?.url,
    workItem?.type,
    workItem?.number,
    sourceContext ? getTaskSourceCacheScope(sourceContext) : ''
  ].join('\0')
  return <PullRequestPageItem key={key} {...props} />
}

function PullRequestPageItem({
  workItem,
  repoPath,
  repoId,
  sourceContext,
  initialTab,
  backLabel = translate('auto.components.TaskPage.backToPullRequests', 'Pull requests'),
  projectOrigin,
  onUse,
  onReviewRequestsChange,
  onClose
}: PullRequestPageProps): React.JSX.Element {
  const workItemId = workItem?.id
  const [localState, setLocalState] = useState<GitHubWorkItem['state']>(workItem?.state ?? 'open')
  const [localLabels, setLocalLabels] = useState<string[]>(workItem?.labels ?? [])
  const [linkCopyState, setLinkCopyState] = useState(() => createGitHubLinkCopyState(workItemId))
  const resolvedLinkCopyState = resolveGitHubLinkCopyState(linkCopyState, workItemId)
  if (resolvedLinkCopyState !== linkCopyState) {
    // Why: reconcile before paint so switching items doesn't flash the previous item's copied indicator.
    setLinkCopyState(resolvedLinkCopyState)
  }
  const linkCopied = resolvedLinkCopyState.copied
  const workItemState = workItem?.state
  const workItemLabels = workItem?.labels
  const effectiveRepoId = repoId ?? workItem?.repoId ?? null
  const allWorktrees = useAllWorktrees()
  const attachedWorkspace = useMemo(
    () =>
      workItem?.type === 'pr'
        ? findGithubPrWorkspaceAttachment(
            allWorktrees,
            effectiveRepoId,
            workItem.number,
            workItem.url
          )
        : null,
    [allWorktrees, effectiveRepoId, workItem]
  )
  const attachedWorkspaceLabel = attachedWorkspace
    ? getWorktreeAttachmentLabel(attachedWorkspace)
    : null

  const {
    targetContext,
    tab,
    setTab,
    details,
    loading,
    error,
    detailsLoaded,
    detailsCacheKey,
    appendOptimisticComment,
    canUseDetailsRepoContext,
    displayWorkItem,
    pendingViewedPaths,
    invalidateCurrentDetailsCache,
    handlePRFileViewedChange
  } = useGitHubWorkItemDetails({
    workItem,
    repoPath,
    effectiveRepoId,
    sourceContext,
    initialTab,
    projectOrigin,
    onReviewRequestsChange
  })

  // Why: reset lifted edit state on item switch or when the same item gets an optimistic cache patch from the table.
  useEffect(() => {
    if (workItemState && workItemLabels) {
      setLocalState(workItemState)
      setLocalLabels(workItemLabels)
    }
  }, [workItemId, workItemState, workItemLabels])

  const handleUseWorkItem = useCallback((): void => {
    if (!workItem) {
      return
    }
    const targetRepoId = effectiveRepoId
    onUse(
      targetRepoId && targetRepoId !== workItem.repoId
        ? { ...workItem, repoId: targetRepoId }
        : workItem
    )
  }, [effectiveRepoId, onUse, workItem])

  const handleOpenOrUsePR = useCallback((): void => {
    if (!workItem) {
      return
    }
    const targetRepoId = effectiveRepoId
    const currentAttached = findGithubPrWorkspaceAttachment(
      useAppStore.getState().allWorktrees(),
      targetRepoId,
      workItem.number,
      workItem.url
    )
    if (!currentAttached) {
      handleUseWorkItem()
      return
    }

    const result = activateAndRevealWorktree(currentAttached.id, {
      navigationIntent: 'user-open'
    })
    if (result === false) {
      toast.error(
        translate(
          'auto.components.PullRequestPage.61bfc81ada',
          'Unable to open the workspace attached to this pull request.'
        )
      )
    }
  }, [effectiveRepoId, handleUseWorkItem, workItem])

  // Why: Radix can leave `pointer-events: none` on <body> when opening right after another overlay closes, killing header clicks; poll a few frames to clear it.
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

  const Icon =
    workItem?.type === 'pr'
      ? localState === 'merged'
        ? GitMerge
        : localState === 'closed'
          ? GitPullRequestClosed
          : localState === 'draft'
            ? GitPullRequestDraft
            : GitPullRequest
      : CircleDot
  const body = details?.body ?? ''
  const comments = details?.comments ?? []
  const files = details?.files ?? []
  const filesUnavailable = details?.filesUnavailable ?? false
  const checks = details?.checks ?? []
  // Why: clipboard IPC can resolve after unmount; skip copied-state feedback rather than start a reset timer on a stale surface.
  const linkCopyMountedRef = useRef(false)
  const linkCopiedResetTimerRef = useRef<number | null>(null)
  const clearLinkCopiedResetTimer = useCallback((): void => {
    if (linkCopiedResetTimerRef.current === null) {
      return
    }
    window.clearTimeout(linkCopiedResetTimerRef.current)
    linkCopiedResetTimerRef.current = null
  }, [])
  const setLinkCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      linkCopyMountedRef.current = node !== null
      if (node === null) {
        clearLinkCopiedResetTimer()
      }
    },
    [clearLinkCopiedResetTimer]
  )

  const handleCopyWorkItemLink = useCallback(async (): Promise<void> => {
    if (!workItem) {
      return
    }
    try {
      // Why: Electron clipboard IPC works even when browser clipboard APIs lose focus/activation in nested overlays.
      await window.api.ui.writeClipboardText(workItem.url)
      if (!linkCopyMountedRef.current) {
        return
      }
      clearLinkCopiedResetTimer()
      const copiedWorkItemId = workItem.id
      setLinkCopyState(markGitHubLinkCopied(copiedWorkItemId))
      linkCopiedResetTimerRef.current = window.setTimeout(() => {
        linkCopiedResetTimerRef.current = null
        setLinkCopyState((current) => clearGitHubLinkCopied(current, copiedWorkItemId))
      }, 1500)
      toast.success(translate('auto.components.PullRequestPage.992e799227', 'GitHub link copied'))
    } catch {
      toast.error(
        translate('auto.components.PullRequestPage.e0b15c793f', 'Failed to copy GitHub link')
      )
    }
  }, [clearLinkCopiedResetTimer, workItem])

  const content = workItem ? (
    <div className="flex h-full min-h-0 flex-col">
      <PullRequestPageHeader
        workItem={workItem}
        displayWorkItem={displayWorkItem}
        backLabel={backLabel}
        onClose={onClose}
        linkCopied={linkCopied}
        setLinkCopyButtonRef={setLinkCopyButtonRef}
        onCopyLink={() => {
          void handleCopyWorkItemLink()
        }}
        hasAttachedWorkspace={attachedWorkspace !== null}
        attachedWorkspaceLabel={attachedWorkspaceLabel}
        localState={localState}
        Icon={Icon}
        onOpenOrUsePR={handleOpenOrUsePR}
        onUseWorkItem={handleUseWorkItem}
      />

      {(canUseDetailsRepoContext || projectOrigin) && (
        <GHEditSection
          item={displayWorkItem ?? workItem}
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
        />
      )}

      <div className="min-h-0 flex-1">
        {error ? (
          <div className="px-4 py-6 text-[12px] text-destructive">{error}</div>
        ) : (
          <PullRequestPageTabs
            tab={tab}
            onTabChange={setTab}
            workItem={displayWorkItem ?? workItem}
            displayWorkItem={displayWorkItem}
            repoPath={repoPath}
            effectiveRepoId={effectiveRepoId}
            sourceContext={sourceContext}
            projectOrigin={projectOrigin}
            body={body}
            comments={comments}
            files={files}
            filesUnavailable={filesUnavailable}
            checks={checks}
            loading={loading}
            detailsLoaded={detailsLoaded}
            details={details}
            localState={localState}
            setLocalState={setLocalState}
            detailsCacheKey={detailsCacheKey}
            pendingViewedPaths={pendingViewedPaths}
            invalidateCurrentDetailsCache={invalidateCurrentDetailsCache}
            appendOptimisticComment={appendOptimisticComment}
            handlePRFileViewedChange={handlePRFileViewedChange}
            onReviewRequestsChange={onReviewRequestsChange}
          />
        )}
      </div>
    </div>
  ) : null

  return (
    <GitHubWorkItemTargetContext.Provider value={targetContext}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">{content}</div>
    </GitHubWorkItemTargetContext.Provider>
  )
}
