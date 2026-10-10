import { useEffect, useRef } from 'react'
import { getRuntimeGitStatus, getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-client'
import {
  buildChecksPanelEligibilityGitFingerprint,
  shouldClearChecksPanelGitStatusSnapshot,
  shouldCommitChecksPanelGitStatusSnapshot
} from '../checks-panel-git-status-snapshot'
import { createCoalescedPollRunner, type CoalescedPollRunner } from '../coalesced-poll-runner'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'

type ChecksPanelGitStatusEffectsInput = Pick<
  ChecksPanelControllerState,
  | 'activeConnectionId'
  | 'activeWorktreeId'
  | 'activeWorktreePath'
  | 'activeWorktreePushTarget'
  | 'branch'
  | 'eligibilityRefreshNonce'
  | 'getHostedReviewCreationEligibility'
  | 'gitStatusInvalidation'
  | 'gitStatusRefreshNonce'
  | 'gitStatusSnapshotRetryTimerRef'
  | 'isPanelVisible'
  | 'localExecutionScope'
  | 'ownerSettings'
  | 'panelContextKey'
  | 'panelContextKeyRef'
  | 'remoteStatusInvalidation'
  | 'repo'
  | 'repoConnectionId'
  | 'runtimeEnvironmentId'
  | 'setGitStatusProbeErrorContextKey'
  | 'setGitStatusRefreshNonce'
  | 'setGitStatusSnapshot'
  | 'setHostedReviewCreationSnapshot'
  | 'sshConnectionStatus'
  | 'updateWorktreeGitIdentity'
> &
  Pick<
    ChecksPanelReviewState,
    | 'eligibilityHeadOidRef'
    | 'gitStatusReadyForPanelContext'
    | 'hasUncommittedChanges'
    | 'hostedReviewCreationRequestKey'
    | 'remoteStatus'
  > &
  Pick<
    ChecksPanelContextState,
    | 'isFolder'
    | 'linkedAzureDevOpsPR'
    | 'linkedBitbucketPR'
    | 'linkedGiteaPR'
    | 'linkedGitLabMR'
    | 'linkedPR'
    | 'fallbackGitHubPRNumber'
  >

const GIT_STATUS_FAILURE_RETRY_MS = 3000
const CHECKS_PANEL_GIT_STATUS_MIN_INTERVAL_MS = 3000
const CHECKS_PANEL_GIT_STATUS_SLOW_BACKOFF = {
  idleMultiplier: 1,
  changeSignalMultiplier: 1,
  maxIntervalMs: 5 * 60_000
}

export function useChecksPanelGitStatusEffects(model: ChecksPanelGitStatusEffectsInput) {
  const {
    activeConnectionId,
    activeWorktreeId,
    activeWorktreePath,
    activeWorktreePushTarget,
    branch,
    eligibilityHeadOidRef,
    eligibilityRefreshNonce,
    getHostedReviewCreationEligibility,
    gitStatusInvalidation,
    gitStatusReadyForPanelContext,
    gitStatusRefreshNonce,
    gitStatusSnapshotRetryTimerRef,
    hasUncommittedChanges,
    hostedReviewCreationRequestKey,
    isFolder,
    isPanelVisible,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    fallbackGitHubPRNumber,
    localExecutionScope,
    ownerSettings,
    panelContextKey,
    panelContextKeyRef,
    remoteStatus,
    remoteStatusInvalidation,
    repo,
    repoConnectionId,
    runtimeEnvironmentId,
    setGitStatusProbeErrorContextKey,
    setGitStatusRefreshNonce,
    setGitStatusSnapshot,
    setHostedReviewCreationSnapshot,
    sshConnectionStatus,
    updateWorktreeGitIdentity
  } = model
  const gitStatusRequestRef = useRef<(() => Promise<void>) | null>(null)
  const gitStatusPollRunnerRef = useRef<CoalescedPollRunner | null>(null)
  const gitStatusPollingReady = Boolean(
    repo &&
    !isFolder &&
    branch &&
    isPanelVisible &&
    activeWorktreeId &&
    activeWorktreePath &&
    (runtimeEnvironmentId || !repoConnectionId || sshConnectionStatus === 'connected')
  )

  useEffect(() => {
    const runner = createCoalescedPollRunner(
      () => gitStatusRequestRef.current?.() ?? Promise.resolve(),
      {
        minIntervalMs: CHECKS_PANEL_GIT_STATUS_MIN_INTERVAL_MS,
        slowTaskBackoff: CHECKS_PANEL_GIT_STATUS_SLOW_BACKOFF
      }
    )
    gitStatusPollRunnerRef.current = runner
    return () => {
      gitStatusRequestRef.current = null
      runner.dispose()
      if (gitStatusPollRunnerRef.current === runner) {
        gitStatusPollRunnerRef.current = null
      }
    }
  }, [gitStatusPollingReady, panelContextKey])

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
      gitStatusRequestRef.current = null
      // Why: hiding the panel or losing SSH should stop new work, not erase same-context Create PR eligibility that can still be retried.
      return
    }
    let stale = false
    const requestContextKey = panelContextKey
    const connectionId = activeConnectionId ?? undefined
    // Why: global status maps are keyed only by worktree; use their changes as invalidation signals, then fetch a local snapshot.
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
    const runRequest = async (): Promise<void> => {
      try {
        const status = await getRuntimeGitStatus(context, { admissionTier: 'status' })
        if (
          !stale &&
          shouldCommitChecksPanelGitStatusSnapshot(panelContextKeyRef.current, requestContextKey)
        ) {
          // Why: the Checks tab can be the only visible git surface; commit branch identity before branch-scoped upstream refresh can fail.
          updateWorktreeGitIdentity(activeWorktreeId, {
            head: status.head,
            branch: status.branch ?? (status.head ? null : undefined)
          })
        }
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
        if (
          !stale &&
          shouldCommitChecksPanelGitStatusSnapshot(panelContextKeyRef.current, requestContextKey)
        ) {
          setGitStatusSnapshot({
            contextKey: requestContextKey,
            hasUncommittedChanges: status.entries.length > 0,
            remoteStatus: freshRemoteStatus,
            gitIdentity: {
              head: status.head,
              branch: status.branch ?? (status.head ? null : undefined)
            }
          })
          // A fresh probe succeeded, so this context is no longer in the "could not check branch status" state.
          setGitStatusProbeErrorContextKey((key) => (key === requestContextKey ? null : key))
        }
      } catch (error) {
        console.warn('[ChecksPanel] git status refresh before eligibility failed', error)
        if (!stale) {
          // Why: transient SSH/runtime flakes shouldn't hide an already-valid Create PR state for this branch; retry while visible.
          setGitStatusSnapshot((snapshot) =>
            shouldClearChecksPanelGitStatusSnapshot(snapshot, requestContextKey) ? null : snapshot
          )
          // Mark the probe failed so the empty state shows "Could not check branch status" instead of an indefinite "Checking branch status".
          if (
            shouldCommitChecksPanelGitStatusSnapshot(panelContextKeyRef.current, requestContextKey)
          ) {
            setGitStatusProbeErrorContextKey(requestContextKey)
          }
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
      }
    }
    gitStatusRequestRef.current = runRequest
    gitStatusPollRunnerRef.current?.run()
    return () => {
      stale = true
      if (gitStatusRequestRef.current === runRequest) {
        gitStatusRequestRef.current = null
      }
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
    sshConnectionStatus,
    updateWorktreeGitIdentity,
    setGitStatusProbeErrorContextKey,
    setGitStatusSnapshot,
    gitStatusSnapshotRetryTimerRef,
    setGitStatusRefreshNonce,
    panelContextKeyRef
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
    const requestContextKey = panelContextKey
    const requestStartedAt = Date.now()
    const requestGitFingerprint = buildChecksPanelEligibilityGitFingerprint({
      headOid: eligibilityHeadOidRef.current,
      hasUncommittedChanges,
      hasUpstream: remoteStatus?.hasUpstream,
      ahead: remoteStatus?.ahead,
      behind: remoteStatus?.behind,
      base: repo.worktreeBaseRef ?? null,
      runtimeEnvironmentId,
      repoConnectionId,
      localExecutionScope
    })
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
            contextKey: requestContextKey,
            repoId: repo.id,
            worktreeId: activeWorktreeId,
            branch,
            requestStartedAt,
            completedAt: Date.now(),
            gitFingerprint: requestGitFingerprint,
            data: result
          })
        }
      })
      .catch(() => {
        // Why: a transient GitHub outage rethrows here; don't tear down the last confirmed snapshot so a clean composer survives the outage.
      })
    return () => {
      stale = true
    }
  }, [
    panelContextKey,
    runtimeEnvironmentId,
    repoConnectionId,
    activeWorktreeId,
    activeWorktreePath,
    branch,
    getHostedReviewCreationEligibility,
    gitStatusReadyForPanelContext,
    hasUncommittedChanges,
    hostedReviewCreationRequestKey,
    eligibilityRefreshNonce,
    localExecutionScope,
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
    repo,
    eligibilityHeadOidRef,
    setHostedReviewCreationSnapshot
  ])
}
