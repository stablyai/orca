import React from 'react'
import { FileText, ListChecks, LoaderCircle, MessageSquare, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  resolvePullRequestRepo,
  type ItemDialogTab
} from '@/components/github/github-work-item-identity'
import { translate } from '@/i18n/i18n'
import type {
  GitHubAssignableUser,
  GitHubPRFile
} from '../../../../../shared/github/pull-request-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { PullRequestPageProjectOrigin } from '../page-types'
import {
  patchCachedPRChecks,
  patchCachedPRReviewRequests,
  patchCachedWorkItemBody
} from '../cache/work-item-details'
import { ConversationTab } from '../conversation/tab'
import { ChecksTab } from '../checks/tab'
import { PRFilesCombinedDiffViewer } from '../files/combined-diff-viewer'

export function PullRequestPageTabs({
  tab,
  onTabChange,
  workItem,
  displayWorkItem,
  repoPath,
  effectiveRepoId,
  sourceContext,
  projectOrigin,
  body,
  comments,
  files,
  filesUnavailable,
  checks,
  loading,
  detailsLoaded,
  details,
  localState,
  setLocalState,
  detailsCacheKey,
  pendingViewedPaths,
  invalidateCurrentDetailsCache,
  appendOptimisticComment,
  handlePRFileViewedChange,
  onReviewRequestsChange
}: {
  tab: ItemDialogTab
  onTabChange: (value: ItemDialogTab) => void
  workItem: GitHubWorkItem
  displayWorkItem: GitHubWorkItem | null
  repoPath: string | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  body: string
  comments: PRComment[]
  files: GitHubPRFile[]
  filesUnavailable: boolean
  checks: PRCheckDetail[]
  loading: boolean
  detailsLoaded: boolean
  details: GitHubWorkItemDetails | null
  localState: GitHubWorkItem['state']
  setLocalState: (state: GitHubWorkItem['state']) => void
  detailsCacheKey: string | null
  pendingViewedPaths: Set<string>
  invalidateCurrentDetailsCache: () => void
  appendOptimisticComment: (comment: PRComment) => void
  handlePRFileViewedChange: (path: string, viewed: boolean) => Promise<boolean>
  onReviewRequestsChange?: (
    itemKey: { id: string; repoId: string },
    reviewRequests: GitHubAssignableUser[]
  ) => void
}): React.JSX.Element {
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as ItemDialogTab)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      {/* Why: the line variant already underlines the active tab via ::after; a second border would box the trigger. */}
      <TabsList
        variant="line"
        className="mx-0 justify-start gap-2 border-b border-border/60 bg-transparent px-6"
      >
        <TabsTrigger value="conversation" className="px-3 py-2.5">
          <MessageSquare className="size-3.5" />
          {translate('auto.components.PullRequestPage.9e8d45700e', 'Conversation')}
        </TabsTrigger>
        <TabsTrigger value="checks" className="px-3 py-2.5">
          <ListChecks className="size-3.5" />
          {translate('auto.components.PullRequestPage.94d95cf1f7', 'Checks')}
          {checks.length > 0 && (
            <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
              {checks.length}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="files" className="px-3 py-2.5">
          <FileText className="size-3.5" />
          {translate('auto.components.PullRequestPage.4d18310d55', 'Files changed')}
          {files.length > 0 && (
            <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
              {files.length}
            </span>
          )}
        </TabsTrigger>
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
            files={files}
            headSha={details?.headSha}
            baseSha={details?.baseSha}
            loading={loading}
            detailsLoaded={detailsLoaded}
            checks={checks}
            participants={details?.participants ?? []}
            localState={localState}
            onStateChange={setLocalState}
            projectOrigin={projectOrigin}
            onMutated={invalidateCurrentDetailsCache}
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
            onCommentAdded={appendOptimisticComment}
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

        <TabsContent value="checks" className="mt-0">
          <ChecksTab
            item={workItem}
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
          ) : filesUnavailable && files.length === 0 ? (
            // Why: fetch failed (rate limit/auth/unresolved remote); offer retry instead of implying the PR is empty.
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
              <div className="text-[12px] text-muted-foreground">
                {translate(
                  'auto.components.PullRequestPage.filesUnavailable',
                  "Couldn't load changed files."
                )}
              </div>
              <Button variant="outline" size="sm" onClick={invalidateCurrentDetailsCache}>
                <RefreshCw className="size-3.5" />
                {translate('auto.components.PullRequestPage.filesRetry', 'Retry')}
              </Button>
            </div>
          ) : files.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
              {translate('auto.components.PullRequestPage.6ad2c1ab9c', 'No files changed.')}
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
              onCommentAdded={appendOptimisticComment}
              onViewedChange={handlePRFileViewedChange}
            />
          )}
        </TabsContent>
      </div>
    </Tabs>
  )
}
