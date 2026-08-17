import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import type { GitBranchCompareSummary } from '../../../../../../shared/git-diff-compare-types'
import { isStageableStatusEntry } from '../commit/discard-all-sequence'
import { resolveDropdownItems } from '../../source-control-dropdown-items'
import { resolveCommitAreaPrimaryAction } from '../../source-control-primary-action'
import { resolveCreatePrHeaderAction } from './primary-create-pr-intent-action'
import { resolveVisibleCreatePrHeaderAction } from './create-pr-intent-state'
import type { SourceControlEntryGroups } from '../listing/section-order'

type PrimaryInput = Parameters<typeof resolveCommitAreaPrimaryAction>[0]
type HeaderInput = Parameters<typeof resolveCreatePrHeaderAction>[0]
type DropdownInput = Parameters<typeof resolveDropdownItems>[0]

export function useSourceControlActionModel({
  grouped,
  commitMessage,
  unresolvedConflictCount,
  isCommitting,
  isRemoteOperationActive,
  isAbortingOperation,
  remoteStatusForActions,
  hostedReviewStateForActions,
  isHostedReviewStateLoading,
  inFlightRemoteOpKind,
  hostedReviewCreation,
  branchSummary,
  branchName,
  canUseHostedReviewPushTarget,
  isCreatePrIntentInFlight,
  remoteStatus,
  hostedReviewState,
  hostedReviewCreationForHeader,
  isHostedReviewCreationLoading,
  prGenerating,
  isCreatingPr,
  hostedReviewReviewLabel,
  conflictOperation,
  effectiveBaseRef
}: {
  grouped: SourceControlEntryGroups
  commitMessage: string
  unresolvedConflictCount: number
  isCommitting: boolean
  isRemoteOperationActive: boolean
  isAbortingOperation: boolean
  remoteStatusForActions: PrimaryInput['upstreamStatus']
  hostedReviewStateForActions: PrimaryInput['prState']
  isHostedReviewStateLoading: boolean
  inFlightRemoteOpKind: PrimaryInput['inFlightRemoteOpKind']
  hostedReviewCreation: PrimaryInput['hostedReviewCreation']
  branchSummary: GitBranchCompareSummary | null
  branchName: string
  canUseHostedReviewPushTarget: boolean
  isCreatePrIntentInFlight: boolean
  remoteStatus: HeaderInput['upstreamStatus']
  hostedReviewState: HeaderInput['prState']
  hostedReviewCreationForHeader: HeaderInput['hostedReviewCreation']
  isHostedReviewCreationLoading: boolean
  prGenerating: boolean
  isCreatingPr: boolean
  hostedReviewReviewLabel: string
  conflictOperation: DropdownInput['conflictOperation']
  effectiveBaseRef: string | null
}) {
  const hasUnstagedChanges = grouped.unstaged.length > 0 || grouped.untracked.length > 0
  const hasStageableChanges = useMemo(
    () =>
      grouped.unstaged.some(isStageableStatusEntry) ||
      grouped.untracked.some(isStageableStatusEntry),
    [grouped.unstaged, grouped.untracked]
  )
  const hasPartiallyStagedChanges = useMemo(() => {
    if (grouped.staged.length === 0 || grouped.unstaged.length === 0) {
      return false
    }
    const unstagedPaths = new Set(grouped.unstaged.map((entry) => entry.path))
    return grouped.staged.some((entry) => unstagedPaths.has(entry.path))
  }, [grouped.staged, grouped.unstaged])

  const primaryAction = useMemo(
    () =>
      resolveCommitAreaPrimaryAction({
        stagedCount: grouped.staged.length,
        hasUnstagedChanges,
        hasStageableChanges,
        hasPartiallyStagedChanges,
        hasMessage: commitMessage.trim().length > 0,
        hasUnresolvedConflicts: unresolvedConflictCount > 0,
        isCommitting,
        isRemoteOperationActive: isRemoteOperationActive || isAbortingOperation,
        upstreamStatus: remoteStatusForActions,
        prState: hostedReviewStateForActions,
        isPRStateLoading: isHostedReviewStateLoading,
        inFlightRemoteOpKind,
        hostedReviewCreation,
        branchCommitsAhead:
          branchSummary?.status === 'ready' ? (branchSummary.commitsAhead ?? 0) : undefined,
        hasCurrentBranch: Boolean(branchName),
        canPushLinkedReviewWithoutUpstream: canUseHostedReviewPushTarget,
        isPrIntentInFlight: isCreatePrIntentInFlight
      }),
    [
      commitMessage,
      grouped.staged.length,
      hasStageableChanges,
      hasUnstagedChanges,
      hasPartiallyStagedChanges,
      isCommitting,
      isAbortingOperation,
      isRemoteOperationActive,
      inFlightRemoteOpKind,
      hostedReviewCreation,
      isHostedReviewStateLoading,
      hostedReviewStateForActions,
      canUseHostedReviewPushTarget,
      isCreatePrIntentInFlight,
      branchSummary?.commitsAhead,
      branchSummary?.status,
      branchName,
      remoteStatusForActions,
      unresolvedConflictCount
    ]
  )

  const createPrHeaderAction = useMemo(() => {
    const action = resolveCreatePrHeaderAction({
      stagedCount: grouped.staged.length,
      hasUnstagedChanges,
      hasStageableChanges,
      hasPartiallyStagedChanges,
      hasMessage: commitMessage.trim().length > 0,
      hasUnresolvedConflicts: unresolvedConflictCount > 0,
      isCommitting,
      isRemoteOperationActive: isRemoteOperationActive || isAbortingOperation,
      upstreamStatus: remoteStatus,
      prState: hostedReviewState,
      isPRStateLoading: isHostedReviewStateLoading,
      inFlightRemoteOpKind,
      hostedReviewCreation: hostedReviewCreationForHeader,
      isHostedReviewCreationLoading:
        isHostedReviewCreationLoading && hostedReviewCreationForHeader !== null,
      branchCommitsAhead:
        branchSummary?.status === 'ready' ? (branchSummary.commitsAhead ?? 0) : undefined,
      hasCurrentBranch: Boolean(branchName),
      isPrIntentInFlight: isCreatePrIntentInFlight
    })
    if ((prGenerating || isCreatingPr) && action?.kind === 'create_pr') {
      return {
        ...action,
        title: prGenerating
          ? translate(
              'auto.components.right.sidebar.SourceControl.createPrIntentGeneratingDetails',
              'Generating review details…'
            )
          : translate(
              'auto.components.right.sidebar.SourceControl.fe5bd1a610',
              'Creating {{value0}}...',
              { value0: hostedReviewReviewLabel }
            ),
        disabled: true
      }
    }
    return action
  }, [
    branchName,
    branchSummary?.commitsAhead,
    branchSummary?.status,
    commitMessage,
    grouped.staged.length,
    hasPartiallyStagedChanges,
    hasStageableChanges,
    hasUnstagedChanges,
    hostedReviewState,
    hostedReviewCreationForHeader,
    hostedReviewReviewLabel,
    inFlightRemoteOpKind,
    isAbortingOperation,
    isCommitting,
    isCreatePrIntentInFlight,
    isCreatingPr,
    isHostedReviewCreationLoading,
    isHostedReviewStateLoading,
    isRemoteOperationActive,
    prGenerating,
    remoteStatus,
    unresolvedConflictCount
  ])
  const directCreatePrAction =
    createPrHeaderAction?.kind === 'create_pr' &&
    hostedReviewCreation?.canCreate === true &&
    (!createPrHeaderAction.disabled || isCreatingPr || prGenerating)
      ? createPrHeaderAction
      : null
  const visibleCreatePrHeaderAction = resolveVisibleCreatePrHeaderAction({ createPrHeaderAction })
  const dropdownItems = useMemo(
    () =>
      resolveDropdownItems({
        stagedCount: grouped.staged.length,
        hasUnstagedChanges,
        hasStageableChanges,
        hasPartiallyStagedChanges,
        hasMessage: commitMessage.trim().length > 0,
        hasUnresolvedConflicts: unresolvedConflictCount > 0,
        isCommitting,
        isRemoteOperationActive: isRemoteOperationActive || isAbortingOperation,
        conflictOperation,
        upstreamStatus: remoteStatusForActions,
        prState: hostedReviewStateForActions,
        isPRStateLoading: isHostedReviewStateLoading,
        inFlightRemoteOpKind,
        hostedReviewCreation,
        isPullRequestOperationActive: prGenerating || isCreatingPr || isCreatePrIntentInFlight,
        branchCommitsAhead:
          branchSummary?.status === 'ready' ? (branchSummary.commitsAhead ?? 0) : undefined,
        hasCurrentBranch: Boolean(branchName),
        canPushLinkedReviewWithoutUpstream: canUseHostedReviewPushTarget,
        rebaseBaseRef: effectiveBaseRef
      }),
    [
      commitMessage,
      grouped.staged.length,
      hasStageableChanges,
      hasUnstagedChanges,
      hasPartiallyStagedChanges,
      isCommitting,
      conflictOperation,
      isAbortingOperation,
      isRemoteOperationActive,
      inFlightRemoteOpKind,
      hostedReviewCreation,
      isCreatingPr,
      isCreatePrIntentInFlight,
      isHostedReviewStateLoading,
      hostedReviewStateForActions,
      prGenerating,
      canUseHostedReviewPushTarget,
      branchSummary?.commitsAhead,
      branchSummary?.status,
      branchName,
      effectiveBaseRef,
      remoteStatusForActions,
      unresolvedConflictCount
    ]
  )
  return {
    hasPartiallyStagedChanges,
    primaryAction,
    createPrHeaderAction,
    directCreatePrAction,
    visibleCreatePrHeaderAction,
    dropdownItems
  }
}

export type SourceControlActionModel = ReturnType<typeof useSourceControlActionModel>
