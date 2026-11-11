import { joinPath } from '@/lib/path'
import {
  statRuntimePath,
  isMissingRuntimePathError
} from '@/runtime/files/metadata/runtime-file-metadata-client'
import {
  getRuntimeGitBranchDiff,
  getRuntimeGitCommitDiff,
  getRuntimeGitDiff
} from '@/runtime/source-control/git/runtime-git-diff-client'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type {
  GitBranchChangeEntry,
  GitDiffResult
} from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { acquireCombinedDiffSectionOperation } from './combined-diff-section-connection'
import { withDiffSectionLoadTimeout } from './combined-diff-section-load-timeout'

export async function fetchCombinedDiffSection({
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
  reviewModifiedTime: Promise<number | null | undefined>
  operation: ReturnType<typeof acquireCombinedDiffSectionOperation>
}> {
  const readModifiedTime = () =>
    isCommitMode
      ? Promise.resolve(null)
      : statRuntimePath(operation.context, joinPath(file.filePath, entry.path)).then(
          (stat) => stat.mtime,
          (error: unknown) => (isMissingRuntimePathError(error) ? null : undefined)
        )
  const beforeTime = await readModifiedTime()
  operation.assertCurrent()
  const retainResult = async (result: Promise<GitDiffResult>) => {
    const value = await result
    operation.assertCurrent()
    const reviewModifiedTime = readModifiedTime().then((time) =>
      time === beforeTime ? time : undefined
    )
    return { result: value, operation, reviewModifiedTime }
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
