import { useEffect, useSyncExternalStore } from 'react'
import type { McpSyncStatus } from '../../../../shared/agent-mcp-sync/mcp-sync-contract'

// Main owns the status; this mirrors its broadcasts for any number of menus and dialogs.
const statuses = new Map<string, McpSyncStatus | null>()
const listeners = new Set<() => void>()
let unsubscribeMain: (() => void) | null = null

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  unsubscribeMain ??=
    window.api.runtimeEnvironments.onMcpSyncChanged?.((status) => {
      statuses.set(status.environmentId, status)
      emit()
    }) ?? null
  return () => {
    listeners.delete(listener)
  }
}

export async function refreshCloudMcpSyncStatus(environmentId: string): Promise<void> {
  const status = await window.api.runtimeEnvironments
    .getMcpSyncStatus?.(environmentId)
    .catch(() => null)
  statuses.set(environmentId, status ?? null)
  emit()
}

export async function syncCloudMcpServersNow(environmentId: string): Promise<void> {
  const status = await window.api.runtimeEnvironments.syncMcpServersNow?.(environmentId)
  if (status) {
    statuses.set(environmentId, status)
    emit()
  }
}

/** Null until main answers, and for hosts that are not Orca Cloud workspaces. */
export function useCloudMcpSyncStatus(
  environmentId: string | null,
  refresh: boolean
): McpSyncStatus | null {
  const status = useSyncExternalStore(subscribe, () =>
    environmentId ? (statuses.get(environmentId) ?? null) : null
  )
  useEffect(() => {
    if (environmentId && refresh) {
      void refreshCloudMcpSyncStatus(environmentId)
    }
  }, [environmentId, refresh])
  return status
}
