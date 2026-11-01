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
import { acquireCombinedDiffSectionOperation } from './combined-diff-section-connection'
import { withDiffSectionLoadTimeout } from './combined-diff-section-load-timeout'

export function fetchCombinedDiffSection({
  branchCompare,
  commitCompare,
  entry,
  file,
  isAllMode,
  isBranchMode,
  isCommitMode,
  operation = acquireCombinedDiffSectionOperation(file, entry.path)
}: {
  branchCompare: NonNullable<OpenFile['branchCompare']> | null
  commitCompare: NonNullable<OpenFile['commitCompare']> | null
  entry: GitStatusEntry | GitBranchChangeEntry
  file: OpenFile
  isAllMode: boolean
  isBranchMode: boolean
  isCommitMode: boolean
  operation?: ReturnType<typeof acquireCombinedDiffSectionOperation>
}): Promise<{
  result: GitDiffResult
  operation: ReturnType<typeof acquireCombinedDiffSectionOperation>
}> {
  const retainResult = async (result: Promise<GitDiffResult>) => {
    const value = await result
    operation.assertCurrent()
    return { result: value, operation }
  }
  if ((isBranchMode || (isAllMode && !('area' in entry))) && branchCompare) {
    return retainResult(
      withDiffSectionLoadTimeout(
        getRuntimeGitBranchDiff(operation.context, {
          compare: {
            baseRef: branchCompare.baseRef,
            baseOid: branchCompare.baseOid!,
            headOid: branchCompare.headOid!,
            mergeBase: branchCompare.mergeBase!
          },
          filePath: entry.path,
          oldPath: entry.oldPath
        })
      )
    )
  }
  if (isCommitMode && commitCompare) {
    return retainResult(
      withDiffSectionLoadTimeout(
        getRuntimeGitCommitDiff(operation.context, {
          commitOid: commitCompare.commitOid,
          parentOid: commitCompare.parentOid,
          filePath: entry.path,
          oldPath: entry.oldPath
        })
      )
    )
  }
  return retainResult(
    withDiffSectionLoadTimeout(
      getRuntimeGitDiff(operation.context, {
        filePath: entry.path,
        staged: 'area' in entry && entry.area === 'staged',
        ...('area' in entry && entry.area === 'staged' && entry.status === 'renamed'
          ? { oldPath: entry.oldPath }
          : {})
      })
    )
  )
}
