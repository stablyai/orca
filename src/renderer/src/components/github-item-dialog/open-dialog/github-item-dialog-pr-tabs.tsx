import React from 'react'
import { FileText, ListChecks, LoaderCircle, MessageSquare, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  resolvePullRequestRepo,
  type ItemDialogTab
} from '@/components/github/github-work-item-identity'
import { canUseGitHubRepoContext } from '@/lib/github-source-runtime-context'
import { translate } from '@/i18n/i18n'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { ChecksTab } from '../inspect-pull-request/checks-tab'
import { ConversationTab } from '../discuss-item/conversation-tab'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'
import { PRFilesCombinedDiffViewer } from '../inspect-pull-request/pr-files-combined-diff-viewer'
import {
  patchCachedPRChecks,
  patchCachedPRReviewRequests,
  patchCachedWorkItemBody
} from '../load-item-details/work-item-details-cache'

export function GitHubItemDialogPRTabs({
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
  onStateChange,
  onMutated,
  onCommentAdded,
  onReviewRequestsChange,
  tab,
  setTab,
  pendingViewedPaths,
  onViewedChange
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
  onStateChange: (state: GitHubWorkItem['state']) => void
  onMutated: () => void
  onCommentAdded: (comment: PRComment) => void
  onReviewRequestsChange?: (
    itemKey: { id: string; repoId: string },
    reviewRequests: GitHubAssignableUser[]
  ) => void
  tab: ItemDialogTab
  setTab: (tab: ItemDialogTab) => void
  pendingViewedPaths: Set<string>
  onViewedChange: (path: string, viewed: boolean) => Promise<boolean>
}): React.JSX.Element {
  const body = details?.body ?? ''
  const comments = details?.comments ?? []
  const timelineItems = details?.timelineItems ?? []
  const files = details?.files ?? []
  const filesUnavailable = details?.filesUnavailable ?? false
  const canUseFilesRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const checks = details?.checks ?? []

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as ItemDialogTab)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList
        variant="line"
        className="mx-4 mt-2 justify-start gap-3 border-b border-border/60 bg-transparent"
      >
        <TabsTrigger value="conversation" className="px-2">
          <MessageSquare className="size-3.5" />
          {translate('auto.components.GitHubItemDialog.e30a5470c9', 'Conversation')}
        </TabsTrigger>
        {workItem.type === 'pr' && (
          <>
            <TabsTrigger value="checks" className="px-2">
              <ListChecks className="size-3.5" />
              {translate('auto.components.GitHubItemDialog.4bd1f5b055', 'Checks')}
              {checks.length > 0 && (
                <span className="ml-1 text-[10px] text-muted-foreground">{checks.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="files" className="px-2">
              <FileText className="size-3.5" />
              {translate('auto.components.GitHubItemDialog.999b5ad7d9', 'Files')}
              {files.length > 0 && (
                <span className="ml-1 text-[10px] text-muted-foreground">{files.length}</span>
              )}
            </TabsTrigger>
          </>
        )}
      </TabsList>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <TabsContent value="conversation" className="mt-0">
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
        </TabsContent>

        {workItem.type === 'pr' && (
          <>
            <TabsContent value="checks" className="mt-0">
              <ChecksTab
                item={displayWorkItem ?? workItem}
                repoPath={repoPath}
                repoId={effectiveRepoId}
                sourceContext={sourceContext}
                headSha={details?.headSha}
                checks={checks}
                loading={loading || !detailsLoaded}
                variant="page"
                onChecksUpdated={(nextChecks) => {
                  if (detailsCacheKey) {
                    patchCachedPRChecks(detailsCacheKey, nextChecks)
                  }
                }}
              />
            </TabsContent>

            <TabsContent value="files" className="mt-0 h-full min-h-0 overflow-hidden">
              {loading && files.length === 0 ? (
                <div className="flex items-center justify-center py-10">
                  <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : !canUseFilesRepoContext ? (
                // Why: without a repo path or runtime host the viewer would call IPC with empty ids; diff loads and review comments both fail silently.
                <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
                  {translate(
                    'auto.components.GitHubItemDialog.00f55cc17b',
                    'Repository access is unavailable for this pull request.'
                  )}
                </div>
              ) : filesUnavailable && files.length === 0 ? (
                // Why: file fetch failed (rate limit, auth, unresolved remote); offer a retry instead of implying the PR is empty.
                <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                  <div className="text-[12px] text-muted-foreground">
                    {translate(
                      'auto.components.GitHubItemDialog.filesUnavailable',
                      "Couldn't load changed files."
                    )}
                  </div>
                  <Button variant="outline" size="sm" onClick={onMutated}>
                    <RefreshCw className="size-3.5" />
                    {translate('auto.components.GitHubItemDialog.filesRetry', 'Retry')}
                  </Button>
                </div>
              ) : files.length === 0 ? (
                <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
                  {translate('auto.components.GitHubItemDialog.3cd5ae5b7b', 'No files changed.')}
                </div>
              ) : (
                <PRFilesCombinedDiffViewer
                  files={files}
                  comments={comments}
                  repoPath={repoPath ?? ''}
                  repoId={effectiveRepoId ?? ''}
                  sourceContext={sourceContext}
                  prNumber={workItem.number}
                  prRepo={resolvePullRequestRepo(workItem, projectOrigin)}
                  prUrl={workItem.url}
                  headSha={details?.headSha}
                  baseSha={details?.baseSha}
                  pendingViewedPaths={pendingViewedPaths}
                  onCommentAdded={onCommentAdded}
                  onViewedChange={onViewedChange}
                />
              )}
            </TabsContent>
          </>
        )}
      </div>
    </Tabs>
  )
}
