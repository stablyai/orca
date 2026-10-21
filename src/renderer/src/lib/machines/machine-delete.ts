import { toast } from 'sonner'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { describeMachineActionFailure } from './machine-copy'
import { getMachineDisplayState, getMachineDisplayStateLabel } from './machine-display-state'
import type { MachineMatch } from './machine-host-match'

/**
 * Deletes the machine, then removes its worktrees from Orca. The files went with the machine,
 * so the removal only forgets Orca's records, the same path as forgetting an unreachable host.
 */
export async function deleteMachineWithWorktrees(
  match: MachineMatch,
  worktrees: readonly Pick<Worktree, 'id' | 'repoId' | 'hostId'>[],
  repos: readonly Repo[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = match.machine.name
  const deleted = await window.api.machines
    .delete({ providerKey: match.snapshot.providerKey, machineId: match.machine.id })
    .catch((error: unknown) => ({
      ok: false as const,
      code: 'unavailable' as const,
      message: error instanceof Error ? error.message : String(error)
    }))
  if (!deleted.ok) {
    return { ok: false, error: describeMachineActionFailure(deleted.code, name) }
  }
  // Why: main answers with the machine as the provider left it; only `gone` proves the files went.
  if (deleted.value.state !== 'gone') {
    return {
      ok: false,
      error: translate(
        'auto.lib.machines.machineDelete.stillThere',
        '{{name}} wasn’t deleted. The provider still lists it as {{state}}.',
        {
          name,
          state: getMachineDisplayStateLabel(getMachineDisplayState(deleted.value.state))
        }
      )
    }
  }
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const removals = await Promise.all(
    worktrees.map((worktree) =>
      useAppStore
        .getState()
        .removeWorktree(
          {
            id: worktree.id,
            executionHostId: getWorktreeExecutionHostId(worktree, repoById.get(worktree.repoId))
          },
          false,
          { mode: 'forget-local' }
        )
        .then((result) => result.ok)
        .catch(() => false)
    )
  )
  const left = removals.filter((removed) => !removed).length
  if (left > 0) {
    toast.warning(
      translate(
        'auto.lib.machines.machineDelete.worktreesLeft',
        'Deleted {{name}}, but {{count}} of its worktrees are still listed. Remove them from their menu.',
        { name, count: left }
      )
    )
  }
  return { ok: true }
}
