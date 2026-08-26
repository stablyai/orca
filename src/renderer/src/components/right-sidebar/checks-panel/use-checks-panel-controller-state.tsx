import { useCallback, useMemo, useRef, useState } from 'react'
import { useAppStore, type AppState } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { useChecksPanelTerminalWorktree } from '../use-checks-panel-terminal-worktree'
import { getConnectionId } from '@/lib/connection-context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { normalizeGlobalWindowsRuntimeDefault } from '../../../../../shared/project-execution-runtime'
import {
  saveSourceControlActionRecipe,
  type SourceControlAiWriteTarget
} from '../../../../../shared/source-control-ai-recipe-save'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../../shared/source-control-ai-actions'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { PRRefreshErrorType } from '../../../../../shared/github/pull-request-refresh-types'
import type { GitLabProjectRef } from '../../../../../shared/gitlab-types'
import type { PRCommentsListSelectionClearRequest } from '../pr-comments-list-selection'
import {
  buildChecksPanelGitStatusContextKey,
  type ChecksPanelGitStatusSnapshot
} from '../checks-panel-git-status-snapshot'
import type { ChecksAgentComposerState, HostedReviewCreationSnapshot } from './panel-state-types'

export function useChecksPanelControllerState() {
  // Why: the sidebar stays mounted when closed (perf); gate polling on visibility so we don't fetch checks/comments or poll cwd while hidden.
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const isPanelVisible = rightSidebarOpen && rightSidebarTab === 'checks'

  // Follow the active terminal's cwd so linked-PR/checks track the worktree it's operating in (e.g. across a stack), else the sidebar selection.
  const defaultActiveWorktree = useActiveWorktree()
  const { worktree: activeWorktree } = useChecksPanelTerminalWorktree({
    defaultActiveWorktree,
    isPanelVisible
  })
  const activeWorktreeId = activeWorktree?.id ?? null
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const activeConnectionId = activeWorktreeId
    ? (getConnectionId(activeWorktreeId) ?? repo?.connectionId ?? null)
    : null
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const expireGitHubPRRefreshState = useAppStore((s) => s.expireGitHubPRRefreshState)
  const getHostedReviewCreationEligibility = useAppStore(
    (s) => s.getHostedReviewCreationEligibility
  )
  const createHostedReview = useAppStore((s) => s.createHostedReview)
  const createStackedHostedReview = useAppStore((s) => s.createStackedHostedReview)
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
  const syncBranch = useAppStore((s) => s.syncBranch)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const openModal = useAppStore((s) => s.openModal)

  const fetchPRChecks = useAppStore((s) => s.fetchPRChecks)
  const fetchPRCheckDetails = useAppStore((s) => s.fetchPRCheckDetails)
  const fetchPRComments = useAppStore((s) => s.fetchPRComments)
  const addPRConversationComment = useAppStore((s) => s.addPRConversationComment)
  const addPRReviewCommentReply = useAppStore((s) => s.addPRReviewCommentReply)
  const setPRCommentReaction = useAppStore((s) => s.setPRCommentReaction)
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
  const [commentsSelectionClearRequest, setCommentsSelectionClearRequest] =
    useState<PRCommentsListSelectionClearRequest | null>(null)
  const commentsSelectionClearTokenRef = useRef(0)
  const [emptyRefreshing, setEmptyRefreshing] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const refreshInFlightRef = useRef(false)
  const [conflictDetailsRefreshing, setConflictDetailsRefreshing] = useState(false)
  const createPrInFlightRef = useRef<string | null>(null)
  const [isCreatingPr, setIsCreatingPr] = useState(false)
  const [createPrError, setCreatePrError] = useState<string | null>(null)
  const [isPublishingBranch, setIsPublishingBranch] = useState(false)
  const [isSyncingBranch, setIsSyncingBranch] = useState(false)
  const isResolvingConflictsWithAI = false
  const [isFixingChecksWithAI, setIsFixingChecksWithAI] = useState(false)
  const [agentComposerState, setAgentComposerState] = useState<ChecksAgentComposerState | null>(
    null
  )
  // Why: submit-after-ready outlives dialog close; keep the payload until launch is accepted.
  const pendingCommentResolutionRef = useRef<NonNullable<
    ChecksAgentComposerState['commentResolution']
  > | null>(null)
  // Why: an accepted launch parks its payload here so panel churn cannot drop it while
  // submit-after-ready is still running; nothing is posted until delivery succeeds.
  const claimedCommentResolutionRef = useRef<NonNullable<
    ChecksAgentComposerState['commentResolution']
  > | null>(null)
  const commentResolutionLaunchAcceptedRef = useRef(false)
  // Why: a second launch while the first ack is still landing would double-post fixing replies.
  const [commentResolutionAckBusy, setCommentResolutionAckBusy] = useState(false)
  const commentResolutionAckBusyRef = useRef(false)
  const setCommentResolutionAckBusyNow = useCallback((busy: boolean): void => {
    commentResolutionAckBusyRef.current = busy
    setCommentResolutionAckBusy(busy)
  }, [])
  const [hostedReviewCreationSnapshot, setHostedReviewCreationSnapshot] =
    useState<HostedReviewCreationSnapshot | null>(null)
  // Sticky record of the latest hard refresh error so Create can't flap back until a qualifying eligibility request clears it.
  const [hardRefreshError, setHardRefreshError] = useState<{
    observedAt: number
    errorType: PRRefreshErrorType
    contextKey: string
  } | null>(null)
  const [gitStatusSnapshot, setGitStatusSnapshot] = useState<ChecksPanelGitStatusSnapshot | null>(
    null
  )
  // Context key whose git-status probe failed with no snapshot, so the empty state can distinguish "checking branch status" from "could not check".
  const [gitStatusProbeErrorContextKey, setGitStatusProbeErrorContextKey] = useState<string | null>(
    null
  )
  const [gitStatusRefreshNonce, setGitStatusRefreshNonce] = useState(0)
  // Bumped by manual Retry/Refresh so eligibility re-runs even when Git state is unchanged (e.g. an auth fix must still clear the hard error).
  const [eligibilityRefreshNonce, setEligibilityRefreshNonce] = useState(0)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleInputFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollIntervalRef = useRef(30_000) // start at 30s, backs off to 120s
  const mountedRef = useMountedRef()
  const confirm = useConfirmationDialog()
  const prevChecksRef = useRef<string>('')
  // Why: a fork MR's pipeline lives in the source project, so job traces must be
  // fetched against the MR's own project rather than this repo's default remote.
  const gitLabProjectRefRef = useRef<GitLabProjectRef | null>(null)
  const conflictSummaryRefreshKeyRef = useRef<string | null>(null)
  const panelVisibleSinceRef = useRef<number | null>(null)
  const foregroundedUnrenderedReviewKeyRef = useRef<string | null>(null)
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
  // Local execution host variant (wsl:{distro} vs host); applies only when local — remote contexts are scoped by runtimeEnvironmentId/connectionId.
  const localExecutionScope = useMemo<string | null>(() => {
    if (runtimeEnvironmentId != null || repoConnectionId != null) {
      return null
    }
    const localRuntime = normalizeGlobalWindowsRuntimeDefault(settings?.localWindowsRuntimeDefault)
    return localRuntime.kind === 'wsl' ? `wsl:${localRuntime.distro ?? ''}` : 'host'
  }, [runtimeEnvironmentId, repoConnectionId, settings?.localWindowsRuntimeDefault])
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
    localExecutionScope,
    pushTarget: activeWorktreePushTarget
  })
  const panelContextKeyRef = useRef(panelContextKey)
  panelContextKeyRef.current = panelContextKey
  return {
    rightSidebarOpen,
    rightSidebarTab,
    isPanelVisible,
    activeWorktree,
    activeWorktreeId,
    repo,
    activeConnectionId,
    settings,
    updateSettings,
    updateRepo,
    fetchPRForBranch,
    fetchHostedReviewForBranch,
    expireGitHubPRRefreshState,
    getHostedReviewCreationEligibility,
    createHostedReview,
    createStackedHostedReview,
    enqueueGitHubPRRefresh,
    conflictOperation,
    gitStatusInvalidation,
    remoteStatusInvalidation,
    isRemoteOperationActive,
    pushBranch,
    syncBranch,
    fetchUpstreamStatus,
    setRightSidebarOpen,
    setRightSidebarTab,
    updateWorktreeMeta,
    updateWorktreeGitIdentity,
    openModal,
    fetchPRChecks,
    fetchPRCheckDetails,
    fetchPRComments,
    addPRConversationComment,
    addPRReviewCommentReply,
    setPRCommentReaction,
    resolveReviewThread,
    detectedAgentIds,
    remoteDetectedAgentIds,
    checks,
    setChecks,
    checksLoading,
    setChecksLoading,
    comments,
    setComments,
    commentsLoading,
    setCommentsLoading,
    commentsRef,
    commentsSelectionClearRequest,
    setCommentsSelectionClearRequest,
    commentsSelectionClearTokenRef,
    emptyRefreshing,
    setEmptyRefreshing,
    isRefreshing,
    setIsRefreshing,
    refreshInFlightRef,
    conflictDetailsRefreshing,
    setConflictDetailsRefreshing,
    createPrInFlightRef,
    isCreatingPr,
    setIsCreatingPr,
    createPrError,
    setCreatePrError,
    isPublishingBranch,
    setIsPublishingBranch,
    isSyncingBranch,
    setIsSyncingBranch,
    isResolvingConflictsWithAI,
    isFixingChecksWithAI,
    setIsFixingChecksWithAI,
    agentComposerState,
    setAgentComposerState,
    pendingCommentResolutionRef,
    claimedCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    commentResolutionAckBusy,
    commentResolutionAckBusyRef,
    setCommentResolutionAckBusyNow,
    hostedReviewCreationSnapshot,
    setHostedReviewCreationSnapshot,
    hardRefreshError,
    setHardRefreshError,
    gitStatusSnapshot,
    setGitStatusSnapshot,
    gitStatusProbeErrorContextKey,
    setGitStatusProbeErrorContextKey,
    gitStatusRefreshNonce,
    setGitStatusRefreshNonce,
    eligibilityRefreshNonce,
    setEligibilityRefreshNonce,
    editingTitle,
    setEditingTitle,
    titleDraft,
    setTitleDraft,
    titleSaving,
    setTitleSaving,
    titleInputRef,
    titleInputFocusTimerRef,
    pollIntervalRef,
    mountedRef,
    confirm,
    prevChecksRef,
    gitLabProjectRefRef,
    conflictSummaryRefreshKeyRef,
    panelVisibleSinceRef,
    foregroundedUnrenderedReviewKeyRef,
    prGenerationRecords,
    allocatePullRequestGenerationRequestId,
    setPullRequestGenerationRecord,
    updatePullRequestGenerationRecord,
    saveLaunchActionDefault,
    asyncResultKeyRef,
    refreshRequestKeyRef,
    refreshContextKeyRef,
    gitStatusSnapshotInFlightContextRef,
    gitStatusSnapshotRerunContextRef,
    gitStatusSnapshotRetryTimerRef,
    gitIdentityDisplay,
    detachedHeadDisplay,
    branch,
    activeWorktreePath,
    activeWorktreePushTarget,
    activeSourceControlLaunchPlatform,
    runtimeEnvironmentId,
    ownerSettings,
    repoConnectionId,
    localExecutionScope,
    sshConnectionStatus,
    panelContextKey,
    panelContextKeyRef
  }
}

export type ChecksPanelControllerState = ReturnType<typeof useChecksPanelControllerState>
