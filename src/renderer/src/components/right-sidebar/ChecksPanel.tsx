/* eslint-disable max-lines -- Why: the checks panel co-locates PR header, checks, comments,
merge actions, and conflict state in one component to keep the data flow straightforward. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  LoaderCircle,
  RefreshCw,
  Check,
  X,
  Pencil,
  GitMerge,
  Ellipsis,
  Link,
  Unlink
} from 'lucide-react'
import { useAppStore } from '@/store'
import {
  mergePRCommentIntoList,
  prChecksCacheSuffix,
  prCommentsCacheSuffix
} from '@/store/slices/github'
import { getGitHubPRCacheKey, getGitHubRepoCacheKey } from '@/store/slices/github-cache-key'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { isFolderRepo } from '../../../../shared/repo-kind'
import HostedReviewActions from './HostedReviewActions'
import {
  PullRequestIcon,
  prStateColor,
  ConflictingFilesSection,
  MergeConflictNotice,
  ChecksList,
  PRCommentsList,
  PRTriageStrip
} from './checks-panel-content'
import { ENTRY_REFRESH_GRACE_MS, shouldEntryRefresh } from './checks-entry-refresh'
import type {
  GitLabDiscussionResolveResult,
  GitLabWorkItemDetails,
  PRInfo,
  PRCheckDetail,
  PRCheckRunDetails,
  PRComment
} from '../../../../shared/types'
import { getConnectionId } from '@/lib/connection-context'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  buildResolvePullRequestConflictsPrompt,
  pickDefaultSourceControlAgent
} from './SourceControl'
import {
  buildFixBrokenChecksPrompt,
  getBrokenChecks,
  getCheckDetailsPromptKey
} from '../pr-checks-fix-prompt'
import { CreatePullRequestDialog } from './CreatePullRequestDialog'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import { getHostedReviewCacheKey, refreshHostedReviewCard } from '@/store/slices/hosted-review'
import { toast } from 'sonner'
import {
  classifyHostedReview,
  type HostedReviewClassificationOptions
} from '../../../../shared/hosted-review-queue'
import { hostedReviewSummaryFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import { hostedReviewSummaryFromGitLabInfo } from '../../../../shared/hosted-review-gitlab'
import {
  checksPanelAsyncResultKey,
  checksPanelHostedReviewAsyncResultKey,
  shouldCommitChecksPanelAsyncResult
} from './checks-panel-async-result-key'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-visibility-timeout-poller'
import {
  getChecksPanelEmptyStateCopy,
  shouldShowChecksPanelPublishBranchAction
} from './checks-panel-empty-state'
import { getRuntimeGitStatus, getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-client'
import {
  buildChecksPanelGitStatusContextKey,
  readChecksPanelPublishActionGitStatus,
  readChecksPanelGitStatusSnapshot,
  shouldClearChecksPanelGitStatusSnapshot,
  shouldCoalesceChecksPanelGitStatusSnapshotRefresh,
  shouldCommitChecksPanelGitStatusSnapshot,
  shouldPollChecksPanelRuntimeSshStatus,
  type ChecksPanelGitStatusSnapshot
} from './checks-panel-git-status-snapshot'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useMountedRef } from '@/hooks/useMountedRef'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { gitLabPipelineJobsToPRChecks } from '../../../../shared/gitlab-pipeline-checks'

const RUNTIME_SSH_STATUS_REFRESH_MS = 3000
const GIT_STATUS_FAILURE_RETRY_MS = 3000

type HostedReviewCreationSnapshot = {
  requestKey: string
  repoId: string
  worktreeId: string | null
  branch: string
  data: HostedReviewCreationEligibility
}

type ChecksPanelReview = Pick<
  HostedReviewInfo,
  'provider' | 'number' | 'title' | 'state' | 'url' | 'status' | 'updatedAt' | 'mergeable'
> &
  Partial<Pick<HostedReviewInfo, 'headSha' | 'conflictSummary'>>

type ChecksPanelReviewHeaderProps = {
  review: ChecksPanelReview
  isRefreshing: boolean
  canUnlinkPullRequest: boolean
  onRefresh: () => void
  onOpenReview: () => void
  onUnlinkPullRequest: () => void
  onLinkAnotherPullRequest: () => void
}

export function ChecksPanelReviewHeader({
  review,
  isRefreshing,
  canUnlinkPullRequest,
  onRefresh,
  onOpenReview,
  onUnlinkPullRequest,
  onLinkAnotherPullRequest
}: ChecksPanelReviewHeaderProps): React.JSX.Element {
  const reviewNumberLabel = review.provider === 'gitlab' ? `!${review.number}` : `#${review.number}`
  const ReviewIcon = review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  const reviewHostLabel = review.provider === 'gitlab' ? 'GitLab' : 'GitHub'
  const showPullRequestMenu = review.provider === 'github'

  return (
    <div className="flex items-center gap-2">
      <ReviewIcon className="size-4 text-muted-foreground shrink-0" />
      <button
        type="button"
        className="rounded px-0.5 text-[12px] font-semibold text-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={`Open on ${reviewHostLabel}`}
        onClick={onOpenReview}
      >
        {reviewNumberLabel}
      </button>
      <span
        className={cn(
          'text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border',
          prStateColor(review.state)
        )}
      >
        {review.state}
      </span>
      <div className="flex-1" />
      <button
        className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
        title="Refresh"
        onClick={onRefresh}
        disabled={isRefreshing}
      >
        <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
      </button>
      {showPullRequestMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="More PR actions"
              title="More PR actions"
              className="text-muted-foreground hover:text-foreground"
            >
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem disabled={!canUnlinkPullRequest} onSelect={onUnlinkPullRequest}>
              <Unlink className="size-3.5" />
              unlink PR
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onLinkAnotherPullRequest}>
              <Link className="size-3.5" />
              Link another PR
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

function gitHubPRToChecksPanelReview(pr: PRInfo): ChecksPanelReview {
  return {
    provider: 'github',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.checksStatus,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {}),
    ...(pr.conflictSummary ? { conflictSummary: pr.conflictSummary } : {})
  }
}

function isGitLabChecksPanelReview(
  review: ChecksPanelReview | null
): review is ChecksPanelReview & { provider: 'gitlab' } {
  return review?.provider === 'gitlab'
}

function gitLabMRCommentsToPRComments(
  comments: GitLabWorkItemDetails['comments'] | undefined
): PRComment[] {
  return (comments ?? []).map((comment) => {
    const { reactions: _reactions, ...compatibleComment } = comment
    // Why: the shared comments renderer expects GitHub reaction content enums;
    // GitLab emoji award names are open-ended, so omit them in this view.
    return compatibleComment
  })
}

async function fetchGitLabMRDetailsForChecks(args: {
  repoPath: string
  repoId?: string
  settings: Parameters<typeof getActiveRuntimeTarget>[0]
  iid: number
}): Promise<GitLabWorkItemDetails | null> {
  const target = getActiveRuntimeTarget(args.settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<GitLabWorkItemDetails | null>(
      target,
      'gitlab.workItemDetails',
      {
        repo: args.repoId ?? args.repoPath,
        iid: args.iid,
        type: 'mr'
      },
      { timeoutMs: 30_000 }
    )
  }
  return (await window.api.gl.workItemDetails({
    repoPath: args.repoPath,
    iid: args.iid,
    type: 'mr'
  })) as GitLabWorkItemDetails | null
}

async function resolveGitLabMRDiscussionForChecks(args: {
  repoPath: string
  repoId?: string
  settings: Parameters<typeof getActiveRuntimeTarget>[0]
  iid: number
  discussionId: string
  resolved: boolean
}): Promise<GitLabDiscussionResolveResult> {
  const target = getActiveRuntimeTarget(args.settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<GitLabDiscussionResolveResult>(
      target,
      'gitlab.resolveMRDiscussion',
      {
        repo: args.repoId ?? args.repoPath,
        iid: args.iid,
        discussionId: args.discussionId,
        resolved: args.resolved
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gl.resolveMRDiscussion({
    repoPath: args.repoPath,
    iid: args.iid,
    discussionId: args.discussionId,
    resolved: args.resolved
  })
}

export default function ChecksPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const settings = useAppStore((s) => s.settings)
  const prCache = useAppStore((s) => s.prCache)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const getHostedReviewCreationEligibility = useAppStore(
    (s) => s.getHostedReviewCreationEligibility
  )
  const enqueueGitHubPRRefresh = useAppStore((s) => s.enqueueGitHubPRRefresh)
  const conflictOperation = useAppStore((s) =>
    activeWorktreeId ? (s.gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown') : 'unknown'
  )
  const gitStatusInvalidation = useAppStore((s) =>
    activeWorktreeId ? s.gitStatusByWorktree[activeWorktreeId] : undefined
  )
  const remoteStatusInvalidation = useAppStore((s) =>
    activeWorktreeId ? s.remoteStatusesByWorktree[activeWorktreeId] : undefined
  )
  const isRemoteOperationActive = useAppStore((s) => s.isRemoteOperationActive)
  const pushBranch = useAppStore((s) => s.pushBranch)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const openModal = useAppStore((s) => s.openModal)

  // Why: the sidebar stays mounted when closed (for performance). Gate
  // polling on visibility so we don't fetch checks/comments in the background
  // when the panel isn't visible to the user.
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const isPanelVisible = rightSidebarOpen && rightSidebarTab === 'checks'

  const fetchPRChecks = useAppStore((s) => s.fetchPRChecks)
  const fetchPRCheckDetails = useAppStore((s) => s.fetchPRCheckDetails)
  const fetchPRComments = useAppStore((s) => s.fetchPRComments)
  const addPRConversationComment = useAppStore((s) => s.addPRConversationComment)
  const addPRReviewCommentReply = useAppStore((s) => s.addPRReviewCommentReply)
  const resolveReviewThread = useAppStore((s) => s.resolveReviewThread)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const remoteDetectedAgentIds = useAppStore((s) => {
    const connectionId = activeWorktreeId ? getConnectionId(activeWorktreeId) : undefined
    return typeof connectionId === 'string'
      ? (s.remoteDetectedAgentIds[connectionId] ?? null)
      : null
  })

  const [checks, setChecks] = useState<PRCheckDetail[]>([])
  const [checksLoading, setChecksLoading] = useState(false)
  const [comments, setComments] = useState<PRComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [gitLabDetailsFetchedAt, setGitLabDetailsFetchedAt] = useState<number | null>(null)
  const [emptyRefreshing, setEmptyRefreshing] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [conflictDetailsRefreshing, setConflictDetailsRefreshing] = useState(false)
  const [createPrDialogOpen, setCreatePrDialogOpen] = useState(false)
  const [createPrPushFirst, setCreatePrPushFirst] = useState(false)
  const [isPublishingBranch, setIsPublishingBranch] = useState(false)
  const [isResolvingConflictsWithAI, setIsResolvingConflictsWithAI] = useState(false)
  const [isFixingChecksWithAI, setIsFixingChecksWithAI] = useState(false)
  const [hostedReviewCreationSnapshot, setHostedReviewCreationSnapshot] =
    useState<HostedReviewCreationSnapshot | null>(null)
  const [gitStatusSnapshot, setGitStatusSnapshot] = useState<ChecksPanelGitStatusSnapshot | null>(
    null
  )
  const [gitStatusRefreshNonce, setGitStatusRefreshNonce] = useState(0)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleInputFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollIntervalRef = useRef(30_000) // start at 30s, backs off to 120s
  const mountedRef = useMountedRef()
  const prevChecksRef = useRef<string>('')
  const conflictSummaryRefreshKeyRef = useRef<string | null>(null)
  const asyncResultKeyRef = useRef<string>('')
  const refreshRequestKeyRef = useRef<string | null>(null)
  const refreshContextKeyRef = useRef<string | null>(null)
  const gitStatusSnapshotInFlightContextRef = useRef<string | null>(null)
  const gitStatusSnapshotRerunContextRef = useRef<string | null>(null)
  const gitStatusSnapshotRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const branch = activeWorktree ? activeWorktree.branch.replace(/^refs\/heads\//, '') : ''
  const activeWorktreePath = activeWorktree?.path ?? null
  const activeWorktreePushTarget = activeWorktree?.pushTarget ?? null
  const runtimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim() || null
  const repoConnectionId = repo?.connectionId?.trim() || null
  const sshConnectionStatus = useAppStore((s) =>
    repoConnectionId ? s.sshConnectionStates.get(repoConnectionId)?.status : undefined
  )
  const panelContextKey = buildChecksPanelGitStatusContextKey({
    repoId: repo?.id,
    worktreeId: activeWorktreeId,
    worktreePath: activeWorktreePath,
    branch,
    runtimeEnvironmentId,
    repoConnectionId,
    pushTarget: activeWorktreePushTarget
  })
  const panelContextKeyRef = useRef(panelContextKey)
  panelContextKeyRef.current = panelContextKey

  const clearTitleInputFocusTimer = useCallback((): void => {
    if (titleInputFocusTimerRef.current !== null) {
      clearTimeout(titleInputFocusTimerRef.current)
      titleInputFocusTimerRef.current = null
    }
  }, [])

  const setChecksPanelContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        clearTitleInputFocusTimer()
      }
    },
    [clearTitleInputFocusTimer]
  )

  // Why: the sidebar no longer uses key={activeWorktreeId} to force a full
  // remount on worktree switch (that caused an IPC storm on Windows). Reset
  // branch-specific local state so stale UI from the previous context doesn't
  // leak (e.g. mid-edit title, stale loading indicators, PR dialog fields).
  // Done during render (not useEffect) so the reset takes effect on the same
  // paint as the context change; useEffect would leave one stale render.
  const [prevPanelContextKey, setPrevPanelContextKey] = useState(panelContextKey)
  if (panelContextKey !== prevPanelContextKey) {
    setPrevPanelContextKey(panelContextKey)
    setEditingTitle(false)
    setTitleDraft('')
    setTitleSaving(false)
    clearTitleInputFocusTimer()
    setChecks([])
    setChecksLoading(false)
    setComments([])
    setCommentsLoading(false)
    setGitLabDetailsFetchedAt(null)
    setIsRefreshing(false)
    setEmptyRefreshing(false)
    setConflictDetailsRefreshing(false)
    setCreatePrDialogOpen(false)
    setCreatePrPushFirst(false)
    setIsPublishingBranch(false)
    setIsResolvingConflictsWithAI(false)
    setIsFixingChecksWithAI(false)
    setHostedReviewCreationSnapshot(null)
    setGitStatusSnapshot(null)
    setGitStatusRefreshNonce((value) => value + 1)
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    conflictSummaryRefreshKeyRef.current = null
    refreshRequestKeyRef.current = null
    if (gitStatusSnapshotRetryTimerRef.current) {
      clearTimeout(gitStatusSnapshotRetryTimerRef.current)
      gitStatusSnapshotRetryTimerRef.current = null
    }
  }

  // Find active worktree and repo
  const isFolder = repo ? isFolderRepo(repo) : false
  const prCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(repo.path, repo.id, branch, settings, repo.connectionId)
      : ''
  const hostedReviewCacheKey =
    repo && branch
      ? getHostedReviewCacheKey(repo.path, branch, settings, repo.id, repo.connectionId)
      : ''
  const refreshContextKey = `${activeWorktreeId ?? ''}::${prCacheKey}::${branch}`
  if (refreshContextKey !== refreshContextKeyRef.current) {
    refreshContextKeyRef.current = refreshContextKey
    refreshRequestKeyRef.current = null
  }
  const pr: PRInfo | null = prCacheKey ? (prCache[prCacheKey]?.data ?? null) : null
  const hostedReview = useAppStore((s) =>
    hostedReviewCacheKey ? (s.hostedReviewCache[hostedReviewCacheKey]?.data ?? null) : null
  )
  // Fetch PR data when the active worktree/branch changes.
  // Why: branch lookup is lossy for fork/deleted-head PRs; reuse a known PR
  // number from metadata or the visible cache whenever we have one.
  const linkedPR = activeWorktree?.linkedPR ?? null
  const fallbackGitHubPRNumber = linkedPR == null ? (pr?.number ?? null) : null
  const linkedGitLabMR = activeWorktree?.linkedGitLabMR ?? null
  const gitLabHostedReview = hostedReview?.provider === 'gitlab' ? hostedReview : null
  const activeReview: ChecksPanelReview | null =
    gitLabHostedReview ??
    (linkedGitLabMR !== null ? null : pr ? gitHubPRToChecksPanelReview(pr) : null)
  const activeGitLabReview = isGitLabChecksPanelReview(activeReview) ? activeReview : null
  const isGitLabReviewContext = Boolean(activeGitLabReview || linkedGitLabMR !== null)
  const activeConflictReview = activeReview?.mergeable === 'CONFLICTING' ? activeReview : null
  const prRefreshState = useAppStore((s) =>
    prCacheKey ? s.prRefreshStates[prCacheKey] : undefined
  )
  const prNumber = pr?.number ?? null

  // Why: select only timestamps (not whole cache records) so the entry-refresh
  // effect doesn't re-run on every cache mutation. See
  // docs/refresh-on-checks-tab.md.
  const prFetchedAt = useAppStore((s) =>
    prCacheKey ? s.prCache[prCacheKey]?.fetchedAt : undefined
  )
  const checksCacheKey =
    repo && prNumber
      ? getGitHubRepoCacheKey(
          repo.path,
          repo.id,
          prChecksCacheSuffix(prNumber, pr?.prRepo),
          settings,
          repo.connectionId
        )
      : ''
  const commentsCacheKey =
    repo && prNumber
      ? getGitHubRepoCacheKey(
          repo.path,
          repo.id,
          prCommentsCacheSuffix(prNumber, pr?.prRepo),
          settings,
          repo.connectionId
        )
      : ''
  const checksFetchedAt = useAppStore((s) =>
    checksCacheKey ? s.checksCache[checksCacheKey]?.fetchedAt : undefined
  )
  const commentsFetchedAt = useAppStore((s) =>
    commentsCacheKey ? s.commentsCache[commentsCacheKey]?.fetchedAt : undefined
  )

  const hostedReviewCreationRequestKey =
    repo && branch
      ? JSON.stringify({
          repoId: repo.id,
          repoPath: repo.path,
          worktreeId: activeWorktreeId ?? null,
          worktreePath: activeWorktreePath,
          runtimeEnvironmentId,
          connectionId: repoConnectionId,
          branch,
          base: repo.worktreeBaseRef ?? null,
          hasUncommittedChanges:
            gitStatusSnapshot?.contextKey === panelContextKey
              ? gitStatusSnapshot.hasUncommittedChanges
              : null,
          hasUpstream:
            gitStatusSnapshot?.contextKey === panelContextKey
              ? (gitStatusSnapshot.remoteStatus?.hasUpstream ?? null)
              : null,
          ahead:
            gitStatusSnapshot?.contextKey === panelContextKey
              ? (gitStatusSnapshot.remoteStatus?.ahead ?? null)
              : null,
          behind:
            gitStatusSnapshot?.contextKey === panelContextKey
              ? (gitStatusSnapshot.remoteStatus?.behind ?? null)
              : null,
          linkedGitHubPR: linkedPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR
        })
      : ''
  const gitStatusInputs = readChecksPanelGitStatusSnapshot(gitStatusSnapshot, panelContextKey)
  const gitStatusReadyForPanelContext = gitStatusInputs.hasUncommittedChanges !== undefined
  const hasUncommittedChanges = gitStatusInputs.hasUncommittedChanges
  const remoteStatus = gitStatusInputs.remoteStatus
  // Why: Create PR eligibility waits for the stricter panel snapshot, but the
  // Publish affordance can use the active worktree poller when SSH snapshot
  // refresh is delayed; publishing is still blocked for dirty fallback status.
  const publishActionGitStatusInputs = readChecksPanelPublishActionGitStatus({
    snapshot: gitStatusSnapshot,
    contextKey: panelContextKey,
    fallbackEntries: gitStatusInvalidation,
    fallbackRemoteStatus: remoteStatusInvalidation
  })
  const publishActionHasUncommittedChanges =
    publishActionGitStatusInputs.hasUncommittedChanges ?? true
  const publishActionRemoteStatus = publishActionGitStatusInputs.remoteStatus
  const hostedReviewCreation =
    hostedReviewCreationSnapshot?.requestKey === hostedReviewCreationRequestKey
      ? hostedReviewCreationSnapshot.data
      : null
  const stateRequestKey =
    repo && branch
      ? activeGitLabReview
        ? checksPanelHostedReviewAsyncResultKey(
            hostedReviewCacheKey,
            branch,
            activeGitLabReview.provider,
            activeGitLabReview.number,
            activeGitLabReview.headSha
          )
        : checksPanelAsyncResultKey(prCacheKey, branch, prNumber, pr?.prRepo, pr?.headSha)
      : ''
  asyncResultKeyRef.current = stateRequestKey

  const isCurrentAsyncResult = useCallback(
    (requestKey: string) =>
      shouldCommitChecksPanelAsyncResult(asyncResultKeyRef.current, requestKey),
    []
  )
  useEffect(() => {
    if (isPanelVisible && repo && !isFolder && branch) {
      void fetchHostedReviewForBranch(repo.path, branch, {
        repoId: repo.id,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        linkedGitLabMR,
        staleWhileRevalidate: true
      })
      if (activeWorktreeId && !isGitLabReviewContext) {
        enqueueGitHubPRRefresh(activeWorktreeId, 'swr', 30)
      }
    }
  }, [
    activeWorktreeId,
    branch,
    enqueueGitHubPRRefresh,
    fallbackGitHubPRNumber,
    fetchHostedReviewForBranch,
    isFolder,
    isGitLabReviewContext,
    isPanelVisible,
    linkedGitLabMR,
    linkedPR,
    repo
  ])

  useEffect(() => {
    if (
      !shouldPollChecksPanelRuntimeSshStatus({
        isPanelVisible,
        runtimeEnvironmentId,
        repoConnectionId
      })
    ) {
      return undefined
    }
    let skippedInitialRun = false
    return installWindowVisibilityInterval({
      run: () => {
        if (!skippedInitialRun) {
          skippedInitialRun = true
          return
        }
        const currentContextKey = panelContextKeyRef.current
        if (
          shouldCoalesceChecksPanelGitStatusSnapshotRefresh(
            gitStatusSnapshotInFlightContextRef.current,
            currentContextKey
          )
        ) {
          gitStatusSnapshotRerunContextRef.current = currentContextKey
          return
        }
        setGitStatusRefreshNonce((value) => value + 1)
      },
      intervalMs: RUNTIME_SSH_STATUS_REFRESH_MS
    })
  }, [isPanelVisible, repoConnectionId, runtimeEnvironmentId])

  useEffect(() => {
    if (
      !repo ||
      isFolder ||
      !branch ||
      !isPanelVisible ||
      !activeWorktreeId ||
      !activeWorktreePath ||
      (!runtimeEnvironmentId && repoConnectionId && sshConnectionStatus !== 'connected')
    ) {
      if (gitStatusSnapshotRetryTimerRef.current) {
        clearTimeout(gitStatusSnapshotRetryTimerRef.current)
        gitStatusSnapshotRetryTimerRef.current = null
      }
      // Why: hiding the panel or temporarily losing SSH should stop new work,
      // not erase same-context Create PR eligibility that can still be retried.
      return
    }
    let stale = false
    const requestContextKey = panelContextKey
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    if (
      shouldCoalesceChecksPanelGitStatusSnapshotRefresh(
        gitStatusSnapshotInFlightContextRef.current,
        requestContextKey
      )
    ) {
      gitStatusSnapshotRerunContextRef.current = requestContextKey
      return () => {
        stale = true
      }
    }
    gitStatusSnapshotInFlightContextRef.current = requestContextKey
    // Why: global status maps are keyed only by worktree. Use their changes as
    // invalidation signals, then fetch a local snapshot for the active boundary.
    if (gitStatusSnapshotRetryTimerRef.current) {
      clearTimeout(gitStatusSnapshotRetryTimerRef.current)
      gitStatusSnapshotRetryTimerRef.current = null
    }
    setGitStatusSnapshot((snapshot) =>
      shouldClearChecksPanelGitStatusSnapshot(snapshot, requestContextKey) ? null : snapshot
    )
    const context = {
      settings: useAppStore.getState().settings,
      worktreeId: activeWorktreeId,
      worktreePath: activeWorktreePath,
      connectionId
    }
    void (async () => {
      const status = await getRuntimeGitStatus(context)
      let freshRemoteStatus = status.upstreamStatus
      if (activeWorktreePushTarget) {
        freshRemoteStatus = await getRuntimeGitUpstreamStatus(context, activeWorktreePushTarget)
      } else if (
        !freshRemoteStatus ||
        (freshRemoteStatus.ahead > 0 &&
          freshRemoteStatus.behind > 0 &&
          freshRemoteStatus.behindCommitsArePatchEquivalent === undefined)
      ) {
        freshRemoteStatus = await getRuntimeGitUpstreamStatus(context)
      }
      return { status, remoteStatus: freshRemoteStatus }
    })()
      .then(({ status, remoteStatus }) => {
        if (
          !stale &&
          shouldCommitChecksPanelGitStatusSnapshot(panelContextKeyRef.current, requestContextKey)
        ) {
          setGitStatusSnapshot({
            contextKey: requestContextKey,
            hasUncommittedChanges: status.entries.length > 0,
            remoteStatus
          })
        }
      })
      .catch((error) => {
        console.warn('[ChecksPanel] git status refresh before eligibility failed', error)
        if (!stale) {
          // Why: transient SSH/runtime flakes should not hide an already-valid
          // Create PR state for this same branch; retry while the panel stays visible.
          setGitStatusSnapshot((snapshot) =>
            shouldClearChecksPanelGitStatusSnapshot(snapshot, requestContextKey) ? null : snapshot
          )
          gitStatusSnapshotRetryTimerRef.current = setTimeout(() => {
            gitStatusSnapshotRetryTimerRef.current = null
            if (
              shouldCommitChecksPanelGitStatusSnapshot(
                panelContextKeyRef.current,
                requestContextKey
              )
            ) {
              setGitStatusRefreshNonce((value) => value + 1)
            }
          }, GIT_STATUS_FAILURE_RETRY_MS)
        }
      })
      .finally(() => {
        if (gitStatusSnapshotInFlightContextRef.current === requestContextKey) {
          gitStatusSnapshotInFlightContextRef.current = null
        }
        if (gitStatusSnapshotRerunContextRef.current === requestContextKey) {
          gitStatusSnapshotRerunContextRef.current = null
          if (
            shouldCommitChecksPanelGitStatusSnapshot(panelContextKeyRef.current, requestContextKey)
          ) {
            setGitStatusRefreshNonce((value) => value + 1)
          }
        }
      })
    return () => {
      stale = true
      if (gitStatusSnapshotRetryTimerRef.current) {
        clearTimeout(gitStatusSnapshotRetryTimerRef.current)
        gitStatusSnapshotRetryTimerRef.current = null
      }
    }
  }, [
    activeWorktreePushTarget,
    activeWorktreeId,
    activeWorktreePath,
    branch,
    gitStatusInvalidation,
    gitStatusRefreshNonce,
    isFolder,
    isPanelVisible,
    panelContextKey,
    repo,
    repoConnectionId,
    remoteStatusInvalidation,
    runtimeEnvironmentId,
    sshConnectionStatus
  ])

  useEffect(() => {
    if (!repo || isFolder || !branch) {
      setHostedReviewCreationSnapshot(null)
      return
    }
    if (!isPanelVisible || !gitStatusReadyForPanelContext) {
      return
    }
    let stale = false
    void getHostedReviewCreationEligibility({
      repoPath: repo.path,
      ...(activeWorktreePath ? { worktreePath: activeWorktreePath } : {}),
      branch,
      base: repo.worktreeBaseRef ?? null,
      hasUncommittedChanges,
      hasUpstream: remoteStatus?.hasUpstream,
      ahead: remoteStatus?.ahead,
      behind: remoteStatus?.behind,
      linkedGitHubPR: linkedPR,
      fallbackGitHubPR: fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
      .then((result) => {
        if (!stale) {
          setHostedReviewCreationSnapshot({
            requestKey: hostedReviewCreationRequestKey,
            repoId: repo.id,
            worktreeId: activeWorktreeId,
            branch,
            data: result
          })
        }
      })
      .catch(() => {
        if (!stale) {
          setHostedReviewCreationSnapshot(null)
        }
      })
    return () => {
      stale = true
    }
  }, [
    activeWorktreeId,
    activeWorktreePath,
    branch,
    getHostedReviewCreationEligibility,
    gitStatusReadyForPanelContext,
    hasUncommittedChanges,
    hostedReviewCreationRequestKey,
    isFolder,
    isPanelVisible,
    linkedPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    remoteStatus?.ahead,
    remoteStatus?.behind,
    remoteStatus?.hasUpstream,
    repo
  ])

  useEffect(() => {
    if (
      !repo ||
      isFolder ||
      !branch ||
      !pr ||
      pr.mergeable !== 'CONFLICTING' ||
      !activeWorktreeId
    ) {
      conflictSummaryRefreshKeyRef.current = null
      setConflictDetailsRefreshing(false)
      return
    }

    const refreshKey = `${prCacheKey}::${branch}::${pr.number}`
    if (conflictSummaryRefreshKeyRef.current === refreshKey) {
      return
    }

    // Why: the checks panel is the one place where stale conflict metadata is
    // visibly wrong. Force-refresh conflicting PRs once when the panel sees
    // them so we don't keep rendering cached branch summaries or empty file
    // lists from an older payload.
    conflictSummaryRefreshKeyRef.current = refreshKey
    setConflictDetailsRefreshing(true)
    void fetchPRForBranch(repo.path, branch, {
      force: true,
      repoId: repo.id,
      linkedPRNumber: linkedPR,
      fallbackPRNumber: fallbackGitHubPRNumber ?? pr.number
    }).finally(() => {
      // Why: fetchPRForBranch updates the PR cache before resolving, which
      // can rerun this effect. Only the current refresh key may clear the
      // spinner so stale requests don't race newer worktrees/branches.
      if (conflictSummaryRefreshKeyRef.current === refreshKey) {
        setConflictDetailsRefreshing(false)
      }
    })
  }, [
    repo,
    isFolder,
    branch,
    pr,
    prCacheKey,
    activeWorktreeId,
    linkedPR,
    fallbackGitHubPRNumber,
    fetchPRForBranch
  ])

  // Fetch checks via cached store method
  const fetchChecks = useCallback(
    async ({
      force = false,
      prNumberOverride
    }: { force?: boolean; prNumberOverride?: number | null } = {}) => {
      const targetPRNumber = prNumberOverride ?? prNumber
      if (!repo || !targetPRNumber) {
        return
      }
      setChecksLoading(true)
      try {
        const requestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          targetPRNumber,
          pr?.prRepo,
          pr?.headSha
        )
        const result = await fetchPRChecks(
          repo.path,
          targetPRNumber,
          branch,
          pr?.headSha,
          pr?.prRepo,
          {
            force,
            repoId: repo.id
          }
        )
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        setChecks(result)

        // Exponential backoff: if checks haven't changed, double the interval (cap 120s).
        // If they changed, reset to 30s.
        const signature = JSON.stringify(result.map((c) => `${c.name}:${c.status}:${c.conclusion}`))
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 30_000
        prevChecksRef.current = signature
      } catch (err) {
        if (
          !isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, pr?.prRepo, pr?.headSha)
          )
        ) {
          return
        }
        console.warn('Failed to fetch PR checks:', err)
        setChecks([])
      } finally {
        if (
          isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, pr?.prRepo, pr?.headSha)
          )
        ) {
          setChecksLoading(false)
        }
      }
    },
    [
      repo,
      prNumber,
      branch,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      fetchPRChecks,
      isCurrentAsyncResult
    ]
  )

  const fetchGitLabDetails = useCallback(
    async ({
      mrNumberOverride,
      headShaOverride,
      commitAsCurrent = false
    }: {
      mrNumberOverride?: number | null
      headShaOverride?: string | null
      commitAsCurrent?: boolean
    } = {}) => {
      const targetMRNumber = mrNumberOverride ?? activeGitLabReview?.number ?? null
      const targetHeadSha = headShaOverride ?? activeGitLabReview?.headSha ?? null
      if (!repo || !targetMRNumber) {
        return
      }
      const requestKey = checksPanelHostedReviewAsyncResultKey(
        hostedReviewCacheKey,
        branch,
        'gitlab',
        targetMRNumber,
        targetHeadSha
      )
      if (commitAsCurrent) {
        asyncResultKeyRef.current = requestKey
      }
      setChecksLoading(true)
      setCommentsLoading(true)
      try {
        const details = await fetchGitLabMRDetailsForChecks({
          repoPath: repo.path,
          repoId: repo.id,
          settings,
          iid: targetMRNumber
        })
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        const result = gitLabPipelineJobsToPRChecks(details?.pipelineJobs ?? [])
        setChecks(result)
        setComments(gitLabMRCommentsToPRComments(details?.comments))
        setGitLabDetailsFetchedAt(Date.now())
        const signature = JSON.stringify(result.map((c) => `${c.name}:${c.status}:${c.conclusion}`))
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 30_000
        prevChecksRef.current = signature
      } catch (err) {
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        console.warn('Failed to fetch GitLab MR checks:', err)
        setChecks([])
        setComments([])
        setGitLabDetailsFetchedAt(null)
      } finally {
        if (isCurrentAsyncResult(requestKey)) {
          setChecksLoading(false)
          setCommentsLoading(false)
        }
      }
    },
    [
      activeGitLabReview?.headSha,
      activeGitLabReview?.number,
      branch,
      hostedReviewCacheKey,
      isCurrentAsyncResult,
      repo,
      settings
    ]
  )

  // Fetch checks on mount + poll with exponential backoff
  useEffect(() => {
    if (activeGitLabReview) {
      return
    }
    if (!prNumber || !isPanelVisible) {
      setChecks([])
      return
    }

    // Reset backoff state on PR change
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    // Why: PR check status is user-visible when the panel is open. Keep visible
    // unfocused windows fresh, but stop timers and API work while hidden.
    return installWindowVisibilityTimeoutPoller({
      run: () => fetchChecks(),
      getDelayMs: () => pollIntervalRef.current
    })
  }, [activeGitLabReview, fetchChecks, isPanelVisible, prNumber])

  useEffect(() => {
    if (!activeGitLabReview || !isPanelVisible) {
      return
    }

    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    return installWindowVisibilityTimeoutPoller({
      run: () => fetchGitLabDetails(),
      getDelayMs: () => pollIntervalRef.current
    })
  }, [activeGitLabReview, fetchGitLabDetails, isPanelVisible])

  // Fetch comments once when PR changes (no polling — comments change infrequently).
  // The manual refresh path calls this directly; the auto-fetch effect below uses
  // its own cancellation guard to discard stale responses after PR switches.
  const fetchComments = useCallback(
    async ({
      force = false,
      prNumberOverride,
      prRepoOverride
    }: {
      force?: boolean
      prNumberOverride?: number | null
      prRepoOverride?: PRInfo['prRepo'] | null
    } = {}) => {
      const targetPRNumber = prNumberOverride ?? prNumber
      const targetPRRepo = prRepoOverride ?? pr?.prRepo
      if (!repo || !targetPRNumber) {
        return
      }
      setCommentsLoading(true)
      try {
        const requestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          targetPRNumber,
          targetPRRepo,
          pr?.headSha
        )
        const result = await fetchPRComments(repo.path, targetPRNumber, {
          force,
          repoId: repo.id,
          prRepo: targetPRRepo
        })
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        setComments(result)
      } catch (err) {
        if (
          !isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, targetPRRepo, pr?.headSha)
          )
        ) {
          return
        }
        console.warn('Failed to fetch PR comments:', err)
        setComments([])
      } finally {
        if (
          isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, targetPRRepo, pr?.headSha)
          )
        ) {
          setCommentsLoading(false)
        }
      }
    },
    [
      repo,
      prNumber,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      fetchPRComments,
      branch,
      isCurrentAsyncResult
    ]
  )

  const handleLoadCheckDetails = useCallback(
    (check: PRCheckDetail) => {
      if (!repo) {
        return Promise.resolve(null)
      }
      return fetchPRCheckDetails(
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
    },
    [fetchPRCheckDetails, pr?.prRepo, repo]
  )

  useEffect(() => {
    if (activeGitLabReview) {
      return
    }
    if (!repo || !prNumber || !isPanelVisible) {
      setComments([])
      return
    }
    let cancelled = false
    const requestKey = checksPanelAsyncResultKey(
      prCacheKey,
      branch,
      prNumber,
      pr?.prRepo,
      pr?.headSha
    )
    setCommentsLoading(true)
    void fetchPRComments(repo.path, prNumber, { repoId: repo.id, prRepo: pr?.prRepo }).then(
      (result) => {
        if (!cancelled && isCurrentAsyncResult(requestKey)) {
          setComments(result)
          setCommentsLoading(false)
        }
      },
      () => {
        if (!cancelled && isCurrentAsyncResult(requestKey)) {
          setComments([])
          setCommentsLoading(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [
    activeGitLabReview,
    repo,
    prNumber,
    pr?.headSha,
    pr?.prRepo,
    prCacheKey,
    branch,
    isPanelVisible,
    fetchPRComments,
    isCurrentAsyncResult
  ])

  useEffect(() => {
    if (activeGitLabReview || !repo || !prNumber || !isPanelVisible) {
      return undefined
    }
    return window.api.gh.onWorkItemMutated((payload) => {
      const sameRepo =
        payload.repoId != null ? payload.repoId === repo.id : payload.repoPath === repo.path
      if (!sameRepo || payload.type !== 'pr' || payload.number !== prNumber) {
        return
      }
      void fetchComments({ force: true })
    })
  }, [activeGitLabReview, fetchComments, isPanelVisible, prNumber, repo])

  const handleRefresh = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    const initialRequestKey = checksPanelAsyncResultKey(
      prCacheKey,
      branch,
      prNumber,
      pr?.prRepo,
      pr?.headSha
    )
    const refreshRequestKey = `${activeWorktreeId ?? ''}::${prCacheKey}::${branch}::${Date.now()}::${Math.random()}`
    refreshRequestKeyRef.current = refreshRequestKey
    const isCurrentRequest = (): boolean => refreshRequestKeyRef.current === refreshRequestKey
    setIsRefreshing(true)
    setGitStatusRefreshNonce((value) => value + 1)
    try {
      if (isGitLabReviewContext) {
        const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
          repoPath: repo.path,
          repoId: repo.id,
          branch,
          linkedGitHubPR: linkedPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR
        })
        if (!isCurrentRequest()) {
          return
        }
        const refreshedGitLabReview =
          refreshedReview?.provider === 'gitlab' ? refreshedReview : activeGitLabReview
        if (refreshedGitLabReview) {
          await fetchGitLabDetails({
            mrNumberOverride: refreshedGitLabReview.number,
            headShaOverride: refreshedGitLabReview.headSha,
            commitAsCurrent: true
          })
        } else {
          setChecks([])
          setComments([])
        }
        return
      }
      const refreshedPR = await fetchPRForBranch(repo.path, branch, {
        force: true,
        repoId: repo.id,
        linkedPRNumber: linkedPR,
        fallbackPRNumber: fallbackGitHubPRNumber
      })
      if (!isCurrentRequest()) {
        return
      }
      await refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: refreshedPR?.number ?? fallbackGitHubPRNumber,
        linkedGitLabMR
      })
      if (!isCurrentRequest()) {
        return
      }
      if (refreshedPR) {
        const prRequestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          refreshedPR.number,
          refreshedPR.prRepo,
          refreshedPR.headSha
        )
        if (!isCurrentAsyncResult(initialRequestKey) && !isCurrentRequest()) {
          return
        }
        // Why: a forced PR refresh can discover the PR number before React has
        // repainted from prCache; make this refresh's follow-up checks current.
        asyncResultKeyRef.current = prRequestKey
        // Why: call fetchPRChecks directly with the refreshed PR's headSha so
        // we don't pass the stale headSha captured by `fetchChecks`'s closure
        // before the PR refresh completed (covers external force-pushes and
        // PR-number changes).
        const refreshedChecks = fetchPRChecks(
          repo.path,
          refreshedPR.number,
          branch,
          refreshedPR.headSha,
          refreshedPR.prRepo,
          { force: true, repoId: repo.id }
        ).then(
          (result) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
            setChecks(result)
            const signature = JSON.stringify(
              result.map((c) => `${c.name}:${c.status}:${c.conclusion}`)
            )
            pollIntervalRef.current =
              signature === prevChecksRef.current
                ? Math.min(pollIntervalRef.current * 2, 120_000)
                : 30_000
            prevChecksRef.current = signature
          },
          (err) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
            console.warn('Failed to fetch PR checks:', err)
            setChecks([])
          }
        )
        setChecksLoading(true)
        setCommentsLoading(true)
        const refreshedComments = fetchPRComments(repo.path, refreshedPR.number, {
          force: true,
          repoId: repo.id,
          prRepo: refreshedPR.prRepo
        }).then(
          (result) => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setComments(result)
            }
          },
          (err) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
            console.warn('Failed to fetch PR comments:', err)
            setComments([])
          }
        )
        await Promise.all([
          refreshedChecks.finally(() => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setChecksLoading(false)
            }
          }),
          refreshedComments.finally(() => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setCommentsLoading(false)
            }
          })
        ])
      } else if (isCurrentRequest()) {
        setChecks([])
        setComments([])
      }
    } finally {
      if (isCurrentRequest()) {
        setIsRefreshing(false)
      }
    }
  }, [
    repo,
    branch,
    activeWorktreeId,
    activeGitLabReview,
    prNumber,
    pr?.headSha,
    pr?.prRepo,
    prCacheKey,
    linkedPR,
    fallbackGitHubPRNumber,
    fetchGitLabDetails,
    linkedGitLabMR,
    isGitLabReviewContext,
    fetchPRForBranch,
    fetchPRChecks,
    fetchPRComments,
    fetchHostedReviewForBranch,
    isCurrentAsyncResult
  ])

  const handleEntryRefresh = useCallback(
    (options: { refreshChecks: boolean; refreshComments: boolean }) => {
      if (!repo || !branch || !activeWorktreeId) {
        return
      }
      // Why: entering the Checks tab is automatic UI behavior, not an explicit
      // user refresh. Route PR refresh through the coordinator so rate-limit
      // guards still apply; only force detail panes that the entry freshness rule
      // already proved stale, so tab entry stays fresh without broad fan-out.
      if (isGitLabReviewContext) {
        void fetchHostedReviewForBranch(repo.path, branch, {
          force: true,
          repoId: repo.id,
          linkedGitHubPR: linkedPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR
        })
        if (activeGitLabReview) {
          void fetchGitLabDetails()
        }
        return
      }
      enqueueGitHubPRRefresh(activeWorktreeId, 'active', 80)
      if (options.refreshChecks) {
        void fetchChecks({ force: true })
      }
      if (options.refreshComments) {
        void fetchComments({ force: true })
      }
    },
    [
      activeGitLabReview,
      activeWorktreeId,
      branch,
      enqueueGitHubPRRefresh,
      fallbackGitHubPRNumber,
      fetchChecks,
      fetchComments,
      fetchGitLabDetails,
      fetchHostedReviewForBranch,
      isGitLabReviewContext,
      linkedGitLabMR,
      linkedPR,
      repo
    ]
  )

  // Why: force a freshness check on each "entry" into the Checks tab so PRs
  // opened outside Orca, externally force-pushed heads, and stale checks/comments
  // appear without waiting for the cache TTL. The grace window suppresses
  // duplicate fetches from rapid show/hide toggles. See
  // docs/refresh-on-checks-tab.md.
  const entryKey =
    isPanelVisible && repo && !isFolder && branch
      ? `${activeWorktreeId ?? ''}::${activeGitLabReview ? hostedReviewCacheKey : prCacheKey}`
      : ''
  const lastEntryKeyRef = useRef<string>('')
  useEffect(() => {
    if (!entryKey) {
      // Resetting on hide is required so reopening the panel on the same PR
      // re-evaluates freshness (a prevKey !== currentKey check alone would miss
      // close-and-reopen of the same PR).
      lastEntryKeyRef.current = ''
      return
    }
    if (lastEntryKeyRef.current === entryKey) {
      return
    }
    lastEntryKeyRef.current = entryKey

    const now = Date.now()
    const stale = shouldEntryRefresh({
      prFetchedAt,
      checksFetchedAt,
      commentsFetchedAt,
      prNumber,
      now,
      graceMs: ENTRY_REFRESH_GRACE_MS
    })
    if (!stale) {
      return
    }
    const cutoff = now - ENTRY_REFRESH_GRACE_MS
    const refreshChecks =
      prNumber !== null && (checksFetchedAt === undefined || checksFetchedAt < cutoff)
    const refreshComments =
      prNumber !== null && (commentsFetchedAt === undefined || commentsFetchedAt < cutoff)

    // Reset polling attention state so the forced fetch's signature establishes
    // a fresh baseline rather than colliding with the previous PR's backoff.
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    handleEntryRefresh({ refreshChecks, refreshComments })
  }, [entryKey, prFetchedAt, checksFetchedAt, commentsFetchedAt, prNumber, handleEntryRefresh])

  const refreshHostedReviewAfterMutation = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    if (activeReview?.provider === 'gitlab') {
      const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        linkedGitLabMR
      })
      const refreshedGitLabReview =
        refreshedReview?.provider === 'gitlab' ? refreshedReview : activeGitLabReview
      if (refreshedGitLabReview) {
        await fetchGitLabDetails({
          mrNumberOverride: refreshedGitLabReview.number,
          headShaOverride: refreshedGitLabReview.headSha,
          commitAsCurrent: true
        })
      }
      return
    }
    const refreshedPR = await fetchPRForBranch(repo.path, branch, {
      force: true,
      repoId: repo.id,
      linkedPRNumber: linkedPR,
      fallbackPRNumber: fallbackGitHubPRNumber
    })
    await refreshHostedReviewCard(fetchHostedReviewForBranch, {
      repoPath: repo.path,
      repoId: repo.id,
      branch,
      linkedGitHubPR: linkedPR,
      fallbackGitHubPR: refreshedPR?.number ?? fallbackGitHubPRNumber,
      linkedGitLabMR
    })
  }, [
    activeGitLabReview,
    activeReview?.provider,
    branch,
    fallbackGitHubPRNumber,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    fetchPRForBranch,
    linkedGitLabMR,
    linkedPR,
    repo
  ])

  const handleStartEdit = useCallback(() => {
    if (!activeReview) {
      return
    }
    setTitleDraft(activeReview.title)
    setEditingTitle(true)
    clearTitleInputFocusTimer()
    titleInputFocusTimerRef.current = setTimeout(() => {
      titleInputFocusTimerRef.current = null
      titleInputRef.current?.focus()
    }, 0)
  }, [activeReview, clearTitleInputFocusTimer])

  const handleCancelEdit = useCallback(() => {
    clearTitleInputFocusTimer()
    setEditingTitle(false)
    setTitleDraft('')
  }, [clearTitleInputFocusTimer])

  const handleSaveTitle = useCallback(async () => {
    const nextTitle = titleDraft.trim()
    if (!repo || !activeReview || !nextTitle || nextTitle === activeReview.title) {
      clearTitleInputFocusTimer()
      setEditingTitle(false)
      return
    }
    setTitleSaving(true)
    try {
      if (activeReview.provider === 'gitlab') {
        const result = await window.api.gl.updateMR({
          repoPath: repo.path,
          iid: activeReview.number,
          updates: { title: nextTitle }
        })
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        await refreshHostedReviewAfterMutation()
      } else {
        if (!pr) {
          return
        }
        const ok = await window.api.gh.updatePRTitle({
          repoPath: repo.path,
          repoId: repo.id,
          prNumber: pr.number,
          title: nextTitle,
          prRepo: pr.prRepo ?? null
        })
        if (ok) {
          await refreshHostedReviewAfterMutation()
        }
      }
    } finally {
      clearTitleInputFocusTimer()
      if (mountedRef.current) {
        setTitleSaving(false)
        setEditingTitle(false)
      }
    }
  }, [
    activeReview,
    repo,
    pr,
    titleDraft,
    refreshHostedReviewAfterMutation,
    clearTitleInputFocusTimer,
    mountedRef
  ])

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void handleSaveTitle()
      } else if (e.key === 'Escape') {
        handleCancelEdit()
      }
    },
    [handleSaveTitle, handleCancelEdit]
  )

  const handleResolve = useCallback(
    async (threadId: string, resolve: boolean): Promise<boolean> => {
      if (repo && activeGitLabReview) {
        const previousComments = comments
        setComments((prev) =>
          prev.map((comment) =>
            comment.threadId === threadId ? { ...comment, isResolved: resolve } : comment
          )
        )
        const result = await resolveGitLabMRDiscussionForChecks({
          repoPath: repo.path,
          repoId: repo.id,
          settings,
          iid: activeGitLabReview.number,
          discussionId: threadId,
          resolved: resolve
        })
        if (!result.ok) {
          setComments(previousComments)
          toast.error(result.error)
          return false
        }
        return true
      }
      if (!repo || !prNumber) {
        return false
      }
      const requestKey = checksPanelAsyncResultKey(
        prCacheKey,
        branch,
        prNumber,
        pr?.prRepo,
        pr?.headSha
      )
      const previousComments = comments
      setComments((prev) =>
        prev.map((comment) =>
          comment.threadId === threadId ? { ...comment, isResolved: resolve } : comment
        )
      )
      const ok = await resolveReviewThread(repo.path, prNumber, threadId, resolve, {
        repoId: repo.id,
        prRepo: pr?.prRepo
      })
      if (!isCurrentAsyncResult(requestKey)) {
        return ok
      }
      if (!ok) {
        setComments(previousComments)
        toast.error('Could not update review thread. Check the GitHub API budget.')
      }
      return ok
    },
    [
      activeGitLabReview,
      branch,
      comments,
      isCurrentAsyncResult,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      prNumber,
      repo,
      resolveReviewThread,
      settings
    ]
  )

  const canTargetPRComments = Boolean(repo && prNumber && pr?.prRepo)
  const commentsDisabledReason = canTargetPRComments
    ? undefined
    : 'Commenting requires a GitHub PR repository target.'
  const activeConnectionId = activeWorktreeId ? getConnectionId(activeWorktreeId) : undefined
  const detectedAgentsForAI =
    typeof activeConnectionId === 'string' ? remoteDetectedAgentIds : detectedAgentIds
  const noEnabledAgentKnown =
    detectedAgentsForAI != null &&
    pickDefaultSourceControlAgent(
      settings?.defaultTuiAgent,
      detectedAgentsForAI,
      settings?.disabledTuiAgents
    ) == null
  const aiActionDisabledReason = !activeWorktreeId
    ? 'Select a workspace before launching an AI action.'
    : activeConnectionId === undefined
      ? 'Unable to resolve the workspace connection.'
      : noEnabledAgentKnown
        ? 'No enabled AI agents. Configure agents in Settings.'
        : undefined

  const handleAddPRComment = useCallback(
    async (body: string) => {
      if (!repo || !prNumber || !pr?.prRepo) {
        return { ok: false as const, error: commentsDisabledReason ?? 'Commenting unavailable.' }
      }
      const requestKey = checksPanelAsyncResultKey(
        prCacheKey,
        branch,
        prNumber,
        pr.prRepo,
        pr.headSha
      )
      const result = await addPRConversationComment(repo.path, prNumber, body, {
        repoId: repo.id,
        prRepo: pr.prRepo
      })
      if (!isCurrentAsyncResult(requestKey)) {
        return result.ok ? { ok: true as const } : result
      }
      if (!result.ok) {
        toast.error(result.error)
        return result
      }
      setComments((prev) => mergePRCommentIntoList(prev, result.comment))
      return { ok: true as const }
    },
    [
      addPRConversationComment,
      branch,
      commentsDisabledReason,
      isCurrentAsyncResult,
      pr,
      prCacheKey,
      prNumber,
      repo
    ]
  )

  const handleReplyToComment = useCallback(
    async (comment: PRComment, body: string) => {
      if (!repo || !prNumber || !pr?.prRepo) {
        return { ok: false as const, error: commentsDisabledReason ?? 'Commenting unavailable.' }
      }
      const requestKey = checksPanelAsyncResultKey(
        prCacheKey,
        branch,
        prNumber,
        pr.prRepo,
        pr.headSha
      )
      const canReplyToReviewThread =
        Boolean(comment.threadId) && Number.isSafeInteger(comment.id) && comment.id > 0
      const result = canReplyToReviewThread
        ? await addPRReviewCommentReply(repo.path, prNumber, comment.id, body, {
            repoId: repo.id,
            prRepo: pr.prRepo,
            threadId: comment.threadId,
            path: comment.path,
            line: comment.line
          })
        : await addPRConversationComment(repo.path, prNumber, `@${comment.author} ${body}`, {
            repoId: repo.id,
            prRepo: pr.prRepo
          })
      if (!isCurrentAsyncResult(requestKey)) {
        return result.ok ? { ok: true as const } : result
      }
      if (!result.ok) {
        toast.error(result.error)
        return result
      }
      setComments((prev) => mergePRCommentIntoList(prev, result.comment))
      return { ok: true as const }
    },
    [
      addPRConversationComment,
      addPRReviewCommentReply,
      branch,
      commentsDisabledReason,
      isCurrentAsyncResult,
      pr,
      prCacheKey,
      prNumber,
      repo
    ]
  )

  // Why: hosted-review conflict files come from the host mergeability check,
  // not a local MERGE_HEAD, so the prompt must tell the agent how to reproduce
  // the merge locally instead of reusing the live Source Control conflict prompt.
  const handleResolveConflictsWithAI = useCallback(async (): Promise<void> => {
    if (isResolvingConflictsWithAI || !activeWorktreeId || !activeConflictReview) {
      return
    }
    const requestKey = stateRequestKey
    const conflictFiles = activeConflictReview.conflictSummary?.files ?? []
    setIsResolvingConflictsWithAI(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId)
      if (connectionId === undefined) {
        toast.error('Unable to resolve the workspace connection.')
        return
      }
      const store = useAppStore.getState()
      const detectedAgents =
        typeof connectionId === 'string'
          ? await store.ensureRemoteDetectedAgents(connectionId)
          : await store.ensureDetectedAgents()
      const agent = pickDefaultSourceControlAgent(
        store.settings?.defaultTuiAgent,
        detectedAgents,
        store.settings?.disabledTuiAgents
      )
      if (!agent) {
        toast.error('No enabled AI agents. Configure agents in Settings.')
        return
      }
      if (!isCurrentAsyncResult(requestKey)) {
        return
      }
      const prompt = buildResolvePullRequestConflictsPrompt({
        baseRef: activeConflictReview.conflictSummary?.baseRef,
        entries: conflictFiles.map((path) => ({ path })),
        worktreePath: activeWorktreePath ?? null,
        reviewKind: activeGitLabReview ? 'merge request' : 'pull request'
      })
      const result = launchAgentInNewTab({
        agent,
        worktreeId: activeWorktreeId,
        prompt,
        promptDelivery: 'submit-after-ready',
        launchSource: 'conflict_resolution'
      })
      if (!result) {
        toast.error('Could not build the agent launch command.')
        return
      }
      focusTerminalTabSurface(result.tabId)
      toast.success('Started an AI agent for the conflicts.')
    } finally {
      setIsResolvingConflictsWithAI(false)
    }
  }, [
    activeConflictReview,
    activeGitLabReview,
    activeWorktreeId,
    activeWorktreePath,
    isCurrentAsyncResult,
    isResolvingConflictsWithAI,
    stateRequestKey
  ])

  const handleFixChecksWithAI = useCallback(async (): Promise<void> => {
    if (isFixingChecksWithAI || !activeWorktreeId || !activeReview) {
      return
    }
    const broken = getBrokenChecks(checks)
    if (broken.length === 0) {
      toast.message('No broken checks to fix.')
      return
    }
    const requestKey = stateRequestKey
    setIsFixingChecksWithAI(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId)
      if (connectionId === undefined) {
        toast.error('Unable to resolve the workspace connection.')
        return
      }
      const store = useAppStore.getState()
      const detectedAgents =
        typeof connectionId === 'string'
          ? await store.ensureRemoteDetectedAgents(connectionId)
          : await store.ensureDetectedAgents()
      const agent = pickDefaultSourceControlAgent(
        store.settings?.defaultTuiAgent,
        detectedAgents,
        store.settings?.disabledTuiAgents
      )
      if (!agent) {
        toast.error('No enabled AI agents. Configure agents in Settings.')
        return
      }
      if (!isCurrentAsyncResult(requestKey)) {
        return
      }
      const checkRunDetailsByCheckKey: Record<string, PRCheckRunDetails> = {}
      if (activeReview.provider !== 'gitlab' && repo) {
        await Promise.all(
          broken.slice(0, 5).map(async (check, index) => {
            if (!check.checkRunId && !check.workflowRunId && !check.url) {
              return
            }
            try {
              const details = await fetchPRCheckDetails(
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
      }
      if (!isCurrentAsyncResult(requestKey)) {
        return
      }
      const prompt = buildFixBrokenChecksPrompt({
        reviewKind: activeReview.provider === 'gitlab' ? 'MR' : 'PR',
        reviewNumber: activeReview.number,
        reviewTitle: activeReview.title,
        reviewUrl: activeReview.url,
        checks,
        checkRunDetailsByCheckKey
      })
      const result = launchAgentInNewTab({
        agent,
        worktreeId: activeWorktreeId,
        prompt,
        promptDelivery: 'submit-after-ready',
        launchSource: 'task_page',
        onPromptDelivered: () => {
          toast.success('Started an AI agent for the broken checks.')
        }
      })
      if (!result) {
        toast.error('Could not build the agent launch command.')
        return
      }
      focusTerminalTabSurface(result.tabId)
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
    stateRequestKey
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
          linkedGitLabMR
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
      branch,
      fetchHostedReviewForBranch,
      fetchPRChecks,
      fetchPRComments,
      fetchPRForBranch,
      isCurrentAsyncResult,
      linkedGitLabMR,
      panelContextKey,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      prNumber,
      repo
    ]
  )

  // Open hosted review in browser
  const handleOpenPR = useCallback(() => {
    if (activeReview?.url) {
      window.api.shell.openUrl(activeReview.url)
    }
  }, [activeReview])

  const handleUnlinkPullRequest = useCallback(() => {
    if (!activeWorktreeId || activeReview?.provider !== 'github' || linkedPR === null) {
      return
    }
    void updateWorktreeMeta(activeWorktreeId, { linkedPR: null })
  }, [activeReview?.provider, activeWorktreeId, linkedPR, updateWorktreeMeta])

  const handleLinkAnotherPullRequest = useCallback(() => {
    if (!activeWorktreeId || !activeWorktree || activeReview?.provider !== 'github') {
      return
    }
    openModal('edit-meta', {
      worktreeId: activeWorktreeId,
      currentDisplayName: activeWorktree.displayName,
      currentIssue: activeWorktree.linkedIssue,
      currentPR: activeWorktree.linkedPR ?? activeReview.number,
      currentComment: activeWorktree.comment,
      focus: 'pr',
      afterSave: ({ updates }: { updates?: { linkedPR?: unknown } }) => {
        const nextLinkedPR = updates?.linkedPR
        if (typeof nextLinkedPR === 'number') {
          void refreshLinkedGitHubPullRequest(nextLinkedPR)
        }
      }
    })
  }, [activeReview, activeWorktree, activeWorktreeId, openModal, refreshLinkedGitHubPullRequest])

  const pushBeforeCreatePullRequest = useCallback(async (): Promise<boolean> => {
    if (!activeWorktreeId || !activeWorktree?.path) {
      return false
    }
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    try {
      await pushBranch(
        activeWorktreeId,
        activeWorktree.path,
        false,
        connectionId,
        activeWorktree.pushTarget
      )
      await fetchUpstreamStatus(activeWorktreeId, activeWorktree.path, connectionId)
      return true
    } catch {
      return false
    }
  }, [activeWorktree, activeWorktreeId, fetchUpstreamStatus, pushBranch])

  const handlePublishBranch = useCallback(async (): Promise<void> => {
    if (
      !activeWorktreeId ||
      !activeWorktree?.path ||
      isPublishingBranch ||
      isRemoteOperationActive
    ) {
      return
    }
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    setIsPublishingBranch(true)
    try {
      await pushBranch(
        activeWorktreeId,
        activeWorktree.path,
        true,
        connectionId,
        activeWorktree.pushTarget
      )
      await fetchUpstreamStatus(
        activeWorktreeId,
        activeWorktree.path,
        connectionId,
        activeWorktree.pushTarget
      )
    } catch {
      // Store remote actions already surface the publish failure toast.
    } finally {
      // Why: publishing changes the upstream boundary the Checks panel uses to
      // decide between Publish, Create PR, and Push & Create PR.
      setGitStatusRefreshNonce((value) => value + 1)
      setIsPublishingBranch(false)
    }
  }, [
    activeWorktree,
    activeWorktreeId,
    fetchUpstreamStatus,
    isPublishingBranch,
    isRemoteOperationActive,
    pushBranch
  ])

  const handleBranchChangedByPullRequestGeneration = useCallback(async (): Promise<void> => {
    if (!activeWorktreeId || !activeWorktree?.path) {
      return
    }
    // Why: AI PR detail generation rebases before summarizing; if HEAD moved,
    // the dialog must push before creating from the refreshed branch state.
    setCreatePrPushFirst(true)
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    await fetchUpstreamStatus(activeWorktreeId, activeWorktree.path, connectionId)
  }, [activeWorktree?.path, activeWorktreeId, fetchUpstreamStatus])

  const handlePullRequestCreated = useCallback(
    async (result: {
      provider: HostedReviewProvider
      number: number
      url: string
    }): Promise<void> => {
      if (!repo || !branch) {
        return
      }
      setRightSidebarOpen(true)
      setRightSidebarTab('checks')
      try {
        if (activeWorktreeId && result.provider === 'github') {
          await updateWorktreeMeta(activeWorktreeId, { linkedPR: result.number })
        }
        if (activeWorktreeId && result.provider === 'gitlab') {
          await updateWorktreeMeta(activeWorktreeId, { linkedGitLabMR: result.number })
        }
        if (result.provider === 'gitlab') {
          const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
            repoPath: repo.path,
            repoId: repo.id,
            branch,
            linkedGitHubPR: linkedPR,
            fallbackGitHubPR: fallbackGitHubPRNumber,
            linkedGitLabMR: result.number
          })
          const refreshedGitLabReview =
            refreshedReview?.provider === 'gitlab' ? refreshedReview : null
          await fetchGitLabDetails({
            mrNumberOverride: result.number,
            headShaOverride: refreshedGitLabReview?.headSha,
            commitAsCurrent: true
          })
          return
        }
        await refreshLinkedGitHubPullRequest(result.number)
      } catch {
        // The success toast keeps the hosted URL available; Checks can be refreshed manually.
      }
    },
    [
      branch,
      fallbackGitHubPRNumber,
      fetchGitLabDetails,
      fetchHostedReviewForBranch,
      linkedGitLabMR,
      linkedPR,
      refreshLinkedGitHubPullRequest,
      repo,
      setRightSidebarOpen,
      setRightSidebarTab,
      activeWorktreeId,
      updateWorktreeMeta
    ]
  )

  const activeReviewClassification = React.useMemo(() => {
    if (!repo) {
      return null
    }
    const options: HostedReviewClassificationOptions = {
      agentAuthorLogins: [],
      viewer: null
    }
    if (activeGitLabReview) {
      const commentsForClassification =
        gitLabDetailsFetchedAt !== null && !commentsLoading ? comments : undefined
      const summary = hostedReviewSummaryFromGitLabInfo({
        review: activeGitLabReview,
        comments: commentsForClassification,
        checks
      })
      return classifyHostedReview(summary, options)
    }
    if (!pr) {
      return null
    }
    let host = 'github.com'
    let owner = 'unknown'
    let repoName = 'unknown'
    try {
      const parsed = new URL(pr.url)
      host = parsed.host || host
      const segments = parsed.pathname.split('/').filter(Boolean)
      if (segments.length >= 2) {
        owner = segments[0]
        repoName = segments[1]
      }
    } catch {
      // Why: malformed URLs should not block queue-state classification.
    }

    // Why: unresolved thread data is paginated and fetched separately. Until
    // comments have loaded for this PR, do not let queue badges imply a clean review.
    const commentsForClassification =
      commentsFetchedAt !== undefined && !commentsLoading ? comments : undefined
    const summary = hostedReviewSummaryFromGitHubPRInfo({
      pr,
      owner,
      repo: repoName,
      host,
      comments: commentsForClassification,
      checks
    })
    return classifyHostedReview(summary, options)
  }, [
    activeGitLabReview,
    repo,
    gitLabDetailsFetchedAt,
    commentsLoading,
    comments,
    checks,
    pr,
    commentsFetchedAt
  ])

  const queueBadges = React.useMemo(() => {
    if (!activeReviewClassification) {
      return [] as string[]
    }
    const badges: string[] = []
    if (activeReviewClassification.needsResponse) {
      badges.push('Needs response')
    }
    // Why: viewer/author/requestedReviewer signals are not wired into the
    // ChecksPanel call site yet, so `state` and `requested` would mis-classify
    // every PR (collapsing to 'teammate'). Suppress those badges until the
    // inputs are available; needs-response works from PR metadata alone and
    // remains accurate.
    return badges
  }, [activeReviewClassification])

  // ── Empty state ──
  if (!activeWorktree) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">No workspace selected</div>
        <div className="mt-1 text-xs text-muted-foreground">Select a workspace to view checks</div>
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">Checks unavailable</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Checks require a Git branch and hosted review context
        </div>
      </div>
    )
  }

  if (!activeReview) {
    // Why: during a rebase/merge/cherry-pick the worktree is on a detached
    // HEAD, so there is no branch to look up a PR for. Showing "No pull
    // request found" is misleading — the PR still exists on the original
    // branch. Show an operation-aware message instead.
    const operationInProgress = conflictOperation !== 'unknown'
    const operationLabel =
      conflictOperation === 'rebase'
        ? 'Rebase'
        : conflictOperation === 'merge'
          ? 'Merge'
          : conflictOperation === 'cherry-pick'
            ? 'Cherry-pick'
            : null
    const emptyReviewIsGitLab =
      linkedGitLabMR !== null || hostedReviewCreation?.provider === 'gitlab'
    const emptyReviewLabel = emptyReviewIsGitLab ? 'merge request' : 'pull request'
    const emptyReviewShortLabel = emptyReviewIsGitLab ? 'MR' : 'PR'
    const canCreate = hostedReviewCreation?.canCreate
    const canPushCreate = hostedReviewCreation?.blockedReason === 'needs_push'
    const canPublishBranch =
      isPublishingBranch ||
      (!publishActionHasUncommittedChanges &&
        shouldShowChecksPanelPublishBranchAction({
          hostedReviewBlockedReason: hostedReviewCreation?.blockedReason,
          hasUpstream: publishActionRemoteStatus?.hasUpstream
        }))
    const emptyStateCopy = getChecksPanelEmptyStateCopy({
      operationLabel,
      prRefreshStatus: emptyReviewIsGitLab ? undefined : prRefreshState?.status,
      hostedReviewBlockedReason: hostedReviewCreation?.blockedReason,
      hasUpstream: publishActionRemoteStatus?.hasUpstream,
      reviewLabel: emptyReviewLabel,
      reviewShortLabel: emptyReviewShortLabel
    })
    return (
      <>
        {repo && (
          /* Keyed to the same branch/worktree context as the panel's render-time
             reset so dialog-local submission state cannot leak across contexts. */
          <CreatePullRequestDialog
            key={panelContextKey}
            open={createPrDialogOpen}
            repoId={repo.id}
            repoPath={repo.path}
            worktreeId={activeWorktreeId}
            worktreePath={activeWorktreePath ?? repo.path}
            branch={branch}
            eligibility={hostedReviewCreation}
            pushBeforeCreate={createPrPushFirst}
            onOpenChange={setCreatePrDialogOpen}
            onPushBeforeCreate={pushBeforeCreatePullRequest}
            onBranchChangedByGeneration={handleBranchChangedByPullRequestGeneration}
            onCreated={handlePullRequestCreated}
          />
        )}
        <div className="px-4 py-6">
          <div className="text-sm font-medium text-foreground">{emptyStateCopy.title}</div>
          <div className="mt-1 text-xs text-muted-foreground">{emptyStateCopy.description}</div>
          {!operationInProgress && (
            <div className="mt-3 flex flex-wrap gap-2">
              {canPublishBranch && (
                <Button
                  size="xs"
                  disabled={isPublishingBranch || isRemoteOperationActive}
                  onClick={handlePublishBranch}
                >
                  {isPublishingBranch ? 'Publishing…' : 'Publish Branch'}
                </Button>
              )}
              {(canCreate || canPushCreate) && (
                <Button
                  size="xs"
                  onClick={() => {
                    setCreatePrPushFirst(canPushCreate)
                    setCreatePrDialogOpen(true)
                  }}
                >
                  {canPushCreate
                    ? `Push & Create ${emptyReviewShortLabel}`
                    : `Create ${emptyReviewShortLabel}`}
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                disabled={emptyRefreshing || isPublishingBranch || isRemoteOperationActive}
                onClick={() => {
                  if (!activeWorktreeId) {
                    return
                  }
                  setEmptyRefreshing(true)
                  void handleRefresh().finally(() => {
                    setEmptyRefreshing(false)
                  })
                }}
              >
                {emptyRefreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            </div>
          )}
        </div>
      </>
    )
  }

  const reviewShortLabel = activeReview.provider === 'gitlab' ? 'MR' : 'PR'
  const shouldShowReviewTriageStrip =
    activeConflictReview !== null || getBrokenChecks(checks).length > 0
  return (
    <div ref={setChecksPanelContentRef} className="flex-1 overflow-auto scrollbar-sleek">
      {/* Hosted review header */}
      <div className="px-3 py-3 border-b border-border space-y-2.5">
        {/* Review number + state badge + refresh + open link */}
        <ChecksPanelReviewHeader
          review={activeReview}
          isRefreshing={isRefreshing}
          canUnlinkPullRequest={linkedPR !== null}
          onRefresh={() => void handleRefresh()}
          onOpenReview={handleOpenPR}
          onUnlinkPullRequest={handleUnlinkPullRequest}
          onLinkAnotherPullRequest={handleLinkAnotherPullRequest}
        />

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
              title="Save"
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
              title="Cancel"
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
            <Pencil className="size-3 text-muted-foreground/40 opacity-0 group-hover/title:opacity-100 transition-opacity shrink-0 mt-0.5" />
          </div>
        )}

        {/* Updated at */}
        {activeReview.updatedAt && (
          <div className="text-[10px] text-muted-foreground/60">
            {reviewShortLabel} updated {new Date(activeReview.updatedAt).toLocaleString()}
          </div>
        )}
        {queueBadges.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {queueBadges.map((badge) => (
              <span
                key={badge}
                className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {badge}
              </span>
            ))}
          </div>
        ) : null}

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

      {shouldShowReviewTriageStrip && (
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
          {/* Why: the triage strip owns the single Resolve action for PR and MR
              conflicts; the file list and fallback notice are informational. */}
          <ConflictingFilesSection pr={activeConflictReview} />
          <MergeConflictNotice
            pr={activeConflictReview}
            isRefreshingConflictDetails={isRefreshing || conflictDetailsRefreshing}
          />
        </>
      )}
      {/* Why: when the hosted review has merge conflicts and no checks have been fetched,
          showing "No checks configured" is misleading — checks may exist but
          simply cannot run until conflicts are resolved. Hide the empty state. */}
      {!(activeConflictReview && checks.length === 0 && !checksLoading) && (
        <ChecksList
          checks={checks}
          checksLoading={checksLoading}
          checkDetailsContextKey={stateRequestKey}
          onLoadCheckDetails={handleLoadCheckDetails}
        />
      )}
      <PRCommentsList
        comments={comments}
        commentsLoading={commentsLoading}
        commentsDisabled={!canTargetPRComments}
        commentsDisabledReason={commentsDisabledReason}
        onAddComment={pr ? handleAddPRComment : undefined}
        onReply={pr ? handleReplyToComment : undefined}
        onResolve={pr || activeGitLabReview ? handleResolve : undefined}
      />
    </div>
  )
}
