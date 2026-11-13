// Which cloud workspaces this window's sidebar already shows: ones this desktop runs (with a row),
// and paired ones whose server has projects in the sidebar. "Open cloud workspace…" leaves these
// out; they open from the sidebar. A pairing whose server is gone is not in the sidebar, so it lists.
import { useEffect, useState } from 'react'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { hasLocalSidebarRow } from './cloud-local-row'
import { firstWorktreeOnHost } from './open-cloud-workspace'

export async function cloudWorkspaceIdsInSidebar(): Promise<Set<string>> {
  const api = window.api.cloudWorkspaces
  const [local, bindings] = await Promise.all([
    api.localWorkspaces().catch(() => []),
    api.environmentBindings().catch(() => ({}))
  ])
  const ids = new Set<string>()
  for (const entry of local) {
    if (hasLocalSidebarRow(entry)) {
      ids.add(entry.sandboxId)
    }
  }
  for (const [sandboxId, binding] of Object.entries(bindings)) {
    if (firstWorktreeOnHost(toRuntimeExecutionHostId(binding.environmentId))) {
      ids.add(sandboxId)
    }
  }
  return ids
}

const NONE: ReadonlySet<string> = new Set()

/** Null until read (the picker shows its skeleton meanwhile); read once per mount. */
export function useCloudWorkspaceIdsInSidebar(enabled: boolean): ReadonlySet<string> | null {
  const [ids, setIds] = useState<ReadonlySet<string> | null>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let disposed = false
    void cloudWorkspaceIdsInSidebar()
      .catch(() => new Set<string>())
      .then((next) => {
        if (!disposed) {
          setIds(next)
        }
      })
    return () => {
      disposed = true
    }
  }, [enabled])
  return enabled ? ids : NONE
}
