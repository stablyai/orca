import { useEffect } from 'react'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useAppStore } from '@/store/index'
import { runtimeStatusSubscriptionsFor } from '@/store/slices/runtime-status/views/runtime-status-subscriptions'
import type { AppState } from '@/store/types'
import {
  loadHostStructuredAgents,
  readHostStructuredAgentsForRuntime,
  retainHostStructuredAgents
} from './host-structured-agents'
import {
  ensureLocalRuntimeCapabilities,
  subscribeLocalRuntimeCapabilitiesKnown
} from '../../hosts/capabilities/local-runtime-capabilities'
import {
  localStructuredChatsInUse,
  newAgentLaunchesMayOpenChats
} from '../local-sessions/local-structured-chats'

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

function loadPairedHost(
  environmentId: string,
  statuses: AppState['runtimeStatusByEnvironmentId']
): void {
  const status = lastVerifiedRuntimeStatus(statuses.get(environmentId))
  if (status) {
    void loadHostStructuredAgents(
      toRuntimeExecutionHostId(environmentId),
      status.capabilities,
      status.runtimeId
    )
  }
}

function syncPairedHosts(statuses: AppState['runtimeStatusByEnvironmentId']): void {
  const hostIds = new Set<string>([LOCAL_EXECUTION_HOST_ID])
  for (const environmentId of statuses.keys()) {
    hostIds.add(toRuntimeExecutionHostId(environmentId))
    loadPairedHost(environmentId, statuses)
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
    if (turnedOn) {
      syncPairedHosts(state.runtimeStatusByEnvironmentId)
    }
  })
  // A status write re-reads only the hosts it touched; dropping a host retains the rest.
  const stopStatuses = runtimeStatusSubscriptionsFor(useAppStore).subscribeStatusChanges(
    (change) => {
      const state = useAppStore.getState()
      if (!launchesMayOpenChats(state)) {
        return
      }
      const statuses = state.runtimeStatusByEnvironmentId
      if (change.deleted.size > 0) {
        syncPairedHosts(statuses)
        return
      }
      for (const environmentId of change.ids) {
        loadPairedHost(environmentId, statuses)
      }
    }
  )
  return () => {
    stopLocal()
    stopStatuses()
    stopStore()
  }
}

export function useHostStructuredAgentsSync(): void {
  useEffect(() => installHostStructuredAgentsSync(), [])
}
