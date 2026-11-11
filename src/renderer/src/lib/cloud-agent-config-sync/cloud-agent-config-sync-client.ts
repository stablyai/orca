import { useEffect, useSyncExternalStore } from 'react'
import type {
  AgentConfigSyncStatus,
  CloudAgentConfigSyncPreferences
} from '../../../../shared/agent-config-sync/agent-config-sync-contract'

// Main owns status and preferences; this mirrors its broadcasts for every open panel.
const statuses = new Map<string, AgentConfigSyncStatus | null>()
// Bumped by every broadcast so a slower reply can't overwrite newer state.
const versions = new Map<string, number>()
let preferences: CloudAgentConfigSyncPreferences | null | undefined
let preferencesVersion = 0
const listeners = new Set<() => void>()
let subscribedToMain = false

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function storeStatus(status: AgentConfigSyncStatus): void {
  statuses.set(status.environmentId, status)
  versions.set(status.environmentId, (versions.get(status.environmentId) ?? 0) + 1)
  emit()
}

function storePreferences(next: CloudAgentConfigSyncPreferences): void {
  preferences = next
  preferencesVersion += 1
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!subscribedToMain) {
    subscribedToMain = true
    const api = window.api.runtimeEnvironments
    api.onAgentConfigSyncChanged?.(storeStatus)
    api.onAgentConfigSyncPreferencesChanged?.(storePreferences)
  }
  return () => {
    listeners.delete(listener)
  }
}

async function refreshStatus(environmentId: string): Promise<void> {
  const asked = versions.get(environmentId) ?? 0
  const status = await window.api.runtimeEnvironments
    .getAgentConfigSyncStatus?.(environmentId)
    .catch(() => undefined)
  if (status === undefined || (versions.get(environmentId) ?? 0) !== asked) {
    return
  }
  statuses.set(environmentId, status)
  emit()
}

async function refreshPreferences(): Promise<void> {
  const asked = preferencesVersion
  const next = await window.api.runtimeEnvironments
    .getAgentConfigSyncPreferences?.()
    .catch(() => undefined)
  if (next === undefined || preferencesVersion !== asked) {
    return
  }
  preferences = next
  emit()
}

/** Undefined until main answers; null for hosts that are not Orca Cloud workspaces. */
export function useCloudAgentConfigSyncStatus(
  environmentId: string
): AgentConfigSyncStatus | null | undefined {
  const status = useSyncExternalStore(subscribe, () => statuses.get(environmentId))
  useEffect(() => {
    void refreshStatus(environmentId)
  }, [environmentId])
  return status
}

/** Undefined while loading; null in builds without Orca Cloud. */
export function useCloudAgentConfigSyncPreferences():
  | CloudAgentConfigSyncPreferences
  | null
  | undefined {
  const value = useSyncExternalStore(subscribe, () => preferences)
  useEffect(() => {
    void refreshPreferences()
  }, [])
  return value
}

/** Main broadcasts every state this passes through, so the replies are not stored here. */
export async function syncCloudAgentConfigNow(environmentId: string): Promise<void> {
  await window.api.runtimeEnvironments.syncAgentConfigNow?.(environmentId)
}

export async function setCloudAgentConfigSyncPreferences(
  next: Partial<Omit<CloudAgentConfigSyncPreferences, 'excluded'>>
): Promise<void> {
  await window.api.runtimeEnvironments.setAgentConfigSyncPreferences?.(next)
}

export async function setCloudAgentConfigItemIncluded(
  key: string,
  included: boolean
): Promise<void> {
  await window.api.runtimeEnvironments.setAgentConfigItemIncluded?.(key, included)
}
