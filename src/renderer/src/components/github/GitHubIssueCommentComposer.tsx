import React, { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { GitHubMarkdownComposer } from '@/components/github/GitHubMarkdownComposer'
import { CLOSE_ISSUE_REASONS } from '@/components/github/github-issue-close-reasons'
import { CloseReasonDropdown } from '@/components/github/CloseReasonDropdown'
import {
  addIssueCommentForRepo,
  githubAvatarUrl,
  runIssueStateUpdate,
  type GitHubIssueCommentProjectOrigin
} from '@/components/github/github-issue-comment-helpers'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  GitHubIssueCloseReason,
  GitHubOwnerRepo,
  GitHubViewer,
  GitHubWorkItem,
  GlobalSettings,
  PRComment
} from '../../../../shared/types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'

export function GitHubIssueCommentComposer({
  className,
  repoPath,
  repoId,
  issueNumber,
  itemType,
  itemState,
  itemId,
  sourceContext,
  sourceSettings,
  projectOrigin,
  previewGithubRepo,
  onCommentAdded,
  onStateChange,
  onMutated
}: {
  className?: string
  repoPath: string
  repoId?: string | null
  issueNumber: number
  itemType: 'issue' | 'pr'
  itemState?: GitHubWorkItem['state']
  itemId?: string
  sourceContext?: TaskSourceContext | null
  sourceSettings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  projectOrigin?: GitHubIssueCommentProjectOrigin
  previewGithubRepo?: GitHubOwnerRepo | null
  onCommentAdded: (comment: PRComment) => void
  onStateChange?: (state: GitHubWorkItem['state']) => void
  onMutated?: () => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [statePending, setStatePending] = useState(false)
  const [closeReason, setCloseReason] = useState<GitHubIssueCloseReason>('completed')
  const [viewer, setViewer] = useState<GitHubViewer | null>(null)
  const mountedRef = useMountedRef()
  const viewerRequestIdRef = useRef(0)
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const patchProjectRowContent = useAppStore((s) => s.patchProjectRowContent)

  useEffect(() => {
    const requestId = ++viewerRequestIdRef.current
    void window.api.gh
      .viewer()
      .then((nextViewer) => {
        if (mountedRef.current && requestId === viewerRequestIdRef.current) {
          setViewer(nextViewer)
        }
      })
      .catch(() => {
        if (mountedRef.current && requestId === viewerRequestIdRef.current) {
          setViewer(null)
        }
      })
    return () => {
      viewerRequestIdRef.current += 1
    }
  }, [mountedRef])

  const selectedCloseReason =
    CLOSE_ISSUE_REASONS.find((option) => option.reason === closeReason) ?? CLOSE_ISSUE_REASONS[0]

  const canMutateIssueState =
    itemType === 'issue' &&
    itemState !== undefined &&
    itemState !== 'closed' &&
    Boolean(onStateChange) &&
    Boolean(repoPath || projectOrigin)

  const canReopenIssue =
    itemType === 'issue' &&
    itemState === 'closed' &&
    Boolean(onStateChange) &&
    Boolean(repoPath || projectOrigin)

  const patchProjectRowIfNeeded = useCallback(
    (state: GitHubWorkItem['state']) => {
      if (!projectOrigin) {
        return
      }
      patchProjectRowContent(projectOrigin.cacheKey, projectOrigin.projectItemId, { state })
    },
    [patchProjectRowContent, projectOrigin]
  )

  const applyStatePatch = useCallback(
    (state: GitHubWorkItem['state']) => {
      onStateChange?.(state)
      if (itemId) {
        patchWorkItem(itemId, { state }, repoId ?? undefined)
      }
      patchProjectRowIfNeeded(state)
    },
    [itemId, onStateChange, patchProjectRowIfNeeded, patchWorkItem, repoId]
  )

  const handleSubmit = useCallback(async () => {
    const bodyState = getCommentBodySubmitState(body)
    if (bodyState.status === 'empty') {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.github.GitHubIssueCommentComposer.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setSubmitting(true)
    try {
      const result = await addIssueCommentForRepo({
        repoPath,
        repoId: repoId ?? undefined,
        sourceContext,
        number: issueNumber,
        body: bodyState.body,
        type: itemType
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setBody('')
        onCommentAdded(result.comment)
      } else {
        toast.error(
          result.error ??
            translate(
              'auto.components.github.GitHubIssueCommentComposer.082515176a',
              'Failed to add comment'
            )
        )
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.github.GitHubIssueCommentComposer.082515176a',
                'Failed to add comment'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }, [body, issueNumber, itemType, mountedRef, onCommentAdded, repoId, repoPath, sourceContext])

  const handleCloseIssue = useCallback(
    async (reason: GitHubIssueCloseReason = closeReason) => {
      if (!canMutateIssueState || statePending) {
        return
      }
      const previousState = itemState ?? 'open'
      setStatePending(true)
      applyStatePatch('closed')
      try {
        await runIssueStateUpdate({
          repoPath,
          repoId,
          sourceContext,
          sourceSettings,
          projectOrigin,
          number: issueNumber,
          updates: { state: 'closed', stateReason: reason }
        })
        useAppStore.getState().recordFeatureInteraction('github-tasks')
        toast.success(
          translate('auto.components.github.GitHubIssueCommentComposer.9f88657c4e', 'Issue closed')
        )
        onMutated?.()
      } catch (err) {
        applyStatePatch(previousState)
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.github.GitHubIssueCommentComposer.e9b7cb7d17',
                'Failed to close issue'
              )
        )
      } finally {
        if (mountedRef.current) {
          setStatePending(false)
        }
      }
    },
    [
      applyStatePatch,
      canMutateIssueState,
      closeReason,
      issueNumber,
      itemState,
      mountedRef,
      onMutated,
      projectOrigin,
      repoId,
      repoPath,
      sourceContext,
      sourceSettings,
      statePending
    ]
  )

  const handleReopenIssue = useCallback(async () => {
    if (!canReopenIssue || statePending) {
      return
    }
    const previousState = itemState ?? 'closed'
    setStatePending(true)
    applyStatePatch('open')
    try {
      await runIssueStateUpdate({
        repoPath,
        repoId,
        sourceContext,
        sourceSettings,
        projectOrigin,
        number: issueNumber,
        updates: { state: 'open' }
      })
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      toast.success(
        translate('auto.components.github.GitHubIssueCommentComposer.bd3b4492a0', 'Issue reopened')
      )
      onMutated?.()
    } catch (err) {
      applyStatePatch(previousState)
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.github.GitHubIssueCommentComposer.f2a8c1d903',
              'Failed to reopen issue'
            )
      )
    } finally {
      if (mountedRef.current) {
        setStatePending(false)
      }
    }
  }, [
    applyStatePatch,
    canReopenIssue,
    issueNumber,
    itemState,
    mountedRef,
    onMutated,
    projectOrigin,
    repoId,
    repoPath,
    sourceContext,
    sourceSettings,
    statePending
  ])

  const avatar = viewer?.login ? (
    <img
      src={githubAvatarUrl(viewer.login)}
      alt={viewer.login}
      className="size-8 shrink-0 rounded-full border border-border/50 bg-muted"
    />
  ) : (
    <div className="size-8 shrink-0 rounded-full border border-border/50 bg-muted" />
  )
  const canSubmitComment = hasBoundedCommentBodyText(body)

  return (
    <div className={cn('github-issue-comment-composer', className)}>
      <div className="flex items-start gap-3">
        {avatar}
        <div className="min-w-0 flex-1">
          <h3 className="mb-2 text-[13px] font-semibold text-foreground">
            {translate(
              'auto.components.github.GitHubIssueCommentComposer.a1b2c3d4e5',
              'Add a comment'
            )}
          </h3>
          <GitHubMarkdownComposer
            value={body}
            onChange={setBody}
            placeholder={translate(
              'auto.components.github.GitHubIssueCommentComposer.c5c117270e',
              'Add your comment here, be kind'
            )}
            disabled={submitting || statePending}
            minHeightClassName="min-h-28"
            className="w-full"
            layout="tabbed"
            previewGithubRepo={previewGithubRepo}
            onSubmitShortcut={() => void handleSubmit()}
          />
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            {canMutateIssueState ? (
              <ButtonGroup>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="gap-2"
                  disabled={statePending}
                  onClick={() => void handleCloseIssue(closeReason)}
                >
                  {statePending ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    selectedCloseReason.icon
                  )}
                  {translate(
                    'auto.components.github.GitHubIssueCommentComposer.f6a7b8c9d0',
                    'Close issue'
                  )}
                </Button>
                <CloseReasonDropdown
                  closeReason={closeReason}
                  disabled={statePending}
                  onCloseReasonChange={(reason) => {
                    setCloseReason(reason)
                    void handleCloseIssue(reason)
                  }}
                />
              </ButtonGroup>
            ) : null}
            {canReopenIssue ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={statePending}
                onClick={() => void handleReopenIssue()}
              >
                {statePending ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  translate(
                    'auto.components.github.GitHubIssueCommentComposer.b1c2d3e4f5',
                    'Reopen issue'
                  )
                )}
              </Button>
            ) : null}
            <Button
              onClick={() => void handleSubmit()}
              disabled={!canSubmitComment || submitting || statePending}
              size="sm"
              className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/50"
              aria-label={translate(
                'auto.components.github.GitHubIssueCommentComposer.0a73f59e85',
                'Send comment'
              )}
            >
              {submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {translate('auto.components.github.GitHubIssueCommentComposer.bf43425540', 'Comment')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
