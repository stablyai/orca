import {
  normalizeWorkingTreeCarryResult,
  type WorkingTreeCarryResult
} from '../../../../shared/working-tree-change-carry'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

export async function carryWorkingTreeChangesOverRuntime(
  sourceWorktreePath: string,
  targetWorktreePath: string
): Promise<WorkingTreeCarryResult> {
  const [source, target] = await Promise.all([
    resolveRuntimeWorktreeByPath(sourceWorktreePath),
    resolveRuntimeWorktreeByPath(targetWorktreePath)
  ])
  const result = await callRuntimeResult<unknown>(
    'git.carryWorkingTreeChanges',
    {
      sourceWorktree: toRuntimeWorktreeSelector(source.id),
      targetWorktree: toRuntimeWorktreeSelector(target.id)
    },
    120_000
  )
  return normalizeWorkingTreeCarryResult(result)
}
