import type { HostedReviewInfo } from '../../../../../../shared/hosted-review'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import {
  resolveSourceControlBaseRef,
  resolveSourceControlCompareBaseRef,
  resolveSourceControlPickerBaseRef
} from '../../../../../../shared/source-control-base-ref-resolution'
import { useSourceControlBaseRefDefault } from './use-base-ref-default'

export function useSourceControlBaseRefs({
  activeRepoConnectionId,
  activeRepoExecutionHostId,
  activeRepoId,
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
  // Keep comparison separate from the effectiveBaseRef used for PR/rebase targets.
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
