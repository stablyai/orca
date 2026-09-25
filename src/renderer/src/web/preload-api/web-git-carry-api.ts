import {
  GIT_CARRY_WORKING_TREE_CHANGES_RUNTIME_CAPABILITY,
  GIT_CARRY_WORKING_TREE_CHANGES_UPDATE_REQUIRED_MESSAGE
} from '../../../../shared/protocol-version'
import {
  normalizeWorkingTreeCarryResult,
  type WorkingTreeCarryResult
} from '../../../../shared/working-tree-change-carry'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult, getRemoteRuntimeStatus } from './web-runtime-calls'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

export async function carryWorkingTreeChangesOverRuntime(
  sourceWorktreePath: string,
  targetWorktreePath: string
): Promise<WorkingTreeCarryResult> {
  // Why: an older paired host answers method_not_found; refuse honestly before touching either worktree.
  const status = await getRemoteRuntimeStatus().catch(() => null)
  if (!status?.capabilities?.includes(GIT_CARRY_WORKING_TREE_CHANGES_RUNTIME_CAPABILITY)) {
    return {
      ok: false,
      reason: 'apply_failed',
      detail: GIT_CARRY_WORKING_TREE_CHANGES_UPDATE_REQUIRED_MESSAGE
    }
  }
  let selectors: { sourceWorktree: string; targetWorktree: string }
  try {
    const [source, target] = await Promise.all([
      resolveRuntimeWorktreeByPath(sourceWorktreePath),
      resolveRuntimeWorktreeByPath(targetWorktreePath)
    ])
    selectors = {
      sourceWorktree: toRuntimeWorktreeSelector(source.id),
      targetWorktree: toRuntimeWorktreeSelector(target.id)
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'apply_failed',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  const result = await callRuntimeResult<unknown>('git.carryWorkingTreeChanges', selectors, 120_000)
  return normalizeWorkingTreeCarryResult(result)
}
