import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { useRepoAssignees } from '@/hooks/useIssueMetadata'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { canUseGitHubRepoContext } from '@/lib/github-source-runtime-context'
import { usePRBotAuthorOverrides } from '@/lib/pr-bot-author-overrides'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  type PRCommentAudienceFilter
} from '../../../../../shared/pr-comment-audience'
import { groupPRComments } from '../../../../../shared/pr-comment-groups'
import { resolveCommentReplyTarget } from '@/components/comment-reply-target-state'
import { runWorkItemBodyUpdate } from '@/components/github/github-work-item-edit-mutations'
import {
  parseOwnerRepoFromItemUrl,
  resolvePullRequestRepo
} from '@/components/github/github-work-item-identity'
import {
  resolveGitHubBodyDraft,
  shouldSyncGitHubBodyDraft
} from '@/components/github-body-draft-state'
import { getTaskSourceRuntimeSettings } from '../../../../../shared/task-source-context'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
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
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { PullRequestPageProjectOrigin } from '../page-types'
import { buildMentionOptions } from '../mentions/options'
import { PRActionsPanel } from '../actions/panel'
import { PRAssigneesPanel } from '@/components/github/PRAssigneesPanel'
import { PRReviewersPanel } from '../reviewers/panel'
import { ChecksTab } from '../checks/tab'
import { GHCommentComposer } from '../comments/composer'
import { ConversationDescription } from './description'
import { ConversationCommentsList } from './comments-list'
import { postConversationReply } from './reply'

export function ConversationTab({
  item,
  repoPath,
  repoId,
  sourceContext,
  body,
  comments,
  files,
  headSha,
  baseSha,
  loading,
  detailsLoaded,
  checks,
  participants: detailsParticipants,
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
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  loading: boolean
  detailsLoaded: boolean
  checks: GitHubWorkItemDetails['checks']
  participants: GitHubAssignableUser[]
  localState: GitHubWorkItem['state']
  onStateChange: (state: GitHubWorkItem['state']) => void
  projectOrigin: PullRequestPageProjectOrigin | undefined
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
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null)
  const bodyTextareaFocusFrameRef = useRef<number | null>(null)
  const canUseRepoMutationContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const repoOwnerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, item.repoId ?? repoId ?? null))
  )
  const sourceSettings = useMemo(
    () =>
      sourceContext?.provider === 'github'
        ? ({
            ...repoOwnerSettings,
            ...getTaskSourceRuntimeSettings(sourceContext)
          } as typeof repoOwnerSettings)
        : repoOwnerSettings,
    [repoOwnerSettings, sourceContext]
  )
  const repoAssignees = useRepoAssignees(repoPath, item.repoId, sourceSettings)
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
  const resolvedReplyingTo = resolveCommentReplyTarget(replyingTo, visibleComments)
  const mentionOptions = useMemo(
    () =>
      buildMentionOptions({
        item,
        comments,
        participants: detailsParticipants,
        assignableUsers: repoAssignees.data
      }),
    [comments, detailsParticipants, item, repoAssignees.data]
  )

  const cancelBodyTextareaFocusFrame = useCallback((): void => {
    if (bodyTextareaFocusFrameRef.current !== null) {
      cancelAnimationFrame(bodyTextareaFocusFrameRef.current)
      bodyTextareaFocusFrameRef.current = null
    }
  }, [])

  if (resolvedReplyingTo !== replyingTo) {
    // Why: clear before paint when filters/refetches hide the reply target, so a stale composer doesn't flash for the wrong comment set.
    setReplyingTo(resolvedReplyingTo)
  }

  const resolvedBodyDraft = resolveGitHubBodyDraft(bodyDraft, body, bodyEditing)
  if (shouldSyncGitHubBodyDraft(bodyDraft, body, bodyEditing)) {
    // Why: reconcile before paint so a background body refresh while the editor is closed doesn't show a stale draft on reopen.
    setBodyDraft(resolvedBodyDraft)
  }

  useEffect(() => {
    if (!bodyEditing) {
      cancelBodyTextareaFocusFrame()
      return cancelBodyTextareaFocusFrame
    }
    cancelBodyTextareaFocusFrame()
    bodyTextareaFocusFrameRef.current = requestAnimationFrame(() => {
      bodyTextareaFocusFrameRef.current = null
      bodyTextareaRef.current?.focus()
    })
    return cancelBodyTextareaFocusFrame
  }, [bodyEditing, cancelBodyTextareaFocusFrame])

  const bodySlug = useMemo(() => parseOwnerRepoFromItemUrl(item.url), [item.url])
  const prRepo = useMemo(() => resolvePullRequestRepo(item, projectOrigin), [item, projectOrigin])
  const markdownGitHubRepo = useMemo(
    () =>
      projectOrigin
        ? { owner: projectOrigin.owner, repo: projectOrigin.repo, host: projectOrigin.host }
        : bodySlug,
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
      toast.success(translate('auto.components.PullRequestPage.9b4190dc98', 'Description updated.'))
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.PullRequestPage.d94810f652', 'Failed to update description.')
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
    async (comment: PRComment, replyBody: string): Promise<boolean> =>
      postConversationReply({
        canUseRepoMutationContext,
        item,
        repoPath,
        sourceContext,
        prRepo,
        comment,
        replyBody,
        onCommentAdded,
        onReplied: () => setReplyingTo(null)
      }),
    [canUseRepoMutationContext, item, onCommentAdded, prRepo, repoPath, sourceContext]
  )

  const rightPanel =
    item.type === 'pr' ? (
      <div className="flex h-fit flex-col gap-5 xl:sticky xl:top-4">
        <PRActionsPanel
          item={item}
          repoPath={repoPath}
          repoId={item.repoId}
          sourceContext={sourceContext}
          projectOrigin={projectOrigin}
          localState={localState}
          onStateChange={onStateChange}
          onMutated={onMutated}
        />
        <PRAssigneesPanel
          item={item}
          repoPath={repoPath}
          projectOrigin={projectOrigin}
          sourceContext={sourceContext}
          onMutated={onMutated}
        />
        <PRReviewersPanel
          item={item}
          loading={loading}
          repoPath={repoPath}
          sourceContext={sourceContext}
          projectOrigin={projectOrigin}
          onReviewersRequested={onReviewersRequested}
        />
        <aside className="overflow-hidden rounded-lg border border-border/50 bg-card shadow-xs">
          <ChecksTab
            item={item}
            repoPath={repoPath}
            repoId={item.repoId}
            sourceContext={sourceContext}
            headSha={headSha}
            checks={checks}
            loading={loading || !detailsLoaded}
            onChecksUpdated={onChecksUpdated}
          />
        </aside>
      </div>
    ) : null

  return (
    <div
      className={cn(
        'grid min-w-0 gap-5 px-4 py-4',
        // Why: on narrow windows the drawer is near full-width, so keep PR controls beside the conversation, not below long threads.
        item.type === 'pr' && 'grid-cols-[minmax(0,1fr)_300px]'
      )}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <ConversationDescription
          authorLabel={authorLabel}
          updatedAt={item.updatedAt}
          canEditBody={canEditBody}
          loading={loading}
          detailsLoaded={detailsLoaded}
          bodyEditing={bodyEditing}
          bodySaving={bodySaving}
          bodyChanged={bodyChanged}
          body={body}
          resolvedBodyDraft={resolvedBodyDraft}
          bodyTextareaRef={bodyTextareaRef}
          mentionOptions={mentionOptions}
          markdownGitHubRepo={markdownGitHubRepo}
          onCancelEdit={() => {
            setBodyDraft(body)
            setBodyEditing(false)
          }}
          onStartEdit={() => {
            setBodyDraft(body)
            setBodyEditing(true)
          }}
          onSave={() => {
            void handleSaveBody()
          }}
          onDraftChange={setBodyDraft}
        />

        {detailsLoaded ? (
          <ConversationCommentsList
            itemType={item.type}
            comments={comments}
            visibleComments={visibleComments}
            visibleCommentGroups={visibleCommentGroups}
            commentFilter={commentFilter}
            commentCounts={commentCounts}
            repoPath={repoPath}
            repoId={item.repoId}
            sourceContext={sourceContext}
            prNumber={item.number}
            prRepo={prRepo}
            files={files}
            headSha={headSha}
            baseSha={baseSha}
            markdownGitHubRepo={markdownGitHubRepo}
            mentionOptions={mentionOptions}
            resolvedReplyingTo={resolvedReplyingTo}
            onFilterChange={setCommentFilter}
            onToggleReply={(commentId) =>
              setReplyingTo((current) => (current === commentId ? null : commentId))
            }
            onSubmitReply={handleReply}
          />
        ) : null}

        {detailsLoaded && canUseRepoMutationContext && (
          <GHCommentComposer
            className="mt-1"
            repoPath={repoPath ?? ''}
            repoId={item.repoId}
            sourceContext={sourceContext}
            issueNumber={item.number}
            itemType={item.type}
            prRepo={prRepo}
            mentionOptions={mentionOptions}
            onCommentAdded={onCommentAdded}
          />
        )}
      </div>

      {rightPanel}
    </div>
  )
}
