import { combineWorkingTreeDiffResult } from './working-tree-diff-result'
import { useAppStore } from '@/store'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import {
  getRuntimeGitBranchDiff,
  getRuntimeGitCommitDiff,
  getRuntimeGitDiff
} from '@/runtime/runtime-git-client'
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
  const state = useAppStore.getState()
  const fileSettings = settingsForRuntimeOwner(state.settings, file.runtimeEnvironmentId)
  if ((isBranchMode || (isAllMode && !('area' in entry))) && branchCompare) {
    const branchResult = getRuntimeGitBranchDiff(
      {
        settings: fileSettings,
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
        filePath:
          file.compareWorkingTree && 'branchPath' in entry && typeof entry.branchPath === 'string'
            ? entry.branchPath
            : entry.path,
        oldPath: entry.oldPath
      }
    )
    if (file.compareWorkingTree) {
      return withDiffSectionLoadTimeout(
        Promise.all([
          branchResult,
          getRuntimeGitDiff(
            {
              settings: fileSettings,
              worktreeId: file.worktreeId,
              worktreePath: file.filePath,
              connectionId
            },
            { filePath: entry.path, staged: false, compareAgainstHead: true }
          )
        ]).then(([base, working]) => combineWorkingTreeDiffResult(base, working))
      )
    }
    return withDiffSectionLoadTimeout(branchResult)
  }
  if (isCommitMode && commitCompare) {
    return withDiffSectionLoadTimeout(
      getRuntimeGitCommitDiff(
        {
          settings: fileSettings,
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
        settings: fileSettings,
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
