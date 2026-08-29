import React, { useCallback } from 'react'
import { toast } from 'sonner'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import {
  buildFixBrokenChecksPrompt,
  getBrokenChecks,
  getCheckDetailsPromptKey
} from '../../pr-checks-fix-prompt'

import { loadGitLabJobLogDetails } from '@/runtime/gitlab-job-trace-client'
import { startFixChecksAgent } from '@/lib/fix-checks-agent-launch'
import { openChecksPanelHostedReviewUrl } from '../checks-panel-hosted-review-click-routing'
import { isMacPlatform } from '../../terminal-pane/terminal-link-open-hints'
import { translate } from '@/i18n/i18n'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../../shared/github/check-types'
import type { GitHubPRStackMapNavigationModifiers } from '../GitHubPRStackMap'
import type { ChecksPanelCheckAndReviewActionsInput } from './check-and-review-action-dependencies'
import { useChecksPanelReviewLinkActions } from './use-checks-panel-review-link-actions'

function hasGitHubCheckHandle(check: PRCheckDetail): boolean {
  return Boolean(check.checkRunId || check.workflowRunId || check.url)
}

export function useChecksPanelCheckAndReviewActions(model: ChecksPanelCheckAndReviewActionsInput) {
  const {
    activeReview,
    activeWorktreeId,
    asyncResultKeyRef,
    branch,
    checks,
    fetchHostedReviewForBranch,
    fetchPRCheckDetails,
    fetchPRChecks,
    fetchPRComments,
    fetchPRForBranch,
    gitLabProjectRefRef,
    isCurrentAsyncResult,
    isFixingChecksWithAI,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    panelContextKey,
    panelContextKeyRef,
    pr,
    prCacheKey,
    repo,
    settings,
    setChecks,
    setChecksLoading,
    setComments,
    setCommentsLoading,
    setIsFixingChecksWithAI,
    sourceControlAiActionsVisible,
    stateRequestKey
  } = model
  const handleFixChecksWithAI = useCallback(async (): Promise<void> => {
    if (
      !sourceControlAiActionsVisible ||
      isFixingChecksWithAI ||
      !activeWorktreeId ||
      !activeReview ||
      !repo
    ) {
      return
    }
    const broken = getBrokenChecks(checks)
    if (broken.length === 0) {
      toast.message(
        translate(
          'auto.components.right.sidebar.ChecksPanel.5594400d73',
          'No broken checks to fix.'
        )
      )
      return
    }
    const requestKey = stateRequestKey
    setIsFixingChecksWithAI(true)
    try {
      const checkRunDetailsByCheckKey: Record<string, PRCheckRunDetails> = {}
      await Promise.all(
        broken.slice(0, 5).map(async (check, index) => {
          const isGitLabJob = Boolean(check.gitlabJobId)
          if (
            !isGitLabJob &&
            (activeReview.provider === 'gitlab' || !hasGitHubCheckHandle(check))
          ) {
            return
          }
          try {
            // Why: GitLab job logs are now loadable, so the fix prompt gets the same
            // failure context the sidebar shows instead of check names alone.
            const details = isGitLabJob
              ? await loadGitLabJobLogDetails({
                  repoPath: repo.path,
                  repoId: repo.id,
                  settings,
                  check,
                  projectRef: gitLabProjectRefRef.current
                })
              : await fetchPRCheckDetails(
                  repo.path,
                  {
                    checkRunId: check.checkRunId,
                    workflowRunId: check.workflowRunId,
                    checkName: check.name,
                    url: check.url,
                    prRepo: pr?.prRepo ?? null
                  },
                  { repoId: repo.id }
                )
            if (details) {
              checkRunDetailsByCheckKey[getCheckDetailsPromptKey(check, index)] = details
            }
          } catch (error) {
            console.warn('[ChecksPanel] failed to load check details for AI fix prompt', error)
          }
        })
      )
      if (!isCurrentAsyncResult(requestKey)) {
        return
      }
      const basePrompt = buildFixBrokenChecksPrompt({
        reviewKind: activeReview.provider === 'gitlab' ? 'MR' : 'PR',
        reviewNumber: activeReview.number,
        reviewTitle: activeReview.title,
        reviewUrl: activeReview.url,
        checks,
        checkRunDetailsByCheckKey
      })
      const started = await startFixChecksAgent({
        repoId: repo.id,
        basePrompt,
        worktreeId: activeWorktreeId,
        groupId: activeWorktreeId,
        launchSource: 'task_page'
      })
      if (started) {
        toast.success(
          translate(
            'auto.components.right.sidebar.ChecksPanel.2ef90c9819',
            'Started an AI agent for the broken checks.'
          )
        )
      }
    } finally {
      setIsFixingChecksWithAI(false)
    }
  }, [
    activeReview,
    activeWorktreeId,
    checks,
    fetchPRCheckDetails,
    isCurrentAsyncResult,
    isFixingChecksWithAI,
    pr?.prRepo,
    repo,
    settings,
    sourceControlAiActionsVisible,
    stateRequestKey,
    setIsFixingChecksWithAI,
    gitLabProjectRefRef
  ])

  const refreshLinkedGitHubPullRequest = useCallback(
    async (linkedPRNumber: number): Promise<void> => {
      if (!repo || !branch) {
        return
      }
      const requestContextKey = panelContextKey
      const isCurrentRequestContext = (): boolean =>
        panelContextKeyRef.current === requestContextKey
      if (!isCurrentRequestContext()) {
        return
      }
      setChecks([])
      setComments([])
      setChecksLoading(true)
      setCommentsLoading(true)
      let requestKey: string | null = null
      try {
        const refreshedPR = await fetchPRForBranch(repo.path, branch, {
          force: true,
          repoId: repo.id,
          worktreeId: activeWorktreeId ?? undefined,
          linkedPRNumber
        })
        if (!isCurrentRequestContext()) {
          return
        }
        await refreshHostedReviewCard(fetchHostedReviewForBranch, {
          repoPath: repo.path,
          repoId: repo.id,
          branch,
          linkedGitHubPR: linkedPRNumber,
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR
        })
        if (!isCurrentRequestContext()) {
          return
        }
        if (!refreshedPR) {
          return
        }
        const refreshedRequestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          refreshedPR.number,
          refreshedPR.prRepo,
          refreshedPR.headSha
        )
        requestKey = refreshedRequestKey
        if (!isCurrentRequestContext()) {
          return
        }
        asyncResultKeyRef.current = refreshedRequestKey
        await Promise.all([
          fetchPRChecks(
            repo.path,
            refreshedPR.number,
            branch,
            refreshedPR.headSha,
            refreshedPR.prRepo,
            {
              force: true,
              repoId: repo.id
            }
          )
            .then(
              (result) => {
                if (isCurrentAsyncResult(refreshedRequestKey)) {
                  setChecks(result)
                }
              },
              (err) => {
                if (!isCurrentAsyncResult(refreshedRequestKey)) {
                  return
                }
                console.warn('Failed to fetch PR checks:', err)
                setChecks([])
              }
            )
            .finally(() => {
              if (isCurrentAsyncResult(refreshedRequestKey)) {
                setChecksLoading(false)
              }
            }),
          fetchPRComments(repo.path, refreshedPR.number, {
            force: true,
            repoId: repo.id,
            prRepo: refreshedPR.prRepo
          })
            .then(
              (result) => {
                if (isCurrentAsyncResult(refreshedRequestKey)) {
                  setComments(result)
                }
              },
              (err) => {
                if (!isCurrentAsyncResult(refreshedRequestKey)) {
                  return
                }
                console.warn('Failed to fetch PR comments:', err)
                setComments([])
              }
            )
            .finally(() => {
              if (isCurrentAsyncResult(refreshedRequestKey)) {
                setCommentsLoading(false)
              }
            })
        ])
      } catch (err) {
        if (
          isCurrentRequestContext() &&
          (requestKey === null || isCurrentAsyncResult(requestKey))
        ) {
          console.warn('Failed to refresh linked GitHub PR:', err)
          setChecks([])
          setComments([])
        }
      } finally {
        if (requestKey === null && isCurrentRequestContext()) {
          setChecksLoading(false)
          setCommentsLoading(false)
        }
        if (requestKey !== null && isCurrentAsyncResult(requestKey)) {
          setChecksLoading(false)
          setCommentsLoading(false)
        }
      }
    },
    [
      activeWorktreeId,
      branch,
      fetchHostedReviewForBranch,
      fetchPRChecks,
      fetchPRComments,
      fetchPRForBranch,
      isCurrentAsyncResult,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
      linkedGitLabMR,
      panelContextKey,
      prCacheKey,
      repo,
      setChecksLoading,
      asyncResultKeyRef,
      setCommentsLoading,
      setChecks,
      panelContextKeyRef,
      setComments
    ]
  )

  // Open hosted review in browser
  const handleOpenPR = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (activeReview?.url) {
        // Why: route through openHttpLink so PR/MR links honor the "open links in app" setting; Shift+Cmd/Ctrl is the escape hatch.
        openChecksPanelHostedReviewUrl({
          url: activeReview.url,
          event: event.nativeEvent,
          isMac: isMacPlatform(),
          worktreeId: activeWorktreeId
        })
      }
    },
    [activeReview, activeWorktreeId]
  )

  const handleOpenStackPR = useCallback(
    (url: string, modifiers: GitHubPRStackMapNavigationModifiers) => {
      openChecksPanelHostedReviewUrl({
        url,
        event: modifiers,
        isMac: isMacPlatform(),
        worktreeId: activeWorktreeId
      })
    },
    [activeWorktreeId]
  )

  const { handleUnlinkReview, handleLinkAnotherReview } = useChecksPanelReviewLinkActions(
    model,
    refreshLinkedGitHubPullRequest
  )
  return {
    handleFixChecksWithAI,
    refreshLinkedGitHubPullRequest,
    handleOpenPR,
    handleOpenStackPR,
    handleUnlinkReview,
    handleLinkAnotherReview
  }
}

export type ChecksPanelCheckAndReviewActionsState = ReturnType<
  typeof useChecksPanelCheckAndReviewActions
>
