import type { HostedReviewInfo } from '../../../../../../shared/hosted-review'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import {
  resolveSourceControlBaseRef,
  resolveSourceControlCompareBaseRef,
  resolveSourceControlPickerBaseRef
} from './base-ref-resolution'
import { useSourceControlBaseRefDefault } from './use-base-ref-default'

/**
 * Resolves the base refs the panel works against: the worktree/repo pins, the repo default, and the
 * separate refs used for the merge target, the compare view and the base-ref picker.
 */
export function useSourceControlBaseRefs({
  activeRepoConnectionId,
  activeRepoExecutionHostId,
  activeRepoId,
  activeRepoRuntimeEnvironmentId,
  activeRepoWorktreeBaseRef,
  activeWorktreeBaseRef,
  hostedReview,
  isBranchVisible,
  isFolder,
  remoteStatus,
  settings
}: {
  activeRepoConnectionId: SourceControlWorktreeContext['activeRepoConnectionId']
  activeRepoExecutionHostId: SourceControlWorktreeContext['activeRepoExecutionHostId']
  activeRepoId: string | null
  activeRepoRuntimeEnvironmentId: string | null
  activeRepoWorktreeBaseRef: string | undefined
  activeWorktreeBaseRef: string | undefined
  hostedReview: HostedReviewInfo | null
  isBranchVisible: boolean
  isFolder: boolean
  remoteStatus: SourceControlWorktreeContext['remoteStatus']
  settings: SourceControlWorktreeContext['settings']
}) {
  const defaultBaseRef = useSourceControlBaseRefDefault({
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    activeRepoRuntimeEnvironmentId,
    isBranchVisible,
    isFolder
  })

  const normalizedWorktreeBaseRef = activeWorktreeBaseRef?.trim() || null
  const normalizedRepoBaseRef = activeRepoWorktreeBaseRef?.trim() || null
  const baseRefOwnedByWorktree = normalizedWorktreeBaseRef !== null
  const pinnedBaseRef = normalizedWorktreeBaseRef ?? normalizedRepoBaseRef

  const effectiveBaseRef = resolveSourceControlBaseRef({
    worktreeBaseRef: normalizedWorktreeBaseRef,
    reviewBaseRefName: hostedReview?.baseRefName,
    repoBaseRef: normalizedRepoBaseRef,
    defaultBaseRef
  })
  // Why: the compare/diff view uses this base; the PR/rebase merge target keeps effectiveBaseRef (equal when the setting is off).
  const compareBaseRef = resolveSourceControlCompareBaseRef({
    enabled: settings?.sourceControlCompareAgainstUpstream ?? false,
    worktreeBaseRef: normalizedWorktreeBaseRef,
    repoBaseRef: normalizedRepoBaseRef,
    upstreamName: remoteStatus?.upstreamName ?? null,
    fallbackBaseRef: effectiveBaseRef
  })
  const pickerBaseRef = resolveSourceControlPickerBaseRef({
    pinnedBaseRef,
    effectiveBaseRef
  })

  return {
    baseRefOwnedByWorktree,
    compareBaseRef,
    defaultBaseRef,
    effectiveBaseRef,
    normalizedRepoBaseRef,
    normalizedWorktreeBaseRef,
    pickerBaseRef,
    pinnedBaseRef
  }
}

export type SourceControlBaseRefs = ReturnType<typeof useSourceControlBaseRefs>
