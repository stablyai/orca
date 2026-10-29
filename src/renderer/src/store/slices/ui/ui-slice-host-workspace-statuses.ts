import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { normalizeWorkspaceStatuses } from '../../../../../shared/workspace-statuses'
import { callRuntimeRpc } from '../../../runtime/runtime-rpc-client'
import type { WorkspaceStatusDefinition } from '../../../../../shared/worktree/types'

function sameWorkspaceStatuses(
  a: readonly WorkspaceStatusDefinition[] | undefined,
  b: readonly WorkspaceStatusDefinition[]
): boolean {
  return (
    a?.length === b.length &&
    a.every(
      (status, index) =>
        status.id === b[index]?.id &&
        status.label === b[index]?.label &&
        status.color === b[index]?.color &&
        status.icon === b[index]?.icon
    )
  )
}

/** Each paired runtime host's own board columns, read from the host and never persisted locally. */
export function createHostWorkspaceStatusActions(
  set: UISliceSet,
  get: UISliceGet
): Pick<
  UISlice,
  'hostWorkspaceStatuses' | 'fetchHostWorkspaceStatuses' | 'clearHostWorkspaceStatuses'
> {
  const hostStatusRequests = new Map<string, number>()
  return {
    hostWorkspaceStatuses: {},
    fetchHostWorkspaceStatuses: async (environmentId) => {
      const request = (hostStatusRequests.get(environmentId) ?? 0) + 1
      hostStatusRequests.set(environmentId, request)
      try {
        const { ui } = await callRuntimeRpc<{ ui: { workspaceStatuses?: unknown } }>(
          { kind: 'environment', environmentId },
          'ui.get',
          undefined,
          { timeoutMs: 15_000, reuseRecentCompatibilityFailure: true }
        )
        // A reply older than the latest request may predate a column edit on the host.
        if (hostStatusRequests.get(environmentId) !== request) {
          return
        }
        // Why no defaults: a host that sends no columns adds none to this board.
        const statuses = Array.isArray(ui.workspaceStatuses)
          ? normalizeWorkspaceStatuses(ui.workspaceStatuses)
          : []
        if (sameWorkspaceStatuses(get().hostWorkspaceStatuses[environmentId], statuses)) {
          return
        }
        set((s) => ({
          hostWorkspaceStatuses: { ...s.hostWorkspaceStatuses, [environmentId]: statuses }
        }))
      } catch (err) {
        // An unreachable host keeps its last columns.
        console.warn(`Skipped workspace statuses for runtime environment ${environmentId}:`, err)
      }
    },
    clearHostWorkspaceStatuses: (environmentIds) => {
      // Why bump: a retired peer's in-flight reply must not restore its columns.
      for (const id of environmentIds) {
        hostStatusRequests.set(id, (hostStatusRequests.get(id) ?? 0) + 1)
      }
      const current = get().hostWorkspaceStatuses
      if (!environmentIds.some((id) => id in current)) {
        return
      }
      const next = { ...current }
      for (const id of environmentIds) {
        delete next[id]
      }
      set({ hostWorkspaceStatuses: next })
    }
  }
}
