import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { perforceTargetForFile } from '@/lib/perforce-workspace-target'
import type { RuntimeGitContext } from './runtime-git-client-context'
import { getRuntimeGitDiff } from './runtime-git-diff-client'
import { runPerforceOperation } from './runtime-perforce-client'

/** A file's working diff from the version control its workspace uses: Perforce, else Git. */
export async function getRuntimeWorktreeFileDiff(
  context: RuntimeGitContext,
  args: { filePath: string; staged: boolean; compareAgainstHead?: boolean }
): Promise<GitDiffResult> {
  const perforce = await perforceTargetForFile(context)
  return perforce
    ? runPerforceOperation(perforce, 'diff', { filePath: args.filePath })
    : getRuntimeGitDiff(context, args)
}
