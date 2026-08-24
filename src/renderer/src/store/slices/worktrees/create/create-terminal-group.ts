import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from '../../../../runtime/runtime-rpc-client'
import { WORKTREE_TERMINAL_GROUP_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import {
  getProjectHostSetupForRepoHost,
  repoHostId,
  withRepoHostOwnership
} from '../listing/worktree-host-ownership'
import { settingsForRepoOwner } from '../listing/worktree-owner-settings'

export function createCreateTerminalGroup(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['createTerminalGroup'] {
  return async ({ repoId, name, telemetrySource }) => {
    // Why no branch/base/setup args: a terminal group runs in the project's existing checkout, so
    // none of the git create path applies — and none of its name-collision retries do either.
    const createArgs = {
      repoId,
      name,
      terminalGroup: true,
      ...(telemetrySource ? { telemetrySource } : {}),
      // Why: manual sort is user-authored order; stamp new workspaces at the top rather than relying on sortOrder fallback.
      ...(get().sortBy === 'manual' ? { manualOrder: Date.now() } : {})
    }
    try {
      const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), repoId))
      if (target.kind === 'environment') {
        // Why: a host that drops `terminalGroup` would create a real worktree and branch instead.
        await assertRuntimeEnvironmentCapability(
          target.environmentId,
          WORKTREE_TERMINAL_GROUP_RUNTIME_CAPABILITY,
          'Update the remote runtime to create terminal groups'
        )
      }
      const result =
        target.kind === 'local'
          ? await window.api.worktrees.create(createArgs)
          : await callRuntimeRpc<Awaited<ReturnType<typeof window.api.worktrees.create>>>(
              target,
              'worktree.create',
              {
                repo: repoId,
                name,
                terminalGroup: true,
                ...(telemetrySource ? { telemetrySource } : {}),
                ...(createArgs.manualOrder !== undefined
                  ? { manualOrder: createArgs.manualOrder }
                  : {})
              }
            )
      // Why: worktrees.onChanged can add this workspace before this callback runs; appending blindly would duplicate it.
      set((s) => {
        const hostId = repoHostId(s, repoId)
        const created = withRepoHostOwnership(
          result.worktree,
          hostId,
          getProjectHostSetupForRepoHost(s, repoId, hostId)
        )
        const current = s.worktreesByRepo[repoId] ?? []
        const alreadyPresent = current.some((worktree) => worktree.id === created.id)
        return {
          worktreesByRepo: {
            ...s.worktreesByRepo,
            [repoId]: alreadyPresent
              ? current.map((worktree) =>
                  worktree.id === created.id ? { ...worktree, ...created } : worktree
                )
              : [...current, created]
          },
          sortEpoch: s.sortEpoch + 1
        }
      })
      return result.worktree
    } catch (err) {
      console.error('Failed to create terminal group:', err)
      throw err
    }
  }
}
