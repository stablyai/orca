import { useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { prChecksCacheSuffix, prCommentsCacheSuffix } from '@/store/github/cache-identity'
import { getGitHubRepoCacheKey } from '@/store/slices/github-cache-key'
import {
  buildChecksPanelEligibilityGitFingerprint,
  readChecksPanelGitStatusSnapshot,
  readChecksPanelPublishActionGitStatus
} from '../checks-panel-git-status-snapshot'
import { resolveHostedReviewCreationProvider } from '../../../../../shared/hosted-review-creation-providers'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { resolveChecksPanelReviewLookup } from '../checks-panel-review-lookup-authority'
import {
  getChecksPanelForegroundReviewEvidenceKey,
  resolveChecksPanelReviewEvidenceProvider
} from '../checks-panel-pr-refresh-request'
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
import { getRuntimeGitScope } from '@/runtime/runtime-git-client'
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
    panelContextKey,
    pr,
    prCacheKey,
    prCachedHasPR,
    prGenerationRecords,
    prNumber,
    refreshContextKey,
    remoteStatusInvalidation,
    repo,
    repoConnectionId,
    runtimeEnvironmentId,
    settings,
    updatePullRequestGenerationRecord
  } = model
  // Why: select only timestamps, not whole cache records, so the entry-refresh effect doesn't re-run on every cache mutation. See docs/refresh-on-checks-tab.md.
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
  // Read via a ref so a HEAD move drops confirmed (fingerprint mismatch) without re-triggering the eligibility network call.
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
  // Why: Publish can use the worktree poller when the stricter panel snapshot is delayed; still blocked for dirty fallback status.
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
  // Only GitHub runs the gh refresh coordinator; re-derive GitHub-ness from linked reviews because resolveHostedReviewCreationProvider defaults null→'github' (can't tell unknown from GitHub), staying GitHub-optimistic pre-eligibility.
  const hasNonGitHubLinkedReview =
    activeWorktree?.linkedGitLabMR != null ||
    activeWorktree?.linkedBitbucketPR != null ||
    activeWorktree?.linkedAzureDevOpsPR != null ||
    activeWorktree?.linkedGiteaPR != null
  const isGitHubReviewContext = hostedReviewCreation
    ? hostedReviewCreation.provider === 'github'
    : !hasNonGitHubLinkedReview
  const hostedReviewCreateCopy = localizedHostedReviewCopy(hostedReviewCreateProvider)
  // The PR cache isn't push-target scoped, so demote a branch-scoped no-PR to unknown when the eligibility snapshot is for a different context.
  const prCachedHasPRForContext =
    hostedReviewCreationSnapshot && hostedReviewCreationSnapshot.contextKey !== panelContextKey
      ? null
      : prCachedHasPR
  // Four-state review evidence so the empty state can never claim "No review found" without accepted evidence.
  const checksPanelReviewLookupResult = resolveChecksPanelReviewLookup({
    pr,
    prCachedHasPR: prCachedHasPRForContext,
    hostedReview,
    linkedReviewNumber,
    eligibilityReviewLookupOutcome: hostedReviewCreation?.reviewLookupOutcome ?? null,
    eligibilityReview: hostedReviewCreation?.review ?? null
  })
  const checksPanelReviewLookup = checksPanelReviewLookupResult.state
  const hasUnrenderedReviewEvidence =
    checksPanelReviewLookup === 'positive_unresolved' ||
    (checksPanelReviewLookup !== 'found' &&
      hostedReviewCreation?.blockedReason === 'existing_review')
  const unrenderedReviewEvidenceIdentity =
    linkedReviewNumber ??
    hostedReview?.number ??
    hostedReviewCreation?.review?.number ??
    checksPanelReviewLookupResult.openReviewUrl ??
    'unknown'
  const unrenderedReviewEvidenceProvider = resolveChecksPanelReviewEvidenceProvider({
    linkedGitHubPR: linkedPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    eligibilityProvider: hostedReviewCreation?.provider,
    cachedProvider: hostedReview?.provider
  })
  const foregroundReviewEvidenceKey = getChecksPanelForegroundReviewEvidenceKey({
    refreshContextKey,
    reviewEvidenceIdentity: unrenderedReviewEvidenceIdentity,
    reviewEvidenceProvider: unrenderedReviewEvidenceProvider,
    hasUnrenderedReviewEvidence,
    isGitHubReviewContext
  })
  // Confirmed readiness from the last eligibility snapshot, not live canCreate (which would be circular and flap during transient failures).
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
    now: Date.now()
  }
  const confirmedReadiness = computeChecksPanelConfirmedReadiness(confirmedReadinessInput)
  // A hard error persists until a qualifying eligibility request clears it; queued/in-flight status no longer un-hides Create.
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
      // Why: AI PR generation can rebase before summarizing; persist the push requirement since ChecksPanel unmounts when users leave the tab.
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
  // Confirmed-only gate: a confirmed composer survives transient refresh failures, but a failure never *opens* a never-confirmed Create.
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
    hasUnrenderedReviewEvidence,
    unrenderedReviewEvidenceIdentity,
    unrenderedReviewEvidenceProvider,
    foregroundReviewEvidenceKey,
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
