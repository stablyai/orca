import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'

/**
 * Stops a project's shells on its runtime host ahead of `repo.rm`: the host resolves
 * `terminal.stop` through the project's workspace rows, which `repo.rm` deletes.
 */
export async function stopRuntimeProjectTerminalsBeforeRemoval(
  environmentId: string,
  projectId: string,
  worktreeIds: readonly string[]
): Promise<void> {
  const target = { kind: 'environment', environmentId } as const
  // Preflight shared repo resolver before stopping shells; refused/ambiguous removals must leave them running.
  const hostResolvesProject = await callRuntimeRpc(
    target,
    'repo.show',
    { repo: projectId },
    { timeoutMs: 15_000 }
  ).then(
    () => true,
    () => false
  )
  if (!hostResolvesProject) {
    return
  }
  await Promise.allSettled(
    worktreeIds.map((worktreeId) =>
      callRuntimeRpc(
        target,
        'terminal.stop',
        { worktree: toRuntimeWorktreeSelector(worktreeId) },
        { timeoutMs: 15_000 }
      )
    )
  )
}
