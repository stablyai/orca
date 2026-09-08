import React from 'react'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { ConversationTab } from '../discuss-item/conversation-tab'
import { GHEditSection } from '../edit-item-fields/gh-edit-section'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'
import {
  patchCachedPRChecks,
  patchCachedPRReviewRequests,
  patchCachedWorkItemBody
} from '../load-item-details/work-item-details-cache'

export function GitHubItemDialogIssueBody({
  workItem,
  displayWorkItem,
  repoPath,
  effectiveRepoId,
  sourceContext,
  projectOrigin,
  details,
  detailsCacheKey,
  loading,
  detailsLoaded,
  localState,
  localLabels,
  onStateChange,
  onLabelsChange,
  onMutated,
  onUse,
  onOpenOrUse,
  attachedWorkspaceLabel,
  onCommentAdded,
  onReviewRequestsChange,
  canUseDetailsRepoContext
}: {
  workItem: GitHubWorkItem
  displayWorkItem: GitHubWorkItem | null
  repoPath: string | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin?: GitHubItemDialogProjectOrigin
  details: GitHubWorkItemDetails | null
  detailsCacheKey: string | null
  loading: boolean
  detailsLoaded: boolean
  localState: GitHubWorkItem['state']
  localLabels: string[]
  onStateChange: (state: GitHubWorkItem['state']) => void
  onLabelsChange: (labels: string[]) => void
  onMutated: () => void
  onUse: (item: GitHubWorkItem) => void
  onOpenOrUse: (item: GitHubWorkItem) => void
  attachedWorkspaceLabel: string | null
  onCommentAdded: (comment: PRComment) => void
  onReviewRequestsChange?: (
    itemKey: { id: string; repoId: string },
    reviewRequests: GitHubAssignableUser[]
  ) => void
  canUseDetailsRepoContext: boolean
}): React.JSX.Element {
  const body = details?.body ?? ''
  const comments = details?.comments ?? []
  const timelineItems = details?.timelineItems ?? []
  const files = details?.files ?? []
  const checks = details?.checks ?? []

  return (
    <div className="h-full min-h-0 overflow-y-auto scrollbar-sleek bg-background">
      {/* Why: full content width so the description isn't squeezed by a right rail; px-2 + ConversationTab px-4 = header px-6. */}
      <div className="w-full px-2 py-6">
        {(canUseDetailsRepoContext || projectOrigin) && (
          <div className="mb-5 border-b border-border/60 px-4 pb-5">
            <GHEditSection
              item={workItem}
              repoPath={repoPath}
              repoId={effectiveRepoId}
              sourceContext={sourceContext}
              projectOrigin={projectOrigin}
              localState={localState}
              localLabels={localLabels}
              onStateChange={onStateChange}
              onLabelsChange={onLabelsChange}
              onMutated={onMutated}
              assignees={details?.assignees ?? []}
              onUse={onUse}
              onOpenOrUse={onOpenOrUse}
              attachedWorkspaceLabel={attachedWorkspaceLabel}
              layout="top-columns"
            />
          </div>
        )}
        <div className="min-w-0">
          <ConversationTab
            item={displayWorkItem ?? workItem}
            repoPath={repoPath}
            repoId={effectiveRepoId}
            sourceContext={sourceContext}
            body={body}
            comments={comments}
            timelineItems={timelineItems}
            files={files}
            headSha={details?.headSha}
            baseSha={details?.baseSha}
            loading={loading}
            detailsLoaded={detailsLoaded}
            checks={checks}
            localState={localState}
            onStateChange={onStateChange}
            projectOrigin={projectOrigin}
            onMutated={onMutated}
            onChecksUpdated={(nextChecks) => {
              if (detailsCacheKey) {
                patchCachedPRChecks(detailsCacheKey, nextChecks)
              }
            }}
            onBodyUpdated={(nextBody) => {
              if (detailsCacheKey) {
                patchCachedWorkItemBody(detailsCacheKey, nextBody)
              }
            }}
            onCommentAdded={onCommentAdded}
            onReviewersRequested={(nextReviewRequests) => {
              if (detailsCacheKey) {
                patchCachedPRReviewRequests(detailsCacheKey, nextReviewRequests)
              }
              onReviewRequestsChange?.(
                { id: workItem.id, repoId: workItem.repoId },
                nextReviewRequests
              )
            }}
          />
        </div>
      </div>
    </div>
  )
}
