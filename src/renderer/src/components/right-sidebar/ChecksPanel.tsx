/* eslint-disable max-lines -- Why: the checks panel co-locates PR header, checks, comments,
merge actions, and conflict state in one component to keep the data flow straightforward. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useAppStore, type AppState } from '@/store'
import {
  buildGitHubPRRefreshStateClearToken,
  getGitHubPRRefreshStateExpiryAt,
  mergePRCommentIntoList,
  prChecksCacheSuffix,
  prCommentsCacheSuffix
} from '@/store/slices/github'
import { getGitHubPRCacheKey, getGitHubRepoCacheKey } from '@/store/slices/github-cache-key'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { openHttpLink } from '@/lib/http-link-routing'
import { Button } from '@/components/ui/button'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import {
  getTerminalUrlSystemBrowserHint,
  isMacPlatform
} from '../terminal-pane/terminal-link-open-hints'
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
  isMutablePRConversationComment,
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
import {
  buildResolvePullRequestConflictsPrompt,
  pickDefaultSourceControlAgent
} from './SourceControl'
import {
  buildFixBrokenChecksPrompt,
  getBrokenChecks,
  getCheckDetailsPromptKey
} from '../pr-checks-fix-prompt'
import {
  buildPRCommentsResolutionPrompt,
  isResolvablePRCommentGroup
} from '../pr-comments-resolution-prompt'
import { startFixChecksAgent } from '@/lib/fix-checks-agent-launch'
import type {
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import { resolveHostedReviewCreationProvider } from '../../../../shared/hosted-review-creation-providers'
import { normalizeHostedReviewHeadRef } from '../../../../shared/hosted-review-refs'
import { getHostedReviewCacheKey, refreshHostedReviewCard } from '@/store/slices/hosted-review'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { type ChecksPanelReview, selectChecksPanelReview } from './checks-panel-review'
import {
  checksPanelAsyncResultKey,
  checksPanelHostedReviewAsyncResultKey,
  shouldCommitChecksPanelAsyncResult
} from './checks-panel-async-result-key'
import {
  markPRCommentThreadResolved,
  restorePRCommentThreadSnapshot
} from './pr-comment-thread-resolution'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-visibility-timeout-poller'
import {
  getChecksPanelEmptyStateCopy,
  shouldShowChecksPanelPublishBranchAction
} from './checks-panel-empty-state'
import { hasAmbiguousGitHubHostedReviewForChecksPanel } from './checks-panel-ambiguous-github-review'
import { recordChecksPanelPRRefreshBreadcrumb } from './checks-panel-pr-refresh-breadcrumb'
import {
  cancelRuntimeGeneratePullRequestFields,
  generateRuntimePullRequestFields,
  getRuntimeGitScope,
  getRuntimeGitStatus,
  getRuntimeGitUpstreamStatus,
  type RuntimeGeneratePullRequestFieldsOverrides
} from '@/runtime/runtime-git-client'
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
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'
import { readSourceControlLaunchRecipeAgentId } from '@/lib/source-control-launch-agent-selection'
import {
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
  resolveSourceControlActionRecipe,
  resolveSourceControlAiEnabled,
  resolveSourceControlAiForOperation,
  resolveSourceControlAiPrCreationDefaults
} from '../../../../shared/source-control-ai'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../../shared/commit-message-host-key'
import {
  type SourceControlActionRecipe,
  type SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import {
  saveSourceControlActionRecipe,
  type SourceControlAiWriteTarget
} from '../../../../shared/source-control-ai-recipe-save'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { CreateHostedReviewComposer } from './CreateHostedReviewComposer'
import { formatCreateError } from './create-pull-request-review-copy'
import { stripBaseRef, useCreatePullRequestDialogFields } from './useCreatePullRequestDialogFields'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { translate } from '@/i18n/i18n'
import { groupPRComments, type PRCommentGroup } from '@/lib/pr-comment-groups'
import { openChecksPanelHostedReviewUrl } from './checks-panel-hosted-review-click-routing'
import { ChecksPanelUpdatedAtMetadata } from './checks-panel-updated-at-metadata'
import {
  clearPullRequestGenerationRequiresPushBeforeCreate,
  createRunningPullRequestGenerationRecord,
  getPullRequestGenerationRecordKey,
  getPullRequestGenerationSeedRestoreKey,
  markPullRequestGenerationRequiresPushBeforeCreate,
  markPullRequestGenerationTerminalSeedRestored,
  resolvePullRequestGenerationCancel,
  resolvePullRequestGenerationFailure,
  resolvePullRequestGenerationSuccess,
  shouldHydratePullRequestGenerationResult,
  type PullRequestFieldRevisions,
  type PullRequestGenerationContext,
  type PullRequestGenerationFields
} from '@/store/slices/pull-request-generation'

const RUNTIME_SSH_STATUS_REFRESH_MS = 3000
const GIT_STATUS_FAILURE_RETRY_MS = 3000

type HostedReviewCreationSnapshot = {
  requestKey: string
  repoId: string
  worktreeId: string | null
  branch: string
  data: HostedReviewCreationEligibility
}

type ChecksAgentComposerState = {
  actionId: SourceControlLaunchActionId
  title: string
  description: string
  prompt: string
  launchSource: 'conflict_resolution' | 'task_page'
  commentResolution?: {
    reviewContextKey: string
    provider: ChecksPanelReview['provider']
    selectedThreadIds: string[]
    selectedGroups: PRCommentGroup[]
  }
}
type ChecksPanelReviewHeaderProps = {
  review: ChecksPanelReview
  isRefreshing: boolean
  canUnlinkPullRequest: boolean
  showSystemBrowserHint: boolean
  onRefresh: () => void
  onOpenReview: (event: React.MouseEvent<HTMLButtonElement>) => void
  onUnlinkPullRequest: () => void
  onLinkAnotherPullRequest: () => void
}

export function ChecksPanelReviewHeader({
  review,
  isRefreshing,
  canUnlinkPullRequest,
  showSystemBrowserHint,
  onRefresh,
  onOpenReview,
  onUnlinkPullRequest,
  onLinkAnotherPullRequest
}: ChecksPanelReviewHeaderProps): React.JSX.Element {
  const reviewNumberLabel = review.provider === 'gitlab' ? `!${review.number}` : `#${review.number}`
  const ReviewIcon = review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  const reviewHostLabel = review.provider === 'gitlab' ? 'GitLab' : 'GitHub'
  const showPullRequestMenu = review.provider === 'github'
  const openTitle = translate(
    'auto.components.right.sidebar.ChecksPanel.5c88c6db07',
    'Open on {{value0}}',
    { value0: reviewHostLabel }
  )
  const title = showSystemBrowserHint
    ? `${openTitle}. ${getTerminalUrlSystemBrowserHint()}`
    : openTitle

  return (
    <div className="flex items-center gap-2">
      <ReviewIcon className="size-4 text-muted-foreground shrink-0" />
      <button
        type="button"
        className="rounded px-0.5 text-[12px] font-semibold text-foreground underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={title}
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
        title={translate('auto.components.right.sidebar.ChecksPanel.7f4489f370', 'Refresh')}
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
              aria-label={translate(
                'auto.components.right.sidebar.ChecksPanel.653c105ecc',
                'More PR actions'
              )}
              title={translate(
                'auto.components.right.sidebar.ChecksPanel.653c105ecc',
                'More PR actions'
              )}
              className="text-muted-foreground hover:text-foreground"
            >
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem disabled={!canUnlinkPullRequest} onSelect={onUnlinkPullRequest}>
              <Unlink className="size-3.5" />
              {translate('auto.components.right.sidebar.ChecksPanel.7202f4a40a', 'unlink PR')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onLinkAnotherPullRequest}>
              <Link className="size-3.5" />
              {translate('auto.components.right.sidebar.ChecksPanel.07871c0589', 'Link another PR')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
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
    repoId: args.repoId,
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
    repoId: args.repoId,
    iid: args.iid,
    discussionId: args.discussionId,
    resolved: args.resolved
  })
}

export default function ChecksPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const activeConnectionId = activeWorktreeId
    ? (getConnectionId(activeWorktreeId) ?? repo?.connectionId ?? null)
    : null
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const prCache = useAppStore((s) => s.prCache)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const expireGitHubPRRefreshState = useAppStore((s) => s.expireGitHubPRRefreshState)
  const getHostedReviewCreationEligibility = useAppStore(
    (s) => s.getHostedReviewCreationEligibility
  )
  const createHostedReview = useAppStore((s) => s.createHostedReview)
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
    return typeof activeConnectionId === 'string'
      ? (s.remoteDetectedAgentIds[activeConnectionId] ?? null)
      : null
  })

  const [checks, setChecks] = useState<PRCheckDetail[]>([])
  const [checksLoading, setChecksLoading] = useState(false)
  const [comments, setComments] = useState<PRComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const commentsRef = useRef<PRComment[]>([])
  const [emptyRefreshing, setEmptyRefreshing] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [conflictDetailsRefreshing, setConflictDetailsRefreshing] = useState(false)
  const createPrInFlightRef = useRef<string | null>(null)
  const [isCreatingPr, setIsCreatingPr] = useState(false)
  const [createPrError, setCreatePrError] = useState<string | null>(null)
  const [isPublishingBranch, setIsPublishingBranch] = useState(false)
  const isResolvingConflictsWithAI = false
  const [isFixingChecksWithAI, setIsFixingChecksWithAI] = useState(false)
  const [agentComposerState, setAgentComposerState] = useState<ChecksAgentComposerState | null>(
    null
  )
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
  const confirm = useConfirmationDialog()
  const prevChecksRef = useRef<string>('')
  const conflictSummaryRefreshKeyRef = useRef<string | null>(null)
  commentsRef.current = comments
  const prGenerationRecords = useAppStore((s) => s.pullRequestGenerationRecords)
  const allocatePullRequestGenerationRequestId = useAppStore(
    (s) => s.allocatePullRequestGenerationRequestId
  )
  const setPullRequestGenerationRecord = useAppStore((s) => s.setPullRequestGenerationRecord)
  const updatePullRequestGenerationRecord = useAppStore((s) => s.updatePullRequestGenerationRecord)

  const saveLaunchActionDefault = useCallback(
    async (
      target: SourceControlAiWriteTarget,
      actionId: SourceControlLaunchActionId,
      recipe: SourceControlActionRecipe
    ): Promise<void> => {
      const state = useAppStore.getState()
      const latestSettings = state.settings
      if (!latestSettings) {
        throw new Error('Settings are not loaded.')
      }
      const latestRepo =
        target.type === 'repo'
          ? (state.repos.find((candidate) => candidate.id === target.repoId) ?? null)
          : null
      const result = saveSourceControlActionRecipe({
        target,
        settings: latestSettings,
        repo: latestRepo,
        actionId,
        recipe
      })
      if ('sourceControlAi' in result) {
        await updateSettings({ sourceControlAi: result.sourceControlAi })
        return
      }
      await updateRepo(result.target.repoId, result.update)
    },
    [updateRepo, updateSettings]
  )
  const asyncResultKeyRef = useRef<string>('')
  const refreshRequestKeyRef = useRef<string | null>(null)
  const refreshContextKeyRef = useRef<string | null>(null)
  const gitStatusSnapshotInFlightContextRef = useRef<string | null>(null)
  const gitStatusSnapshotRerunContextRef = useRef<string | null>(null)
  const gitStatusSnapshotRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gitIdentityDisplay = activeWorktree ? getWorktreeGitIdentityDisplay(activeWorktree) : null
  const detachedHeadDisplay = gitIdentityDisplay?.kind === 'detached' ? gitIdentityDisplay : null
  const branch = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const activeWorktreePath = activeWorktree?.path ?? null
  const activeWorktreePushTarget = activeWorktree?.pushTarget ?? null
  const activeSourceControlLaunchPlatform = resolveSourceControlLaunchPlatform({
    connectionId: activeConnectionId,
    worktreePath: activeWorktreePath,
    projectRuntime: activeConnectionId
      ? undefined
      : getLocalProjectExecutionRuntimeContext(useAppStore.getState(), activeWorktreeId)
  })
  const runtimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, activeWorktreeId)
  )
  const ownerSettings = useMemo<AppState['settings']>(
    () =>
      !settings
        ? settings
        : runtimeEnvironmentId
          ? { ...settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }
          : { ...settings, activeRuntimeEnvironmentId: null },
    [runtimeEnvironmentId, settings]
  )
  const repoConnectionId = repo?.connectionId?.trim() || null
  const sshConnectionStatus = useAppStore((s) =>
    repoConnectionId ? s.sshConnectionStates.get(repoConnectionId)?.status : undefined
  )
  const panelContextKey = buildChecksPanelGitStatusContextKey({
    repoId: repo?.id,
    worktreeId: activeWorktreeId,
    worktreePath: activeWorktreePath,
    branch,
    linkedGitHubPR: activeWorktree?.linkedPR ?? null,
    linkedGitLabMR: activeWorktree?.linkedGitLabMR ?? null,
    linkedBitbucketPR: activeWorktree?.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: activeWorktree?.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: activeWorktree?.linkedGiteaPR ?? null,
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
  const [prRefreshStateNow, setPrRefreshStateNow] = useState(() => Date.now())
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
    setIsRefreshing(false)
    setEmptyRefreshing(false)
    setConflictDetailsRefreshing(false)
    setPrRefreshStateNow(Date.now())
    createPrInFlightRef.current = null
    setIsCreatingPr(false)
    setCreatePrError(null)
    setIsPublishingBranch(false)
    setAgentComposerState(null)
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
      ? getGitHubPRCacheKey(
          repo.path,
          repo.id,
          branch,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const hostedReviewCacheKey =
    repo && branch
      ? getHostedReviewCacheKey(
          repo.path,
          branch,
          settings,
          repo.id,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const refreshContextKey = `${activeWorktreeId ?? ''}::${prCacheKey}::${branch}`
  if (refreshContextKey !== refreshContextKeyRef.current) {
    refreshContextKeyRef.current = refreshContextKey
    refreshRequestKeyRef.current = null
  }
  const prCacheEntry = prCacheKey ? prCache[prCacheKey] : undefined
  const pr: PRInfo | null = prCacheEntry?.data ?? null
  const hostedReview = useAppStore((s) =>
    hostedReviewCacheKey ? (s.hostedReviewCache[hostedReviewCacheKey]?.data ?? null) : null
  )
  const hasAmbiguousGitHubHostedReview = hasAmbiguousGitHubHostedReviewForChecksPanel({
    hostedReview,
    prCacheEntry,
    prCacheKey
  })
  // Fetch PR data when the active worktree/branch changes.
  // Why: branch lookup is lossy for fork/deleted-head PRs; reuse a known PR
  // number from metadata or the visible cache whenever we have one.
  const linkedPR = activeWorktree?.linkedPR ?? null
  const fallbackGitHubPRNumber = linkedPR == null ? (pr?.number ?? null) : null
  const linkedGitLabMR = activeWorktree?.linkedGitLabMR ?? null
  const linkedBitbucketPR = activeWorktree?.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = activeWorktree?.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = activeWorktree?.linkedGiteaPR ?? null
  const activeReview: ChecksPanelReview | null = selectChecksPanelReview({
    hostedReview,
    pr,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR
  })
  const activeGitLabReview = isGitLabChecksPanelReview(activeReview) ? activeReview : null
  const isGitLabReviewContext = Boolean(activeGitLabReview || linkedGitLabMR !== null)
  const activeConflictReview = activeReview?.mergeable === 'CONFLICTING' ? activeReview : null
  const prRefreshState = useAppStore((s) =>
    prCacheKey ? s.getEffectiveGitHubPRRefreshState(prCacheKey, prRefreshStateNow) : undefined
  )
  const rawPRRefreshState = useAppStore((s) =>
    prCacheKey ? s.prRefreshStates[prCacheKey] : undefined
  )
  const prNumber = pr?.number ?? null

  useEffect(() => {
    const expiryAt = getGitHubPRRefreshStateExpiryAt(rawPRRefreshState)
    if (!prCacheKey || expiryAt === null) {
      return
    }
    const timeout = window.setTimeout(
      () => {
        setPrRefreshStateNow(Date.now())
        const storeState = useAppStore.getState()
        const rawState = storeState.prRefreshStates[prCacheKey]
        const token = buildGitHubPRRefreshStateClearToken(
          rawState,
          storeState.prRefreshSequences,
          prCacheKey
        )
        if (!token) {
          return
        }
        // Why: time alone does not publish Zustand updates; this timeout clears
        // abandoned active refresh UI without treating expiry as no-PR evidence.
        recordChecksPanelPRRefreshBreadcrumb({
          event: 'stale_cleared',
          provider: 'github',
          repoId: repo?.id,
          worktreeId: activeWorktreeId,
          branch,
          prCacheKey,
          prNumber,
          prState: pr?.state,
          prChecksStatus: pr?.checksStatus,
          refreshState: rawState
        })
        storeState.expireGitHubPRRefreshState(prCacheKey, token)
      },
      Math.max(0, expiryAt - Date.now() + 1)
    )
    return () => window.clearTimeout(timeout)
  }, [
    activeWorktreeId,
    branch,
    pr?.checksStatus,
    pr?.state,
    prCacheKey,
    prNumber,
    rawPRRefreshState,
    repo?.id
  ])

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
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const commentsCacheKey =
    repo && prNumber
      ? getGitHubRepoCacheKey(
          repo.path,
          repo.id,
          prCommentsCacheSuffix(prNumber, pr?.prRepo),
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
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
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR
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
  const hostedReviewCreateProvider = resolveHostedReviewCreationProvider(
    hostedReviewCreation?.provider
  )
  const hostedReviewCreateCopy = localizedHostedReviewCopy(hostedReviewCreateProvider)
  const activePullRequestGenerationKey = getPullRequestGenerationRecordKey({
    worktreeId: activeWorktreeId,
    worktreePath: activeWorktreePath,
    repoId: repo?.id,
    branch
  })
  const activePullRequestGenerationRecordCandidate = activePullRequestGenerationKey
    ? (prGenerationRecords[activePullRequestGenerationKey] ?? null)
    : null
  const activePullRequestGenerationRecord =
    activePullRequestGenerationRecordCandidate &&
    activePullRequestGenerationRecordCandidate.context.repoId === repo?.id &&
    activePullRequestGenerationRecordCandidate.context.branch === branch
      ? activePullRequestGenerationRecordCandidate
      : null
  const activePullRequestGenerationSeedRestoreKey = getPullRequestGenerationSeedRestoreKey({
    recordKey: activePullRequestGenerationKey,
    record: activePullRequestGenerationRecord
  })
  const createPrPushFirst = activePullRequestGenerationRecord?.requiresPushBeforeCreate === true
  const handleBranchChangedByPullRequestGeneration = useCallback(
    async (generationKey: string, context: PullRequestGenerationContext): Promise<void> => {
      if (!context.worktreeId || !context.worktreePath) {
        return
      }
      // Why: AI PR detail generation can rebase before summarizing; persist the
      // push requirement because ChecksPanel unmounts when users leave the tab.
      updatePullRequestGenerationRecord(generationKey, (record) =>
        markPullRequestGenerationRequiresPushBeforeCreate({
          record,
          requestId: context.requestId
        })
      )
      try {
        await fetchUpstreamStatus(
          context.worktreeId,
          context.worktreePath,
          context.connectionId,
          undefined,
          {
            runtimeTargetSettings: context.runtimeTargetSettings
          }
        )
      } catch (error) {
        console.warn('[ChecksPanel] post-generation upstream refresh failed', error)
      }
    },
    [fetchUpstreamStatus, updatePullRequestGenerationRecord]
  )
  const prCreationDefaults = useMemo(() => {
    if (!settings) {
      return DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    }
    const hostKey = getCommitMessageModelDiscoveryHostKeyForScope(
      getRuntimeGitScope(settings, repo?.connectionId)
    )
    const resolved = resolveSourceControlAiForOperation({
      settings,
      repo,
      operation: 'pullRequest',
      discoveryHostKey: hostKey,
      prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    })
    return resolved.ok
      ? resolved.value.prCreationDefaults
      : resolveSourceControlAiPrCreationDefaults({
          settings,
          repo,
          prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
        })
  }, [repo, settings])
  const sourceControlAiActionsVisible = useMemo(
    () => (settings ? resolveSourceControlAiEnabled({ settings, repo }) : false),
    [repo, settings]
  )
  const createComposerOpen =
    !activeReview &&
    !isFolder &&
    Boolean(branch) &&
    (hostedReviewCreation?.canCreate === true ||
      hostedReviewCreation?.blockedReason === 'needs_push')
  const handleGeneratePullRequestFieldsForActive = useCallback(
    async (
      fields: PullRequestGenerationFields,
      fieldRevisions: PullRequestFieldRevisions,
      overrides?: RuntimeGeneratePullRequestFieldsOverrides
    ): Promise<void> => {
      if (!repo || !activePullRequestGenerationKey || !activeWorktreePath || !branch) {
        return
      }
      const generationKey = activePullRequestGenerationKey
      if (
        useAppStore.getState().pullRequestGenerationRecords[generationKey]?.status === 'running'
      ) {
        return
      }
      const requestId = allocatePullRequestGenerationRequestId()
      const context: PullRequestGenerationContext = {
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        connectionId: getConnectionId(activeWorktreeId) ?? undefined,
        requestId,
        repoId: repo.id,
        branch,
        runtimeTargetSettings: ownerSettings
      }
      const seed = { ...fields }
      const previousRequiresPushBeforeCreate =
        useAppStore.getState().pullRequestGenerationRecords[generationKey]
          ?.requiresPushBeforeCreate === true
      // Why: ChecksPanel unsets the create composer when the user navigates
      // away; persist the request so generation can finish in the background.
      const runningRecord = createRunningPullRequestGenerationRecord(context, seed, fieldRevisions)
      setPullRequestGenerationRecord(
        generationKey,
        previousRequiresPushBeforeCreate
          ? { ...runningRecord, requiresPushBeforeCreate: true }
          : runningRecord
      )

      try {
        const result = await generateRuntimePullRequestFields(
          {
            // Why: route generation by the worktree owner captured at click time.
            settings: context.runtimeTargetSettings,
            worktreeId: context.worktreeId,
            worktreePath: context.worktreePath,
            connectionId: context.connectionId
          },
          {
            base: stripBaseRef(seed.base.trim()),
            title: seed.title,
            body: seed.body,
            draft: seed.draft,
            provider: hostedReviewCreateProvider,
            useTemplate: prCreationDefaults.useTemplate
          },
          overrides
        )
        if (result.branchChangedByPreparation) {
          await handleBranchChangedByPullRequestGeneration(generationKey, context)
        }
        if (result.success) {
          useAppStore.getState().recordFeatureInteraction('ai-pr-generation')
        }
        updatePullRequestGenerationRecord(generationKey, (record) => {
          if (!result.success) {
            return resolvePullRequestGenerationFailure({
              record,
              requestId,
              canceled: result.canceled,
              error: result.canceled ? null : result.error
            })
          }
          return resolvePullRequestGenerationSuccess({
            record,
            requestId,
            result: {
              base: stripBaseRef(result.fields.base),
              title: result.fields.title,
              body: result.fields.body,
              draft: result.fields.draft
            }
          })
        })
      } catch (error) {
        updatePullRequestGenerationRecord(generationKey, (record) =>
          resolvePullRequestGenerationFailure({
            record,
            requestId,
            error:
              error instanceof Error ? error.message : 'Failed to generate pull request details'
          })
        )
      }
    },
    [
      activePullRequestGenerationKey,
      activeWorktreeId,
      activeWorktreePath,
      allocatePullRequestGenerationRequestId,
      branch,
      handleBranchChangedByPullRequestGeneration,
      hostedReviewCreateProvider,
      ownerSettings,
      prCreationDefaults.useTemplate,
      repo,
      setPullRequestGenerationRecord,
      updatePullRequestGenerationRecord
    ]
  )
  const handleCancelGeneratePullRequestFieldsForActive = useCallback((): void => {
    if (!activePullRequestGenerationKey) {
      return
    }
    const record = prGenerationRecords[activePullRequestGenerationKey]
    if (!record || record.status !== 'running') {
      return
    }
    const generationKey = activePullRequestGenerationKey
    updatePullRequestGenerationRecord(generationKey, (current) => {
      if (!current || current.context.requestId !== record.context.requestId) {
        return null
      }
      return resolvePullRequestGenerationCancel(current)
    })
    void cancelRuntimeGeneratePullRequestFields({
      // Why: Stop must target the request owner, not the currently focused worktree.
      settings: record.context.runtimeTargetSettings,
      worktreeId: record.context.worktreeId,
      worktreePath: record.context.worktreePath,
      connectionId: record.context.connectionId
    }).catch((error) => {
      updatePullRequestGenerationRecord(generationKey, (current) => {
        if (!current || current.context.requestId !== record.context.requestId) {
          return null
        }
        return {
          ...current,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Failed to stop pull request generation',
          hydrated: false
        }
      })
    })
  }, [activePullRequestGenerationKey, prGenerationRecords, updatePullRequestGenerationRecord])
  const handlePullRequestGenerationSeedRestored = useCallback((): void => {
    if (!activePullRequestGenerationKey || !activePullRequestGenerationRecord) {
      return
    }
    const requestId = activePullRequestGenerationRecord.context.requestId
    updatePullRequestGenerationRecord(activePullRequestGenerationKey, (record) =>
      markPullRequestGenerationTerminalSeedRestored({
        record,
        requestId
      })
    )
  }, [
    activePullRequestGenerationKey,
    activePullRequestGenerationRecord,
    updatePullRequestGenerationRecord
  ])
  const {
    aiGenerationEnabled: prAiGenerationEnabled,
    base: prBase,
    setBase: setPrBase,
    title: prTitle,
    setTitle: setPrTitle,
    body: prBody,
    setBody: setPrBody,
    draft: prDraft,
    setDraft: setPrDraft,
    baseQuery: prBaseQuery,
    setBaseQuery: setPrBaseQuery,
    baseResults: prBaseResults,
    setBaseResults: setPrBaseResults,
    baseSearchError: prBaseSearchError,
    generating: prGenerating,
    generateError: prGenerateError,
    generateDisabled: prGenerateDisabled,
    generateDisabledReason: prGenerateDisabledReason,
    handleGenerate: handleGeneratePullRequestFields,
    handleCancelGenerate: handleCancelGeneratePullRequestFields,
    applyGeneratedFields: applyGeneratedPullRequestFields,
    initializedFromEligibility: pullRequestFieldsInitialized
  } = useCreatePullRequestDialogFields({
    open: createComposerOpen,
    repoId: repo?.id ?? '',
    worktreeId: activeWorktreeId,
    worktreePath: activeWorktreePath ?? '',
    branch,
    eligibility: hostedReviewCreation,
    repo,
    settings: ownerSettings,
    submitting: isCreatingPr,
    prCreationDefaults,
    sourceControlAiActionsVisible,
    generation: {
      generating: activePullRequestGenerationRecord?.status === 'running',
      generateError: activePullRequestGenerationRecord?.error ?? null,
      seedRestoreKey: activePullRequestGenerationSeedRestoreKey,
      seed: activePullRequestGenerationRecord?.seed ?? null,
      seedFieldRevisions: activePullRequestGenerationRecord?.seedFieldRevisions ?? null,
      onSeedRestored: handlePullRequestGenerationSeedRestored,
      onGenerate: (fields, fieldRevisions, overrides) => {
        void handleGeneratePullRequestFieldsForActive(fields, fieldRevisions, overrides)
      },
      onCancelGenerate: handleCancelGeneratePullRequestFieldsForActive
    }
  })
  useEffect(() => {
    // Why: checks-panel PR generation can finish while this composer is hidden
    // by a worktree switch; hydrate once the original composer is visible again.
    if (
      !activePullRequestGenerationKey ||
      !activePullRequestGenerationRecord ||
      activePullRequestGenerationRecord.status !== 'succeeded' ||
      !activePullRequestGenerationRecord.result ||
      activePullRequestGenerationRecord.hydrated ||
      !pullRequestFieldsInitialized
    ) {
      return
    }
    if (
      !shouldHydratePullRequestGenerationResult({
        record: activePullRequestGenerationRecord
      })
    ) {
      return
    }
    applyGeneratedPullRequestFields(
      activePullRequestGenerationRecord.result,
      activePullRequestGenerationRecord.seedFieldRevisions
    )
    updatePullRequestGenerationRecord(activePullRequestGenerationKey, (record) => {
      if (
        !record ||
        record.context.requestId !== activePullRequestGenerationRecord.context.requestId
      ) {
        return null
      }
      return {
        ...record,
        hydrated: true
      }
    })
  }, [
    activePullRequestGenerationKey,
    activePullRequestGenerationRecord,
    applyGeneratedPullRequestFields,
    pullRequestFieldsInitialized,
    updatePullRequestGenerationRecord
  ])
  const handlePrBaseChange = useCallback(
    (value: string): void => {
      setCreatePrError(null)
      setPrBase(value)
    },
    [setPrBase]
  )
  const handlePrTitleChange = useCallback(
    (value: string): void => {
      setCreatePrError(null)
      setPrTitle(value)
    },
    [setPrTitle]
  )
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
    if (
      agentComposerState?.commentResolution &&
      agentComposerState.commentResolution.reviewContextKey !== stateRequestKey
    ) {
      setAgentComposerState(null)
    }
  }, [agentComposerState?.commentResolution, stateRequestKey])

  useEffect(() => {
    if (isPanelVisible && repo && !isFolder && branch) {
      void fetchHostedReviewForBranch(repo.path, branch, {
        repoId: repo.id,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR,
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
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
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
    const connectionId = activeConnectionId ?? undefined
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
      settings: ownerSettings,
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
    activeConnectionId,
    branch,
    gitStatusInvalidation,
    gitStatusRefreshNonce,
    isFolder,
    isPanelVisible,
    ownerSettings,
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
      repoId: repo.id,
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
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR
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
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
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
      worktreeId: activeWorktreeId ?? undefined,
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
    const refreshStartedAt = Date.now()
    const refreshProvider = isGitLabReviewContext ? 'gitlab' : 'github'
    let refreshOutcome = 'started'
    setIsRefreshing(true)
    setGitStatusRefreshNonce((value) => value + 1)
    recordChecksPanelPRRefreshBreadcrumb({
      event: 'start',
      provider: refreshProvider,
      repoId: repo.id,
      worktreeId: activeWorktreeId,
      branch,
      prCacheKey,
      prNumber: activeGitLabReview?.number ?? prNumber,
      prState: activeGitLabReview?.state ?? pr?.state,
      prChecksStatus: pr?.checksStatus,
      refreshState: prCacheKey ? useAppStore.getState().prRefreshStates[prCacheKey] : null
    })
    try {
      if (isGitLabReviewContext) {
        const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
          repoPath: repo.path,
          repoId: repo.id,
          branch,
          linkedGitHubPR: linkedPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR
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
          refreshOutcome = 'review'
        } else {
          setChecks([])
          setComments([])
          refreshOutcome = 'no-review'
        }
        return
      }
      const refreshStoreState = useAppStore.getState()
      const rawPRRefreshState = refreshStoreState.prRefreshStates[prCacheKey]
      const startedPRRefreshToken = buildGitHubPRRefreshStateClearToken(
        rawPRRefreshState,
        refreshStoreState.prRefreshSequences,
        prCacheKey
      )
      let refreshedPR: PRInfo | null = null
      try {
        refreshedPR = await fetchPRForBranch(repo.path, branch, {
          force: true,
          repoId: repo.id,
          worktreeId: activeWorktreeId ?? undefined,
          linkedPRNumber: linkedPR,
          fallbackPRNumber: fallbackGitHubPRNumber
        })
      } finally {
        if (startedPRRefreshToken) {
          expireGitHubPRRefreshState(prCacheKey, startedPRRefreshToken)
        }
      }
      if (!isCurrentRequest()) {
        return
      }
      await refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: refreshedPR?.number ?? fallbackGitHubPRNumber,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR
      })
      if (!isCurrentRequest()) {
        return
      }
      if (refreshedPR) {
        refreshOutcome = 'pr'
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
        refreshOutcome = 'no-pr'
      }
    } catch (error) {
      refreshOutcome = 'error'
      throw error
    } finally {
      recordChecksPanelPRRefreshBreadcrumb({
        event: 'done',
        provider: refreshProvider,
        repoId: repo.id,
        worktreeId: activeWorktreeId,
        branch,
        prCacheKey,
        prNumber: activeGitLabReview?.number ?? prNumber,
        prState: activeGitLabReview?.state ?? pr?.state,
        prChecksStatus: pr?.checksStatus,
        refreshState: prCacheKey ? useAppStore.getState().prRefreshStates[prCacheKey] : null,
        outcome: refreshOutcome,
        durationMs: Date.now() - refreshStartedAt,
        currentRequest: isCurrentRequest()
      })
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
    pr?.checksStatus,
    pr?.headSha,
    pr?.prRepo,
    pr?.state,
    prCacheKey,
    linkedPR,
    fallbackGitHubPRNumber,
    fetchGitLabDetails,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    isGitLabReviewContext,
    fetchPRForBranch,
    fetchPRChecks,
    fetchPRComments,
    fetchHostedReviewForBranch,
    expireGitHubPRRefreshState,
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
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR
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
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
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
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR
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
      worktreeId: activeWorktreeId ?? undefined,
      linkedPRNumber: linkedPR,
      fallbackPRNumber: fallbackGitHubPRNumber
    })
    await refreshHostedReviewCard(fetchHostedReviewForBranch, {
      repoPath: repo.path,
      repoId: repo.id,
      branch,
      linkedGitHubPR: linkedPR,
      fallbackGitHubPR: refreshedPR?.number ?? fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR
    })
  }, [
    activeGitLabReview,
    activeReview?.provider,
    activeWorktreeId,
    branch,
    fallbackGitHubPRNumber,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    fetchPRForBranch,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
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
          repoId: repo.id,
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
    async (
      threadId: string,
      resolve: boolean,
      options: { notifyOnFailure?: boolean } = {}
    ): Promise<boolean> => {
      const notifyOnFailure = options.notifyOnFailure !== false
      const rollbackThread = (previousThreadComments: PRComment[]): void => {
        setComments((prev) => restorePRCommentThreadSnapshot(prev, previousThreadComments))
      }
      if (repo && activeGitLabReview) {
        let previousThreadComments: PRComment[] = []
        setComments((prev) => {
          previousThreadComments = prev.filter((comment) => comment.threadId === threadId)
          return markPRCommentThreadResolved(prev, threadId, resolve)
        })
        const result = await resolveGitLabMRDiscussionForChecks({
          repoPath: repo.path,
          repoId: repo.id,
          settings,
          iid: activeGitLabReview.number,
          discussionId: threadId,
          resolved: resolve
        })
        if (!result.ok) {
          rollbackThread(previousThreadComments)
          if (notifyOnFailure) {
            toast.error(result.error)
          }
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
      let previousThreadComments: PRComment[] = []
      setComments((prev) => {
        previousThreadComments = prev.filter((comment) => comment.threadId === threadId)
        return markPRCommentThreadResolved(prev, threadId, resolve)
      })
      const ok = await resolveReviewThread(repo.path, prNumber, threadId, resolve, {
        repoId: repo.id,
        prRepo: pr?.prRepo
      })
      if (!isCurrentAsyncResult(requestKey)) {
        return ok
      }
      if (!ok) {
        rollbackThread(previousThreadComments)
        if (notifyOnFailure) {
          toast.error(
            translate(
              'auto.components.right.sidebar.ChecksPanel.5788d1059d',
              'Could not update review thread. Check the GitHub API budget.'
            )
          )
        }
      }
      return ok
    },
    [
      activeGitLabReview,
      branch,
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
    : noEnabledAgentKnown
      ? 'No enabled AI agents. Configure agents in Settings.'
      : undefined
  useEffect(() => {
    if (!sourceControlAiActionsVisible) {
      setAgentComposerState(null)
    }
  }, [sourceControlAiActionsVisible])
  const resolveCommentsWithAIDisabledReason = commentsLoading
    ? 'Comments are still loading.'
    : aiActionDisabledReason
      ? aiActionDisabledReason
      : !activeReview
        ? 'Open a PR or MR before launching an AI action.'
        : !repo
          ? 'Select a repository before launching an AI action.'
          : activeReview.provider === 'github' && !prNumber
            ? 'Open a GitHub PR before resolving comments.'
            : activeReview.provider === 'gitlab' && !activeGitLabReview
              ? 'Open a GitLab MR before resolving comments.'
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

  const handleEditComment = useCallback(
    async (comment: PRComment, body: string): Promise<boolean> => {
      if (!pr?.prRepo || !isMutablePRConversationComment(comment)) {
        return false
      }
      const result = await window.api.gh.updateIssueCommentBySlug({
        owner: pr.prRepo.owner,
        repo: pr.prRepo.repo,
        commentId: comment.id,
        body
      })
      if (!result.ok) {
        toast.error(result.error.message)
        return false
      }
      setComments((prev) =>
        prev.map((entry) => (entry.id === comment.id ? { ...entry, body } : entry))
      )
      return true
    },
    [pr?.prRepo]
  )

  const handleDeleteComment = useCallback(
    async (comment: PRComment): Promise<void> => {
      if (!pr?.prRepo || !isMutablePRConversationComment(comment)) {
        return
      }
      const confirmed = await confirm({
        title: translate('auto.components.right.sidebar.ChecksPanel.ea9b649ce3', 'Delete comment?'),
        description: translate(
          'auto.components.right.sidebar.ChecksPanel.3b203c62f8',
          'This will permanently remove the comment from the PR.'
        ),
        confirmLabel: translate('auto.components.right.sidebar.ChecksPanel.786e3c143f', 'Delete'),
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }
      const result = await window.api.gh.deleteIssueCommentBySlug({
        owner: pr.prRepo.owner,
        repo: pr.prRepo.repo,
        commentId: comment.id
      })
      if (!result.ok) {
        toast.error(result.error.message)
        return
      }
      setComments((prev) => prev.filter((entry) => entry.id !== comment.id))
    },
    [pr?.prRepo, confirm]
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
    if (!sourceControlAiActionsVisible || !activeWorktreeId || !activeConflictReview) {
      return
    }
    const conflictFiles = activeConflictReview.conflictSummary?.files ?? []
    setAgentComposerState({
      actionId: 'resolveConflicts',
      title: translate(
        'auto.components.right.sidebar.ChecksPanel.4ede779461',
        'Resolve Review Conflicts With AI'
      ),
      description: translate(
        'auto.components.right.sidebar.ChecksPanel.abf59262fb',
        'Review and edit the full command input before starting an agent.'
      ),
      prompt: buildResolvePullRequestConflictsPrompt({
        reviewKind: activeConflictReview.provider === 'gitlab' ? 'MR' : 'PR',
        baseRef: activeConflictReview.conflictSummary?.baseRef,
        entries: conflictFiles.map((path) => ({ path })),
        worktreePath: activeWorktreePath ?? null
      }),
      launchSource: 'conflict_resolution'
    })
  }, [activeConflictReview, activeWorktreeId, activeWorktreePath, sourceControlAiActionsVisible])

  const handleResolveCommentsWithAI = useCallback(
    (selectedGroups: PRCommentGroup[]): void => {
      if (
        !sourceControlAiActionsVisible ||
        !activeWorktreeId ||
        !activeReview ||
        !repo ||
        resolveCommentsWithAIDisabledReason
      ) {
        return
      }
      const selectedThreadIds = selectedGroups.flatMap((group) =>
        group.kind === 'thread' && isResolvablePRCommentGroup(group) ? [group.threadId] : []
      )
      if (selectedGroups.length === 0) {
        toast.message(
          translate(
            'auto.components.right.sidebar.ChecksPanel.f316a8ca2b',
            'No unresolved comments selected.'
          )
        )
        return
      }
      setAgentComposerState({
        actionId: 'resolveComments',
        title: translate(
          'auto.components.right.sidebar.ChecksPanel.d00ebdc402',
          'Resolve {{value0}} Comments With AI',
          { value0: activeReview.provider === 'gitlab' ? 'MR' : 'PR' }
        ),
        description: translate(
          'auto.components.right.sidebar.ChecksPanel.ed3f79c031',
          'Review the prompt before starting an agent. Selected threads are marked resolved after launch.'
        ),
        prompt: buildPRCommentsResolutionPrompt({
          reviewKind: activeReview.provider === 'gitlab' ? 'MR' : 'PR',
          reviewNumber: activeReview.number,
          reviewTitle: activeReview.title,
          reviewUrl: activeReview.url,
          groups: selectedGroups,
          worktreePath: activeWorktreePath
        }),
        launchSource: 'task_page',
        commentResolution: {
          reviewContextKey: stateRequestKey,
          provider: activeReview.provider,
          selectedThreadIds,
          selectedGroups
        }
      })
    },
    [
      activeReview,
      activeWorktreeId,
      activeWorktreePath,
      repo,
      resolveCommentsWithAIDisabledReason,
      sourceControlAiActionsVisible,
      stateRequestKey
    ]
  )

  const refreshCommentsAfterBulkResolve = useCallback(
    async (provider: ChecksPanelReview['provider']): Promise<void> => {
      if (provider === 'gitlab') {
        await fetchGitLabDetails({ commitAsCurrent: true })
        return
      }
      await fetchComments({ force: true })
    },
    [fetchComments, fetchGitLabDetails]
  )

  const resolveSelectedThreadsAfterLaunch = useCallback(
    async (resolution: NonNullable<ChecksAgentComposerState['commentResolution']>) => {
      let resolved = 0
      let skipped = 0
      let failed = 0
      if (resolution.selectedThreadIds.length === 0) {
        toast.success(
          translate(
            'auto.components.right.sidebar.ChecksPanel.3c3ad3a1d2',
            'Started the agent. No selected comments can be marked resolved on the host.'
          )
        )
        return
      }
      for (const threadId of resolution.selectedThreadIds) {
        if (asyncResultKeyRef.current !== resolution.reviewContextKey) {
          skipped += resolution.selectedThreadIds.length - resolved - skipped - failed
          break
        }
        const currentGroup = groupPRComments(commentsRef.current).find(
          (group) => group.kind === 'thread' && group.threadId === threadId
        )
        if (!currentGroup || !isResolvablePRCommentGroup(currentGroup)) {
          skipped += 1
          continue
        }
        const ok = await handleResolve(threadId, true, { notifyOnFailure: false })
        if (ok) {
          resolved += 1
        } else {
          failed += 1
        }
      }

      if (asyncResultKeyRef.current === resolution.reviewContextKey) {
        await refreshCommentsAfterBulkResolve(resolution.provider)
      }

      if (failed > 0) {
        toast.error(
          translate(
            'auto.components.right.sidebar.ChecksPanel.f273f2271c',
            'Started the agent. Marked {{value0}} resolved, skipped {{value1}}, failed {{value2}}.',
            { value0: resolved, value1: skipped, value2: failed }
          )
        )
        return
      }
      toast.success(
        translate(
          'auto.components.right.sidebar.ChecksPanel.aa95b81a3a',
          'Started the agent. Marked {{value0}} resolved, skipped {{value1}}, failed {{value2}}.',
          { value0: resolved, value1: skipped, value2: failed }
        )
      )
    },
    [handleResolve, refreshCommentsAfterBulkResolve]
  )

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
    sourceControlAiActionsVisible,
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
      repo
    ]
  )

  // Open hosted review in browser
  const handleOpenPR = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (activeReview?.url) {
        // Why: route through openHttpLink so PR/MR links honor the "open links
        // in app" setting; Shift+Cmd/Ctrl keeps the terminal-link escape hatch.
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
    const connectionId = activeConnectionId ?? undefined
    try {
      await pushBranch(
        activeWorktreeId,
        activeWorktree.path,
        false,
        connectionId,
        activeWorktree.pushTarget,
        { runtimeTargetSettings: ownerSettings }
      )
      await fetchUpstreamStatus(activeWorktreeId, activeWorktree.path, connectionId, undefined, {
        runtimeTargetSettings: ownerSettings
      })
      return true
    } catch {
      return false
    }
  }, [
    activeConnectionId,
    activeWorktree,
    activeWorktreeId,
    fetchUpstreamStatus,
    ownerSettings,
    pushBranch
  ])

  const handlePublishBranch = useCallback(async (): Promise<void> => {
    if (
      !activeWorktreeId ||
      !activeWorktree?.path ||
      isPublishingBranch ||
      isRemoteOperationActive
    ) {
      return
    }
    const connectionId = activeConnectionId ?? undefined
    setIsPublishingBranch(true)
    try {
      await pushBranch(
        activeWorktreeId,
        activeWorktree.path,
        true,
        connectionId,
        activeWorktree.pushTarget,
        { runtimeTargetSettings: ownerSettings }
      )
      await fetchUpstreamStatus(
        activeWorktreeId,
        activeWorktree.path,
        connectionId,
        activeWorktree.pushTarget,
        { runtimeTargetSettings: ownerSettings }
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
    activeConnectionId,
    fetchUpstreamStatus,
    isPublishingBranch,
    isRemoteOperationActive,
    ownerSettings,
    pushBranch
  ])

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
        if (activeWorktreeId && result.provider === 'azure-devops') {
          await updateWorktreeMeta(activeWorktreeId, { linkedAzureDevOpsPR: result.number })
        }
        if (activeWorktreeId && result.provider === 'gitea') {
          await updateWorktreeMeta(activeWorktreeId, { linkedGiteaPR: result.number })
        }
        const linkedReviewNumbers = {
          linkedGitHubPR: result.provider === 'github' ? result.number : linkedPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR: result.provider === 'gitlab' ? result.number : linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR:
            result.provider === 'azure-devops' ? result.number : linkedAzureDevOpsPR,
          linkedGiteaPR: result.provider === 'gitea' ? result.number : linkedGiteaPR
        }
        if (result.provider === 'gitlab') {
          const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
            repoPath: repo.path,
            repoId: repo.id,
            branch,
            ...linkedReviewNumbers
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
        if (result.provider !== 'github') {
          await refreshHostedReviewCard(fetchHostedReviewForBranch, {
            repoPath: repo.path,
            repoId: repo.id,
            branch,
            ...linkedReviewNumbers
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
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
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

  const handleCreatePullRequest = useCallback(async (): Promise<void> => {
    if (!repo || !branch || !createComposerOpen || prGenerating || createPrInFlightRef.current) {
      return
    }

    const requestContextKey = panelContextKey
    const isCurrentCreateRequest = (): boolean =>
      panelContextKeyRef.current === requestContextKey &&
      createPrInFlightRef.current === requestContextKey
    const base = stripBaseRef(prBase).trim()
    const title = prTitle.trim()
    const worktreePath = activeWorktreePath ?? repo.path
    if (!title) {
      setCreatePrError(
        translate(
          'auto.components.right.sidebar.SourceControl.f3a8b2c1d0e5',
          'Enter a {{value0}} title.',
          {
            value0: hostedReviewCreateCopy.reviewLabel
          }
        )
      )
      return
    }
    if (!base || stripBaseRef(base).toLowerCase() === stripBaseRef(branch).toLowerCase()) {
      setCreatePrError(
        translate(
          'auto.components.right.sidebar.SourceControl.ae743199cd',
          'Choose a different base branch before creating a {{value0}}.',
          { value0: hostedReviewCreateCopy.reviewLabel }
        )
      )
      return
    }

    createPrInFlightRef.current = requestContextKey
    setIsCreatingPr(true)
    setCreatePrError(null)
    let pushed = false
    try {
      const shouldPushBeforeCreate =
        createPrPushFirst || hostedReviewCreation?.blockedReason === 'needs_push'
      if (shouldPushBeforeCreate) {
        const ok = await pushBeforeCreatePullRequest()
        if (!isCurrentCreateRequest()) {
          return
        }
        if (!ok) {
          setCreatePrError('Push failed. Resolve the push error, then try again.')
          return
        }
        pushed = true
      }
      const result = await createHostedReview(repo.path, {
        repoId: repo.id,
        provider: hostedReviewCreateProvider,
        base,
        head: normalizeHostedReviewHeadRef(branch),
        title,
        body: prBody,
        draft: prDraft,
        worktreePath,
        useTemplate: prCreationDefaults.useTemplate
      })
      if (!isCurrentCreateRequest()) {
        return
      }
      if (result.ok) {
        await handlePullRequestCreated({
          provider: hostedReviewCreateProvider,
          number: result.number,
          url: result.url
        })
        if (prCreationDefaults.openAfterCreate) {
          openHttpLink(result.url, { worktreeId: activeWorktreeId })
        }
        if (activePullRequestGenerationKey) {
          updatePullRequestGenerationRecord(
            activePullRequestGenerationKey,
            clearPullRequestGenerationRequiresPushBeforeCreate
          )
        }
        return
      }
      if (result.existingReview?.url) {
        const number = result.existingReview.number
        toast.success(
          number
            ? translate(
                'auto.components.right.sidebar.ChecksPanel.b6ce28da5b',
                '{{value0}} #{{value1}} is already open',
                { value0: hostedReviewCreateCopy.titleLabel, value1: number }
              )
            : translate(
                'auto.components.right.sidebar.ChecksPanel.cf9e69f3be',
                '{{value0}} is already open',
                { value0: hostedReviewCreateCopy.titleLabel }
              ),
          {
            action: {
              label: translate(
                'auto.components.right.sidebar.ChecksPanel.192e686e57',
                'Open on {{value0}}',
                { value0: hostedReviewCreateCopy.providerName }
              ),
              onClick: () => window.api.shell.openUrl(result.existingReview!.url)
            }
          }
        )
        if (number) {
          await handlePullRequestCreated({
            provider: hostedReviewCreateProvider,
            number,
            url: result.existingReview.url
          })
          if (activePullRequestGenerationKey) {
            updatePullRequestGenerationRecord(
              activePullRequestGenerationKey,
              clearPullRequestGenerationRequiresPushBeforeCreate
            )
          }
          return
        }
      }
      setCreatePrError(formatCreateError(result, pushed, hostedReviewCreateCopy.shortLabel))
    } catch (error) {
      if (!isCurrentCreateRequest()) {
        return
      }
      setCreatePrError(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.right.sidebar.SourceControl.e2b7a1c0d9f4',
              'Failed to create {{value0}}',
              { value0: hostedReviewCreateCopy.reviewLabel }
            )
      )
    } finally {
      if (createPrInFlightRef.current === requestContextKey) {
        createPrInFlightRef.current = null
        setIsCreatingPr(false)
        setGitStatusRefreshNonce((value) => value + 1)
      }
    }
  }, [
    activeWorktreePath,
    activeWorktreeId,
    activePullRequestGenerationKey,
    branch,
    createComposerOpen,
    createHostedReview,
    createPrPushFirst,
    handlePullRequestCreated,
    hostedReviewCreateCopy.providerName,
    hostedReviewCreateCopy.reviewLabel,
    hostedReviewCreateCopy.shortLabel,
    hostedReviewCreateCopy.titleLabel,
    hostedReviewCreateProvider,
    hostedReviewCreation?.blockedReason,
    panelContextKey,
    prBase,
    prBody,
    prCreationDefaults.openAfterCreate,
    prCreationDefaults.useTemplate,
    prDraft,
    prGenerating,
    prTitle,
    pushBeforeCreatePullRequest,
    repo,
    updatePullRequestGenerationRecord
  ])

  // ── Empty state ──
  if (!activeWorktree) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.right.sidebar.ChecksPanel.a4ef4e0832',
            'No workspace selected'
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.ChecksPanel.b5dd73a105',
            'Select a workspace to view checks'
          )}
        </div>
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">
          {translate('auto.components.right.sidebar.ChecksPanel.976cefd02f', 'Checks unavailable')}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.ChecksPanel.dda5924a40',
            'Checks require a Git branch and hosted review context'
          )}
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
    const canPushCreate = hostedReviewCreation?.blockedReason === 'needs_push'
    const shouldPushBeforeCreateReview = createPrPushFirst || canPushCreate
    const canPublishBranch =
      isPublishingBranch ||
      (!publishActionHasUncommittedChanges &&
        shouldShowChecksPanelPublishBranchAction({
          hostedReviewBlockedReason: hostedReviewCreation?.blockedReason,
          hasUpstream: publishActionRemoteStatus?.hasUpstream,
          hasCurrentBranch: Boolean(branch)
        }))
    const emptyStateCopy = getChecksPanelEmptyStateCopy({
      operationLabel,
      prRefreshStatus: emptyReviewIsGitLab ? undefined : prRefreshState?.status,
      hostedReviewBlockedReason: hostedReviewCreation?.blockedReason,
      hasUpstream: publishActionRemoteStatus?.hasUpstream,
      hasCurrentBranch: Boolean(branch),
      reviewLabel: emptyReviewLabel,
      reviewShortLabel: emptyReviewShortLabel,
      hasAmbiguousGitHubHostedReview
    })
    return (
      <div className="px-4 py-6">
        {detachedHeadDisplay && (
          <div className="mb-3">
            <DetachedHeadBadge display={detachedHeadDisplay} side="bottom" />
          </div>
        )}
        <div className="text-sm font-medium text-foreground">{emptyStateCopy.title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{emptyStateCopy.description}</div>
        {!operationInProgress && createComposerOpen ? (
          <div className="mt-4 border-t border-border pt-3">
            <CreateHostedReviewComposer
              className="p-0"
              provider={hostedReviewCreateProvider}
              branch={branch}
              base={prBase}
              setBase={handlePrBaseChange}
              title={prTitle}
              setTitle={handlePrTitleChange}
              body={prBody}
              setBody={setPrBody}
              draft={prDraft}
              setDraft={setPrDraft}
              baseQuery={prBaseQuery}
              setBaseQuery={setPrBaseQuery}
              baseResults={prBaseResults}
              setBaseResults={setPrBaseResults}
              baseSearchError={prBaseSearchError}
              aiGenerationEnabled={sourceControlAiActionsVisible && prAiGenerationEnabled}
              generating={prGenerating}
              generateDisabled={prGenerateDisabled}
              generateDisabledReason={prGenerateDisabledReason}
              generateError={prGenerateError}
              createError={createPrError}
              isCreating={isCreatingPr}
              pushBeforeCreate={shouldPushBeforeCreateReview}
              primaryAction={{
                disabled: isCreatingPr || isPublishingBranch || isRemoteOperationActive,
                title: shouldPushBeforeCreateReview
                  ? translate(
                      'auto.components.right.sidebar.ChecksPanel.98f4c37b33',
                      'Push & Create {{value0}}',
                      { value0: emptyReviewShortLabel }
                    )
                  : translate(
                      'auto.components.right.sidebar.ChecksPanel.889cdfba04',
                      'Create {{value0}}',
                      { value0: emptyReviewShortLabel }
                    )
              }}
              onGenerate={() => void handleGeneratePullRequestFields()}
              onCancelGenerate={handleCancelGeneratePullRequestFields}
              onPrimaryAction={() => void handleCreatePullRequest()}
            />
          </div>
        ) : null}
        {!operationInProgress && (!createComposerOpen || canPublishBranch) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {canPublishBranch && (
              <Button
                size="xs"
                disabled={isPublishingBranch || isRemoteOperationActive}
                onClick={handlePublishBranch}
              >
                {isPublishingBranch
                  ? translate('auto.components.right.sidebar.ChecksPanel.fdb27637f2', 'Publishing…')
                  : translate(
                      'auto.components.right.sidebar.ChecksPanel.6633c7a1fb',
                      'Publish Branch'
                    )}
              </Button>
            )}
            {!createComposerOpen ? (
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
                {emptyRefreshing
                  ? translate('auto.components.right.sidebar.ChecksPanel.71026ca2cb', 'Refreshing…')
                  : translate('auto.components.right.sidebar.ChecksPanel.7f4489f370', 'Refresh')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  const reviewShortLabel = activeReview.provider === 'gitlab' ? 'MR' : 'PR'
  const shouldShowReviewTriageStrip =
    activeConflictReview !== null || getBrokenChecks(checks).length > 0
  // Why: mirror openHttpLink's global routing inputs so the hint only appears
  // when the actual plain-click path would open inside Orca.
  const showHostedReviewSystemBrowserHint =
    Boolean(activeWorktreeId) &&
    settings?.openLinksInApp === true &&
    !settings.activeRuntimeEnvironmentId
  return (
    <div ref={setChecksPanelContentRef} className="flex-1 overflow-auto scrollbar-sleek">
      {/* Hosted review header */}
      <div className="px-3 py-3 border-b border-border space-y-2.5">
        {/* Review number + state badge + refresh + open link */}
        <ChecksPanelReviewHeader
          review={activeReview}
          isRefreshing={isRefreshing}
          canUnlinkPullRequest={linkedPR !== null}
          showSystemBrowserHint={showHostedReviewSystemBrowserHint}
          onRefresh={() => void handleRefresh()}
          onOpenReview={handleOpenPR}
          onUnlinkPullRequest={handleUnlinkPullRequest}
          onLinkAnotherPullRequest={handleLinkAnotherPullRequest}
        />

        {detachedHeadDisplay && <DetachedHeadBadge display={detachedHeadDisplay} side="bottom" />}

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
              title={translate('auto.components.right.sidebar.ChecksPanel.2ab7fd4b6d', 'Save')}
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
              title={translate('auto.components.right.sidebar.ChecksPanel.058039787c', 'Cancel')}
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
            <Pencil className="size-3 text-muted-foreground/40 can-hover:opacity-0 group-hover/title:opacity-100 transition-opacity shrink-0 mt-0.5" />
          </div>
        )}

        {/* Updated at */}
        {activeReview.updatedAt && (
          <ChecksPanelUpdatedAtMetadata
            reviewShortLabel={reviewShortLabel}
            updatedAt={activeReview.updatedAt}
          />
        )}
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

      {shouldShowReviewTriageStrip && sourceControlAiActionsVisible && (
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
        reviewKind={reviewShortLabel}
        commentsDisabled={!canTargetPRComments}
        commentsDisabledReason={commentsDisabledReason}
        selectionContextKey={stateRequestKey}
        resolveCommentsWithAIDisabled={Boolean(resolveCommentsWithAIDisabledReason)}
        resolveCommentsWithAIDisabledReason={resolveCommentsWithAIDisabledReason}
        onAddComment={pr ? handleAddPRComment : undefined}
        onResolveSelectedCommentsWithAI={
          sourceControlAiActionsVisible ? handleResolveCommentsWithAI : undefined
        }
        onReply={pr ? handleReplyToComment : undefined}
        onResolve={pr || activeGitLabReview ? handleResolve : undefined}
        onEditComment={pr ? handleEditComment : undefined}
        onDeleteComment={pr ? handleDeleteComment : undefined}
      />
      <SourceControlAgentActionDialog
        open={sourceControlAiActionsVisible && agentComposerState !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAgentComposerState(null)
          }
        }}
        actionId={agentComposerState?.actionId ?? 'fixChecks'}
        title={
          agentComposerState?.title ??
          translate('auto.components.right.sidebar.ChecksPanel.7fad8509fe', 'Fix With AI')
        }
        description={agentComposerState?.description ?? ''}
        baseCommandInput={agentComposerState?.prompt ?? ''}
        worktreeId={activeWorktreeId}
        groupId={activeWorktreeId}
        connectionId={activeConnectionId}
        repoId={repo?.id ?? null}
        promptDelivery="submit-after-ready"
        launchPlatform={activeSourceControlLaunchPlatform}
        launchSource={agentComposerState?.launchSource ?? 'task_page'}
        savedAgentId={
          agentComposerState
            ? readSourceControlLaunchRecipeAgentId(
                resolveSourceControlActionRecipe({
                  settings,
                  repo,
                  actionId: agentComposerState.actionId
                })
              )
            : null
        }
        savedCommandInputTemplate={
          agentComposerState
            ? (resolveSourceControlActionRecipe({
                settings,
                repo,
                actionId: agentComposerState.actionId
              }).commandInputTemplate ?? null)
            : null
        }
        savedAgentArgs={
          agentComposerState
            ? (resolveSourceControlActionRecipe({
                settings,
                repo,
                actionId: agentComposerState.actionId
              }).agentArgs ?? null)
            : null
        }
        onSaveAgentDefault={saveLaunchActionDefault}
        onLaunched={() => {
          const launchedState = agentComposerState
          if (launchedState?.actionId === 'resolveComments' && launchedState.commentResolution) {
            void resolveSelectedThreadsAfterLaunch(launchedState.commentResolution).catch((err) => {
              console.warn('Failed to resolve selected review comments after AI launch:', err)
              toast.error(
                translate(
                  'auto.components.right.sidebar.ChecksPanel.495b2f8c4b',
                  'Started the agent, but could not mark the selected comments resolved.'
                )
              )
            })
          } else if (launchedState?.actionId === 'resolveConflicts') {
            toast.success(
              translate(
                'auto.components.right.sidebar.ChecksPanel.a0181a8d76',
                'Started an AI agent for the conflicts.'
              )
            )
          } else {
            toast.success(
              translate(
                'auto.components.right.sidebar.ChecksPanel.2ef90c9819',
                'Started an AI agent for the broken checks.'
              )
            )
          }
        }}
      />
    </div>
  )
}
