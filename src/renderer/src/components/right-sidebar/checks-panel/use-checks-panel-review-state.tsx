import { useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { prChecksCacheSuffix, prCommentsCacheSuffix } from '@/store/github/cache-identity'
import { getGitHubRepoCacheKey } from '../../../../../shared/github/github-cache-key'
import {
  buildChecksPanelEligibilityGitFingerprint,
  readChecksPanelGitStatusSnapshot,
  readChecksPanelPublishActionGitStatus
} from '../checks-panel-git-status-snapshot'
import { resolveHostedReviewCreationProvider } from '../../../../../shared/hosted-review-creation-providers'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { resolveChecksPanelReviewLookup } from '../checks-panel-review-lookup-authority'
import {
  computeChecksPanelConfirmedReadiness,
  isChecksPanelHardErrorCleared,
  type ChecksPanelConfirmedReadinessInput
} from '../checks-panel-review-creation'
import {
  getPullRequestGenerationRecordKey,
  getPullRequestGenerationSeedRestoreKey,
  markPullRequestGenerationRequiresPushBeforeCreate,
  type PullRequestGenerationContext
} from '@/store/slices/pull-request-generation'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../../../shared/commit-message-host-key'
import {
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
  resolveSourceControlAiEnabled,
  resolveSourceControlAiForOperation,
  resolveSourceControlAiPrCreationDefaults
} from '../../../../../shared/source-control-ai'
import { getRuntimeGitScope } from '@/runtime/runtime-git-client-context'
import type { ChecksPanelReviewStateInput } from './review-state-dependencies'

export function useChecksPanelReviewState(model: ChecksPanelReviewStateInput) {
  const {
    activeReview,
    activeWorktree,
    activeWorktreeId,
    activeWorktreePath,
    branch,
    fallbackGitHubPRNumber,
    fetchUpstreamStatus,
    gitStatusInvalidation,
    gitStatusSnapshot,
    hardRefreshError,
    hostedReview,
    hostedReviewCreationSnapshot,
    isFolder,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    linkedReviewNumber,
    localExecutionScope,
    ownerTarget,
    panelContextKey,
    pr,
    prCacheKey,
    prRefreshStateNow,
    prCachedHasPR,
    prGenerationRecords,
    prNumber,
    remoteStatusInvalidation,
    repo,
    repoConnectionId,
    runtimeEnvironmentId,
    settings,
    updatePullRequestGenerationRecord
  } = model
  // Select timestamps only to avoid rerunning entry-refresh on unrelated cache mutations; see docs/refresh-on-checks-tab.md.
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
  const eligibilityHeadOid =
    gitStatusSnapshot?.contextKey === panelContextKey
      ? (gitStatusSnapshot.gitIdentity?.head ?? null)
      : null
  // Read HEAD through a ref to drop stale confirmation without retriggering the eligibility request.
  const eligibilityHeadOidRef = useRef(eligibilityHeadOid)
  eligibilityHeadOidRef.current = eligibilityHeadOid
  const eligibilityGitFingerprint = gitStatusReadyForPanelContext
    ? buildChecksPanelEligibilityGitFingerprint({
        headOid: eligibilityHeadOid,
        hasUncommittedChanges,
        hasUpstream: remoteStatus?.hasUpstream,
        ahead: remoteStatus?.ahead,
        behind: remoteStatus?.behind,
        base: repo?.worktreeBaseRef ?? null,
        runtimeEnvironmentId,
        repoConnectionId,
        localExecutionScope
      })
    : null
  // Publish may use poller fallback while the stricter snapshot is delayed, but still rejects dirty status.
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
  // Only GitHub uses its refresh coordinator; linked reviews disambiguate the provider resolver's null-to-GitHub default.
  const hasNonGitHubLinkedReview =
    activeWorktree?.linkedGitLabMR != null ||
    activeWorktree?.linkedBitbucketPR != null ||
    activeWorktree?.linkedAzureDevOpsPR != null ||
    activeWorktree?.linkedGiteaPR != null
  const isGitHubReviewContext = hostedReviewCreation
    ? hostedReviewCreation.provider === 'github'
    : !hasNonGitHubLinkedReview
  const hostedReviewCreateCopy = localizedHostedReviewCopy(hostedReviewCreateProvider)
  // Demote cached absence to unknown across eligibility contexts; PR cache keys omit push targets.
  const prCachedHasPRForContext =
    hostedReviewCreationSnapshot && hostedReviewCreationSnapshot.contextKey !== panelContextKey
      ? null
      : prCachedHasPR
  const checksPanelReviewLookupResult = resolveChecksPanelReviewLookup({
    pr,
    prCachedHasPR: prCachedHasPRForContext,
    hostedReview,
    linkedReviewNumber,
    eligibilityReviewLookupOutcome: hostedReviewCreation?.reviewLookupOutcome ?? null,
    eligibilityReview: hostedReviewCreation?.review ?? null
  })
  const checksPanelReviewLookup = checksPanelReviewLookupResult.state
  // Use the last eligibility snapshot; live canCreate would be circular and flap during transient failures.
  const hardErrorObservedAt =
    isGitHubReviewContext && hardRefreshError && hardRefreshError.contextKey === panelContextKey
      ? hardRefreshError.observedAt
      : undefined
  const confirmedReadinessInput: ChecksPanelConfirmedReadinessInput = {
    contextKeyMatches: hostedReviewCreationSnapshot?.contextKey === panelContextKey,
    eligibility: hostedReviewCreationSnapshot?.data ?? null,
    eligibilityCompletedAt: hostedReviewCreationSnapshot?.completedAt,
    eligibilityRequestStartedAt: hostedReviewCreationSnapshot?.requestStartedAt,
    reviewLookup: checksPanelReviewLookup,
    hardErrorObservedAt,
    gitSnapshotMatches:
      eligibilityGitFingerprint !== null &&
      hostedReviewCreationSnapshot?.gitFingerprint === eligibilityGitFingerprint,
    now: prRefreshStateNow
  }
  const confirmedReadiness = computeChecksPanelConfirmedReadiness(confirmedReadinessInput)
  // Retries cannot clear sticky hard errors without a qualifying eligibility result.
  const checksPanelHasHardRefreshError =
    hardErrorObservedAt !== undefined && !isChecksPanelHardErrorCleared(confirmedReadinessInput)
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
      // Generation may rebase; persist its push requirement because leaving Checks unmounts the panel.
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
            runtimeTarget: context.runtimeTarget
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
      getRuntimeGitScope(ownerTarget ?? { kind: 'local' }, repo?.connectionId)
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
  }, [ownerTarget, repo, settings])
  const sourceControlAiActionsVisible = useMemo(
    () => (settings ? resolveSourceControlAiEnabled({ settings, repo }) : false),
    [repo, settings]
  )
  // Transient failures preserve confirmed composers but cannot open unconfirmed ones.
  const createComposerOpen =
    !isFolder && !activeReview && Boolean(branch) && confirmedReadiness.confirmed
  return {
    prFetchedAt,
    checksCacheKey,
    commentsCacheKey,
    checksFetchedAt,
    commentsFetchedAt,
    hostedReviewCreationRequestKey,
    gitStatusInputs,
    gitStatusReadyForPanelContext,
    hasUncommittedChanges,
    remoteStatus,
    eligibilityHeadOid,
    eligibilityHeadOidRef,
    eligibilityGitFingerprint,
    publishActionGitStatusInputs,
    publishActionHasUncommittedChanges,
    publishActionRemoteStatus,
    hostedReviewCreation,
    hostedReviewCreateProvider,
    hasNonGitHubLinkedReview,
    isGitHubReviewContext,
    hostedReviewCreateCopy,
    prCachedHasPRForContext,
    checksPanelReviewLookupResult,
    checksPanelReviewLookup,
    hardErrorObservedAt,
    confirmedReadinessInput,
    confirmedReadiness,
    checksPanelHasHardRefreshError,
    activePullRequestGenerationKey,
    activePullRequestGenerationRecordCandidate,
    activePullRequestGenerationRecord,
    activePullRequestGenerationSeedRestoreKey,
    createPrPushFirst,
    handleBranchChangedByPullRequestGeneration,
    prCreationDefaults,
    sourceControlAiActionsVisible,
    createComposerOpen
  }
}

export type ChecksPanelReviewState = ReturnType<typeof useChecksPanelReviewState>
