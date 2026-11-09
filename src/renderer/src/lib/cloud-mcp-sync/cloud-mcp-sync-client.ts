import { useEffect, useSyncExternalStore } from 'react'
import type { McpSyncStatus } from '../../../../shared/agent-mcp-sync/mcp-sync-contract'

// Main owns the status; this mirrors its broadcasts for any number of menus and panels.
const statuses = new Map<string, McpSyncStatus | null>()
// Bumped by every broadcast so a slower status reply can't overwrite newer state.
const versions = new Map<string, number>()
const listeners = new Set<() => void>()
let subscribedToMain = false

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function store(status: McpSyncStatus): void {
  statuses.set(status.environmentId, status)
  versions.set(status.environmentId, (versions.get(status.environmentId) ?? 0) + 1)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!subscribedToMain) {
    // One app-lifetime listener; main broadcasts to every window.
    subscribedToMain = true
    window.api.runtimeEnvironments.onMcpSyncChanged?.(store)
  }
  return () => {
    listeners.delete(listener)
  }
}

export async function refreshCloudMcpSyncStatus(environmentId: string): Promise<void> {
  const asked = versions.get(environmentId) ?? 0
  const status = await window.api.runtimeEnvironments
    .getMcpSyncStatus?.(environmentId)
    .catch(() => undefined)
  if (status === undefined || (versions.get(environmentId) ?? 0) !== asked) {
    return
  }
  if (status) {
    store(status)
  } else {
    statuses.set(environmentId, null)
    emit()
  }
}

/** Main broadcasts every state this passes through, so the reply itself is not stored. */
export async function syncCloudMcpServersNow(environmentId: string): Promise<void> {
  await window.api.runtimeEnvironments.syncMcpServersNow?.(environmentId)
}

/** Undefined until main answers; null for hosts that are not Orca Cloud workspaces. */
export function useCloudMcpSyncStatus(
  environmentId: string | null,
  refresh: boolean
): McpSyncStatus | null | undefined {
  const status = useSyncExternalStore(subscribe, () =>
    environmentId ? statuses.get(environmentId) : null
  )
  useEffect(() => {
    if (environmentId && refresh) {
      void refreshCloudMcpSyncStatus(environmentId)
    }
  }, [environmentId, refresh])
  return status
}
