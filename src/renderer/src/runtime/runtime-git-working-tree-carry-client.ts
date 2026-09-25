import { GIT_CARRY_WORKING_TREE_CHANGES_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  normalizeWorkingTreeCarryResult,
  type WorkingTreeCarryResult
} from '../../../shared/working-tree-change-carry'
import { ensureLocalRuntimeCapabilities } from './local-runtime-capabilities'
import type { RuntimeGitContext } from './runtime-git-client-context'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export const WORKING_TREE_CARRY_RUNTIME_CAPABILITY =
  GIT_CARRY_WORKING_TREE_CHANGES_RUNTIME_CAPABILITY

export type WorkingTreeCarryContext = {
  settings: RuntimeGitContext['settings']
  connectionId?: string
  source: { worktreeId: string; worktreePath: string }
  target: { worktreeId: string; worktreePath: string }
}

export async function isWorkingTreeCarrySupported(
  settings: RuntimeGitContext['settings']
): Promise<boolean> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    // Why: in the web client the "local" runtime is the paired host, which may predate the method.
    const capabilities = await ensureLocalRuntimeCapabilities()
    // Why: an unanswered probe is not evidence; the web shim still refuses an old host honestly.
    return capabilities === null || capabilities.includes(WORKING_TREE_CARRY_RUNTIME_CAPABILITY)
  }
  return runtimeEnvironmentSupportsCapability(
    target.environmentId,
    WORKING_TREE_CARRY_RUNTIME_CAPABILITY,
    10_000
  )
}

export async function carryRuntimeWorkingTreeChanges(
  context: WorkingTreeCarryContext
): Promise<WorkingTreeCarryResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment') {
    // Why: local IPC routes an SSH worktree to its host by connectionId.
    return window.api.git.carryWorkingTreeChanges({
      sourceWorktreePath: context.source.worktreePath,
      targetWorktreePath: context.target.worktreePath,
      connectionId: context.connectionId
    })
  }
  return normalizeWorkingTreeCarryResult(
    await callRuntimeRpc<unknown>(
      target,
      'git.carryWorkingTreeChanges',
      {
        sourceWorktree: toRuntimeWorktreeSelector(context.source.worktreeId),
        targetWorktree: toRuntimeWorktreeSelector(context.target.worktreeId)
      },
      { timeoutMs: 120_000 }
    )
  )
}
