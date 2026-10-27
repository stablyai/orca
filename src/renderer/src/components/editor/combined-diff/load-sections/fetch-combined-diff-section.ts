import { useAppStore } from '@/store'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import {
  getRuntimeGitBranchDiff,
  getRuntimeGitCommitDiff,
  getRuntimeGitDiff
} from '@/runtime/runtime-git-diff-client'
import type { OpenFile } from '@/store/slices/editor'
import type {
  GitBranchChangeEntry,
  GitDiffResult
} from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { getCombinedDiffSectionConnectionId } from './combined-diff-section-connection'
import { withDiffSectionLoadTimeout } from './combined-diff-section-load-timeout'

export function fetchCombinedDiffSection({
  branchCompare,
  commitCompare,
  entry,
  file,
  isAllMode,
  isBranchMode,
  isCommitMode
}: {
  branchCompare: NonNullable<OpenFile['branchCompare']> | null
  commitCompare: NonNullable<OpenFile['commitCompare']> | null
  entry: GitStatusEntry | GitBranchChangeEntry
  file: OpenFile
  isAllMode: boolean
  isBranchMode: boolean
  isCommitMode: boolean
}): Promise<GitDiffResult> {
  const connectionId = getCombinedDiffSectionConnectionId(
    file.worktreeId,
    file.filePath,
    entry.path
  )
  const fileTarget = requireRuntimeTargetForFileOwner(
    useAppStore.getState(),
    file.worktreeId,
    file.runtimeEnvironmentId
  )
  if ((isBranchMode || (isAllMode && !('area' in entry))) && branchCompare) {
    return withDiffSectionLoadTimeout(
      getRuntimeGitBranchDiff(
        {
          target: fileTarget,
          worktreeId: file.worktreeId,
          worktreePath: file.filePath,
          connectionId
        },
        {
          compare: {
            baseRef: branchCompare.baseRef,
            baseOid: branchCompare.baseOid!,
            headOid: branchCompare.headOid!,
            mergeBase: branchCompare.mergeBase!
          },
          filePath: entry.path,
          oldPath: entry.oldPath
        }
      )
    )
  }
  if (isCommitMode && commitCompare) {
    return withDiffSectionLoadTimeout(
      getRuntimeGitCommitDiff(
        {
          target: fileTarget,
          worktreeId: file.worktreeId,
          worktreePath: file.filePath,
          connectionId
        },
        {
          commitOid: commitCompare.commitOid,
          parentOid: commitCompare.parentOid,
          filePath: entry.path,
          oldPath: entry.oldPath
        }
      )
    )
  }
  return withDiffSectionLoadTimeout(
    getRuntimeGitDiff(
      {
        target: fileTarget,
        worktreeId: file.worktreeId,
        worktreePath: file.filePath,
        connectionId
      },
      {
        filePath: entry.path,
        staged: 'area' in entry && entry.area === 'staged'
      }
    )
  )
}
