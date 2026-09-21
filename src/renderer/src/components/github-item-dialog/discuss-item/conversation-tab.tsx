import React, { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  type PRCommentAudienceFilter
} from '../../../../../shared/pr-comment-audience'
import { usePRBotAuthorOverrides } from '@/lib/pr-bot-author-overrides'
import { groupPRComments } from '../../../../../shared/pr-comment-groups'
import {
  getCommentReplyTargetCandidates,
  resolveCommentReplyTarget
} from '@/components/comment-reply-target-state'
import {
  attachPRReviewReplyParent,
  canPostPRReviewThreadReply
} from '@/components/right-sidebar/pr-comments-ai-launch-ack'
import { buildPRCommentConversationReplyBody } from '@/components/right-sidebar/pr-comment-fixing-reply-body'
import { useAppStore } from '@/store'
import { canUseGitHubRepoContext } from '@/lib/github-source-runtime-context'
import {
  resolveGitHubBodyDraft,
  shouldSyncGitHubBodyDraft
} from '@/components/github-body-draft-state'
import type { GitHubIssueTimelineItem, PRComment } from '../../../../../shared/github/comment-types'
import type {
  GitHubAssignableUser,
  GitHubPRFile
} from '../../../../../shared/github/pull-request-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { translate } from '@/i18n/i18n'
import {
  parseOwnerRepoFromItemUrl,
  resolvePullRequestRepo
} from '@/components/github/github-work-item-identity'
import {
  addIssueCommentForRepo,
  addPRReviewCommentReplyForRepo
} from '@/components/github/github-work-item-comment-mutations'
import { runWorkItemBodyUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'
import {
  EMPTY_GITHUB_ISSUE_TIMELINE_ITEMS,
  getIssueConversationEntries
} from './issue-conversation-entries'
import { GHCommentComposer } from './gh-comment-composer'
import { ConversationTabDescription } from './conversation-tab-description'
import { ConversationTabActivity } from './conversation-tab-activity'
import { ConversationTabPRSidebar } from './conversation-tab-pr-sidebar'

export function ConversationTab({
  item,
  repoPath,
  repoId,
  sourceContext,
  body,
  comments,
  timelineItems,
  files,
  headSha,
  baseSha,
  loading,
  detailsLoaded,
  checks,
  localState,
  onStateChange,
  projectOrigin,
  onMutated,
  onChecksUpdated,
  onBodyUpdated,
  onCommentAdded,
  onReviewersRequested
}: {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  sourceContext?: TaskSourceContext | null
  body: string
  comments: PRComment[]
  timelineItems?: GitHubIssueTimelineItem[]
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  loading: boolean
  detailsLoaded: boolean
  checks: GitHubWorkItemDetails['checks']
  localState: GitHubWorkItem['state']
  onStateChange: (state: GitHubWorkItem['state']) => void
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  onMutated: () => void
  onChecksUpdated: (checks: PRCheckDetail[]) => void
  onBodyUpdated: (body: string) => void
  onCommentAdded: (comment: PRComment) => void
  onReviewersRequested: (reviewRequests: GitHubAssignableUser[]) => void
}): React.JSX.Element {
  const authorLabel = item.author ?? 'unknown'
  const [replyingTo, setReplyingTo] = useState<number | null>(null)
  const [commentFilter, setCommentFilter] = useState<PRCommentAudienceFilter>('all')
  const [bodyDraft, setBodyDraft] = useState(body)
  const [bodyEditing, setBodyEditing] = useState(false)
  const [bodySaving, setBodySaving] = useState(false)
  const canUseRepoMutationContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const botAuthorOverrides = usePRBotAuthorOverrides()
  const commentCounts = useMemo(
    () => getPRCommentAudienceCounts(comments, botAuthorOverrides),
    [botAuthorOverrides, comments]
  )
  const visibleComments = useMemo(
    () => filterPRCommentsByAudience(comments, commentFilter, botAuthorOverrides),
    [botAuthorOverrides, commentFilter, comments]
  )
  const visibleCommentGroups = useMemo(() => groupPRComments(visibleComments), [visibleComments])
  const resolvedTimelineItems = timelineItems ?? EMPTY_GITHUB_ISSUE_TIMELINE_ITEMS
  const issueConversationEntries = useMemo(
    () => getIssueConversationEntries(comments, resolvedTimelineItems),
    [comments, resolvedTimelineItems]
  )
  const replyTargetComments = getCommentReplyTargetCandidates(item.type, comments, visibleComments)
  const resolvedReplyingTo = resolveCommentReplyTarget(replyingTo, replyTargetComments)

  if (resolvedReplyingTo !== replyingTo) {
    // Why: filters/refetches can hide the active reply target; clear before paint so a stale composer doesn't flash for the wrong comment set.
    setReplyingTo(resolvedReplyingTo)
  }

  const resolvedBodyDraft = resolveGitHubBodyDraft(bodyDraft, body, bodyEditing)
  if (shouldSyncGitHubBodyDraft(bodyDraft, body, bodyEditing)) {
    // Why: a background refresh can change the body while the editor is closed; reconcile before paint so reopening never sees a stale draft.
    setBodyDraft(resolvedBodyDraft)
  }

  const bodySlug = useMemo(() => parseOwnerRepoFromItemUrl(item.url), [item.url])
  const prRepo = useMemo(() => resolvePullRequestRepo(item, projectOrigin), [item, projectOrigin])
  const markdownGitHubRepo = useMemo(
    () => (projectOrigin ? { owner: projectOrigin.owner, repo: projectOrigin.repo } : bodySlug),
    [bodySlug, projectOrigin]
  )
  const canEditBody =
    item.type === 'pr'
      ? Boolean(projectOrigin || bodySlug)
      : Boolean(projectOrigin || canUseRepoMutationContext)
  const bodyChanged = resolvedBodyDraft !== body

  const handleSaveBody = useCallback(async (): Promise<void> => {
    if (bodySaving || !bodyChanged) {
      setBodyEditing(false)
      return
    }
    setBodySaving(true)
    try {
      await runWorkItemBodyUpdate({
        item,
        repoPath,
        sourceContext,
        projectOrigin,
        body: resolvedBodyDraft,
        parsedSlug: bodySlug
      })
      onBodyUpdated(resolvedBodyDraft)
      setBodyEditing(false)
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      toast.success(
        translate('auto.components.GitHubItemDialog.5221548274', 'Description updated.')
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.GitHubItemDialog.58c73cb0d8',
              'Failed to update description.'
            )
      )
    } finally {
      setBodySaving(false)
    }
  }, [
    bodyChanged,
    resolvedBodyDraft,
    bodySaving,
    bodySlug,
    item,
    onBodyUpdated,
    projectOrigin,
    repoPath,
    sourceContext
  ])

  const handleReply = useCallback(
    async (comment: PRComment, replyBody: string): Promise<boolean> => {
      if (!canUseRepoMutationContext) {
        toast.error(
          translate(
            'auto.components.GitHubItemDialog.745c9089ec',
            'Unable to reply without a repository path.'
          )
        )
        return false
      }
      // Why: nest under review threads (path/threadId/discussion_r); never post a
      // separate top-level conversation comment for those.
      const isReviewThreadReply = item.type === 'pr' && canPostPRReviewThreadReply(comment)
      const result = isReviewThreadReply
        ? await addPRReviewCommentReplyForRepo({
            repoPath: repoPath ?? '',
            repoId: repoId ?? item.repoId,
            sourceContext,
            prNumber: item.number,
            prRepo,
            commentId: comment.id,
            body: replyBody,
            threadId: comment.threadId,
            path: comment.path,
            line: comment.line
          })
        : await addIssueCommentForRepo({
            repoPath: repoPath ?? '',
            repoId: repoId ?? item.repoId,
            sourceContext,
            number: item.number,
            // Why: a GitHub App login carries a [bot] suffix that never resolves as a mention.
            body: buildPRCommentConversationReplyBody(comment.author, replyBody),
            type: item.type,
            prRepo
          })

      if (!result.ok) {
        toast.error(
          result.error ||
            translate('auto.components.GitHubItemDialog.283699bc82', 'Failed to post reply.')
        )
        return false
      }
      onCommentAdded(
        isReviewThreadReply ? attachPRReviewReplyParent(result.comment, comment) : result.comment
      )
      setReplyingTo(null)
      toast.success(translate('auto.components.GitHubItemDialog.10f4ff5be8', 'Reply posted.'))
      return true
    },
    [
      canUseRepoMutationContext,
      item.number,
      item.repoId,
      item.type,
      onCommentAdded,
      prRepo,
      repoId,
      repoPath,
      sourceContext
    ]
  )

  const commentCardProps = {
    repoPath,
    repoId: repoId ?? item.repoId,
    sourceContext,
    prNumber: item.number,
    prRepo,
    files,
    headSha,
    baseSha,
    markdownGitHubRepo,
    resolvedReplyingTo,
    onToggleReply: (commentId: number) => {
      setReplyingTo((current) => (current === commentId ? null : commentId))
    },
    onReply: handleReply,
    onCancelReply: () => setReplyingTo(null)
  }

  return (
    <div
      className={cn(
        'grid min-w-0 gap-5 px-4 py-4',
        // Why: keep PR controls beside the conversation, not buried below long review threads on narrow windows.
        item.type === 'pr' && 'grid-cols-[minmax(0,1fr)_300px]'
      )}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <ConversationTabDescription
          item={item}
          authorLabel={authorLabel}
          canEditBody={canEditBody}
          loading={loading}
          detailsLoaded={detailsLoaded}
          bodyEditing={bodyEditing}
          bodySaving={bodySaving}
          bodyChanged={bodyChanged}
          body={body}
          resolvedBodyDraft={resolvedBodyDraft}
          markdownGitHubRepo={markdownGitHubRepo}
          setBodyDraft={setBodyDraft}
          setBodyEditing={setBodyEditing}
          onSaveBody={() => {
            void handleSaveBody()
          }}
        />

        {detailsLoaded ? (
          <ConversationTabActivity
            item={item}
            comments={comments}
            commentFilter={commentFilter}
            commentCounts={commentCounts}
            visibleComments={visibleComments}
            visibleCommentGroups={visibleCommentGroups}
            resolvedTimelineItemsLength={resolvedTimelineItems.length}
            issueConversationEntries={issueConversationEntries}
            commentCardProps={commentCardProps}
            onCommentFilterChange={setCommentFilter}
          />
        ) : null}

        {detailsLoaded && canUseRepoMutationContext && (
          <GHCommentComposer
            className="mt-1"
            repoPath={repoPath ?? ''}
            repoId={repoId ?? item.repoId}
            sourceContext={sourceContext}
            issueNumber={item.number}
            itemType={item.type}
            prRepo={prRepo}
            onCommentAdded={onCommentAdded}
          />
        )}
      </div>

      {item.type === 'pr' ? (
        <ConversationTabPRSidebar
          item={item}
          repoPath={repoPath}
          sourceContext={sourceContext}
          projectOrigin={projectOrigin}
          localState={localState}
          onStateChange={onStateChange}
          onMutated={onMutated}
          loading={loading}
          detailsLoaded={detailsLoaded}
          headSha={headSha}
          checks={checks}
          onChecksUpdated={onChecksUpdated}
          onReviewersRequested={onReviewersRequested}
        />
      ) : null}
    </div>
  )
}
