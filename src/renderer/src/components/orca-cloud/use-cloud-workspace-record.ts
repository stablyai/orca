import { useCallback, useEffect, useState } from 'react'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'

/**
 * The team's record of the cloud workspace behind a sidebar row (visibility, access), so the
 * sidebar menu can offer the same Share actions as Home. Owned workspaces are found through this
 * desktop's runtime; paired ones through their pairing. Null until loaded or when there is none.
 */
export function useCloudWorkspaceRecord(
  worktreeId: string,
  hostId: string | null | undefined
): { workspace: CloudWorkspace | null; reload: () => void } {
  const [workspace, setWorkspace] = useState<CloudWorkspace | null>(null)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api?.cloudWorkspaces : undefined
    if (!api) {
      return
    }
    let cancelled = false
    void (async () => {
      const sandboxId = await resolveSandboxId(api, worktreeId, hostId)
      const result = sandboxId ? await api.get(sandboxId).catch(() => null) : null
      if (!cancelled) {
        setWorkspace(result?.ok ? result.value : null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [worktreeId, hostId, generation])
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  return { workspace, reload }
}

async function resolveSandboxId(
  api: NonNullable<Window['api']>['cloudWorkspaces'],
  worktreeId: string,
  hostId: string | null | undefined
): Promise<string | null> {
  const local = (await api.localWorkspaces().catch(() => [])).find(
    (entry) => entry.worktreeId === worktreeId
  )
  if (local) {
    return local.sandboxId
  }
  if (!hostId) {
    return null
  }
  const bindings = await api.environmentBindings().catch(() => ({}))
  for (const [sandboxId, binding] of Object.entries(bindings)) {
    if (toRuntimeExecutionHostId(binding.environmentId) === hostId) {
      return sandboxId
    }
  }
  return null
}
