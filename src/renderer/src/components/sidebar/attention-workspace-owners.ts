import { isUnifiedTabOwnedByWorktree } from '@/lib/unified-tab-host-ownership'
import type { AppState } from '@/store/types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'

/** A waiting hook row whose tab never mirrored; `connectionId` is its local transport, null when none. */
export type UnmirroredAttentionRow = { connectionId: string | null }

/** Which tabs of one workspace id wait on the user, plus waiting hook rows with no mirrored tab. */
export type AttentionTabsByWorkspaceId = ReadonlyMap<
  string,
  readonly (string | UnmirroredAttentionRow)[]
>

export type AttentionOwnerState = Pick<
  AppState,
  'folderWorkspaces' | 'unifiedTabsByWorktree' | 'worktreesByRepo'
>

function indexWorkspacesById(
  state: AttentionOwnerState,
  wantedIds: ReadonlySet<string>
): Map<string, Pick<Worktree, 'hostId' | 'id' | 'runtimeOwnerEnvironmentId'>[]> {
  const byId = new Map<string, Pick<Worktree, 'hostId' | 'id' | 'runtimeOwnerEnvironmentId'>[]>()
  const seenIdentities = new Set<string>()
  const add = (workspace: Pick<Worktree, 'hostId' | 'id' | 'runtimeOwnerEnvironmentId'>): void => {
    const identity = getWorktreeHostIdentity(workspace)
    if (seenIdentities.has(identity)) {
      return
    }
    seenIdentities.add(identity)
    const bucket = byId.get(workspace.id)
    if (bucket) {
      bucket.push(workspace)
    } else {
      byId.set(workspace.id, [workspace])
    }
  }
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      if (wantedIds.has(worktree.id)) {
        add(worktree)
      }
    }
  }
  // Why: folder workspaces are host-qualified too, so twins of one folder id need the same split.
  for (const folderWorkspace of state.folderWorkspaces ?? []) {
    if (wantedIds.has(folderWorkspaceKey(folderWorkspace.id))) {
      add(folderWorkspaceToWorktree(folderWorkspace))
    }
  }
  return byId
}

/**
 * The attention set in the badge's key space: every workspace as its host identity, so one id on
 * two hosts lights only the host whose tab waits; an id no catalog knows by its bare key.
 *
 * Twins are split by the tab-bar rule (`isUnifiedTabOwnedByWorktree`); a hook row with no mirrored
 * tab by its SSH connection. A tab with no host stamp, or a row with no connection, lights neither.
 */
export function resolveAttentionWorkspaceKeys(
  attentionTabs: AttentionTabsByWorkspaceId,
  state: AttentionOwnerState
): ReadonlySet<string> {
  const keys = new Set<string>()
  if (attentionTabs.size === 0) {
    return keys
  }
  const workspacesById = indexWorkspacesById(state, new Set(attentionTabs.keys()))
  for (const [workspaceId, tabIds] of attentionTabs) {
    const candidates = workspacesById.get(workspaceId)
    if (!candidates) {
      keys.add(workspaceId)
      continue
    }
    // Why: with no twin there is nothing to disambiguate, and legacy tabs of SSH workspaces carry
    // a wrong `local` stamp that the strict host check would reject.
    if (candidates.length === 1) {
      keys.add(getWorktreeHostIdentity(candidates[0]))
      continue
    }
    const ambiguousIds: ReadonlySet<string> = new Set([workspaceId])
    const unifiedTabs = state.unifiedTabsByWorktree?.[workspaceId] ?? []
    for (const candidate of candidates) {
      const owned = tabIds.some((tabId) => {
        if (typeof tabId !== 'string') {
          // Why: paired rows arrive with connectionId stripped, so null cannot pick a twin.
          return (
            tabId.connectionId !== null &&
            candidate.hostId === getConnectionExecutionHostId(tabId.connectionId)
          )
        }
        const unifiedTab = unifiedTabs.find(
          (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
        )
        return unifiedTab ? isUnifiedTabOwnedByWorktree(unifiedTab, candidate, ambiguousIds) : false
      })
      if (owned) {
        keys.add(getWorktreeHostIdentity(candidate))
      }
    }
  }
  return keys
}
