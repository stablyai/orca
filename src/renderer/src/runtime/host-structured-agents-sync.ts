import { useEffect } from 'react'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  loadHostStructuredAgents,
  readHostStructuredAgentsForRuntime,
  retainHostStructuredAgents
} from './host-structured-agents'
import {
  ensureLocalRuntimeCapabilities,
  subscribeLocalRuntimeCapabilitiesKnown
} from './local-runtime-capabilities'
import { localStructuredChatsInUse, newAgentLaunchesMayOpenChats } from './local-structured-chats'

// Older hosts install structured storage just to answer; ask only with chats in use so unused profiles avoid that cost.
function launchesMayOpenChats(state: Pick<AppState, 'settings'>): boolean {
  return newAgentLaunchesMayOpenChats(state.settings)
}

async function syncLocalHost(settings: AppState['settings']): Promise<void> {
  if (!(await localStructuredChatsInUse(settings))) {
    return
  }
  void useAppStore.getState().ensureNativeDetectedAgents()
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

/** Read registered agents when structured chat is in use and host capabilities arrive; paired runtime changes re-read. Local Chat | CLI choice and capability changes retry early unknown reads. Returns unsubscribe. */
export function installHostStructuredAgentsSync(): () => void {
  const initial = useAppStore.getState()
  void syncLocalHost(initial.settings)
  if (launchesMayOpenChats(initial)) {
    syncPairedHosts(initial.runtimeStatusByEnvironmentId)
  }
  const stopLocal = subscribeLocalRuntimeCapabilitiesKnown(() => {
    if (!readHostStructuredAgentsForRuntime(LOCAL_EXECUTION_HOST_ID, null)) {
      void syncLocalHost(useAppStore.getState().settings)
    }
  })
  const stopStore = useAppStore.subscribe((state, previousState) => {
    const on = launchesMayOpenChats(state)
    const turnedOn = on && !launchesMayOpenChats(previousState)
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
  return () => {
    stopLocal()
    stopStore()
  }
}

export function useHostStructuredAgentsSync(): void {
  useEffect(() => installHostStructuredAgentsSync(), [])
}
