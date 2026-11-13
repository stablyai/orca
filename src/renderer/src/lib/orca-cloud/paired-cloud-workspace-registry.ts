// PAIRED-STATUS: registers each PAIRED cloud workspace's own row with the cloud workspace store, so
// its status (state word, hovercard, archive, git-setup) reads through main's paired path like an
// owned one. A paired row is the workspace's own row on a "<name> (cloud)" server that main marked
// `orcaCloudPaired` in the runtime catalog; this desktop has no runtime record for it.
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { eachLimited } from './each-limited'
import {
  pickWorkspaceWorktree,
  type WorkspaceWorktreeCandidate
} from '@/components/cloud-workspaces/workspace-worktree-pick'
import {
  getCloudWorkspaceSnapshot,
  refreshCloudWorkspaceStatus,
  updateCloudWorkspaceSnapshot
} from './orca-cloud-workspace-store'

const STATUS_READ_CONCURRENCY = 4

type RegistryState = {
  worktreesByRepo: Readonly<
    Record<
      string,
      readonly {
        id: string
        hostId?: string | null
        isMainWorktree?: boolean
        branch?: string | null
      }[]
    >
  >
  runtimeEnvironments?: readonly { id: string; orcaCloudPaired?: true }[] | null
}

/**
 * Sidebar id → server environment id, for every paired cloud workspace's own row: per project on a
 * paired server, the workspace's linked worktree (a teammate's shared workspace, where the base
 * checkout is hidden, PAIRED-REGISTRY-ROW), else its main checkout (a GitHub-only workspace).
 */
export function pairedCloudWorkspacesFromState(state: RegistryState): Record<string, string> {
  const paired = new Set(
    (state.runtimeEnvironments ?? [])
      .filter((environment) => environment.orcaCloudPaired === true)
      .map((environment) => environment.id)
  )
  const result: Record<string, string> = {}
  if (paired.size === 0) {
    return result
  }
  for (const worktrees of Object.values(selectWorktreesByRepo(state))) {
    const byEnvironment = new Map<string, WorkspaceWorktreeCandidate[]>()
    for (const worktree of worktrees) {
      const host = parseExecutionHostId(worktree.hostId ?? undefined)
      if (host?.kind !== 'runtime' || !paired.has(host.environmentId)) {
        continue
      }
      const candidates = byEnvironment.get(host.environmentId) ?? []
      candidates.push({
        id: worktree.id,
        branch: worktree.branch,
        isMainWorktree: worktree.isMainWorktree === true
      })
      byEnvironment.set(host.environmentId, candidates)
    }
    for (const [environmentId, candidates] of byEnvironment) {
      const own = pickWorkspaceWorktree(candidates)
      if (own) {
        result[own] = environmentId
      }
    }
  }
  return result
}

/**
 * Registers the paired cloud workspaces' own rows (sidebar id → server environment id). Replaces
 * the whole set; a new one gets one status read, a dropped one loses its status.
 */
export function setPairedCloudWorkspaces(next: Readonly<Record<string, string>>): void {
  const current = getCloudWorkspaceSnapshot().paired
  const keys = Object.keys(next)
  const same =
    keys.length === Object.keys(current).length && keys.every((id) => current[id] === next[id])
  if (same) {
    return
  }
  updateCloudWorkspaceSnapshot((s) => {
    const status = { ...s.status }
    for (const id of Object.keys(s.paired)) {
      if (!(id in next) && !s.ids.has(id)) {
        delete status[id]
      }
    }
    return { paired: { ...next }, status }
  })
  void eachLimited(
    keys.filter((id) => !getCloudWorkspaceSnapshot().status[id]),
    STATUS_READ_CONCURRENCY,
    (id) => refreshCloudWorkspaceStatus(id)
  )
}

/** Keeps the store's paired set current as rows and the catalog change. */
export function installPairedCloudWorkspaceRegistry(): () => void {
  let worktrees: RegistryState['worktreesByRepo'] | null = null
  let environments: RegistryState['runtimeEnvironments'] | null = null
  const sync = (state: RegistryState): void => {
    const byRepo = selectWorktreesByRepo(state)
    if (byRepo === worktrees && state.runtimeEnvironments === environments) {
      return
    }
    worktrees = byRepo
    environments = state.runtimeEnvironments
    setPairedCloudWorkspaces(pairedCloudWorkspacesFromState(state))
  }
  sync(useAppStore.getState())
  return useAppStore.subscribe(sync)
}
