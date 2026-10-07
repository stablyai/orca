import { useEffect } from 'react'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { loadHostStructuredAgents, retainHostStructuredAgents } from './host-structured-agents'
import { ensureLocalRuntimeCapabilities } from './local-runtime-capabilities'
import { localStructuredChatsInUse } from './local-structured-chats'

// Why gated: asking a host for its agents installs its structured host, which a profile that never
// uses structured chat must not pay for; only with chats in use can a launch route to one.
function structuredChatSettingOn(state: Pick<AppState, 'settings'>): boolean {
  return state.settings?.experimentalStructuredNativeChat === true
}

async function syncLocalHost(settings: AppState['settings']): Promise<void> {
  if (!(await localStructuredChatsInUse(settings))) {
    return
  }
  await loadHostStructuredAgents(
    LOCAL_EXECUTION_HOST_ID,
    await ensureLocalRuntimeCapabilities(),
    null
  )
}

function syncPairedHosts(statuses: AppState['runtimeStatusByEnvironmentId']): void {
  const hostIds = new Set<string>([LOCAL_EXECUTION_HOST_ID])
  for (const [environmentId, entry] of statuses) {
    const executionHostId = toRuntimeExecutionHostId(environmentId)
    hostIds.add(executionHostId)
    const status = lastVerifiedRuntimeStatus(entry)
    if (status) {
      void loadHostStructuredAgents(executionHostId, status.capabilities, status.runtimeId)
    }
  }
  retainHostStructuredAgents(hostIds)
}

/** Reads each host's registered agents once its status says it publishes them and structured chat
 *  is in use, and again when a paired host's runtime changes. Returns the unsubscribe. */
export function installHostStructuredAgentsSync(): () => void {
  const initial = useAppStore.getState()
  void syncLocalHost(initial.settings)
  if (structuredChatSettingOn(initial)) {
    syncPairedHosts(initial.runtimeStatusByEnvironmentId)
  }
  return useAppStore.subscribe((state, previousState) => {
    const on = structuredChatSettingOn(state)
    const turnedOn = on && !structuredChatSettingOn(previousState)
    if (turnedOn) {
      void syncLocalHost(state.settings)
    }
    if (
      on &&
      (turnedOn ||
        state.runtimeStatusByEnvironmentId !== previousState.runtimeStatusByEnvironmentId)
    ) {
      syncPairedHosts(state.runtimeStatusByEnvironmentId)
    }
  })
}

export function useHostStructuredAgentsSync(): void {
  useEffect(() => installHostStructuredAgentsSync(), [])
}
