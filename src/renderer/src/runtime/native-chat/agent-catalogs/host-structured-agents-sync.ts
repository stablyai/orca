import { useEffect } from 'react'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useAppStore } from '@/store/index'
import {
  subscribeStoreWithStatuses,
  runtimeStatusSubscriptionsFor,
  type RuntimeStatuses
} from '@/store/slices/runtime-status/views/runtime-status-subscriptions'
import type { AppState } from '@/store/types'
import {
  forgetHostStructuredAgents,
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
  // Custom ACP agents open only as chats, so defining one is using chats.
  const customAgents = (settings?.customAcpAgents?.length ?? 0) > 0
  if (!customAgents && !(await localStructuredChatsInUse(settings))) {
    return
  }
  void useAppStore.getState().ensureNativeDetectedAgents()
  await loadHostStructuredAgents(
    LOCAL_EXECUTION_HOST_ID,
    await ensureLocalRuntimeCapabilities(),
    null
  )
}

/** Re-reads this machine's agents after its custom ACP agents were saved. */
export async function reloadLocalHostStructuredAgents(): Promise<void> {
  await loadHostStructuredAgents(
    LOCAL_EXECUTION_HOST_ID,
    await ensureLocalRuntimeCapabilities(),
    null,
    true
  )
}

function loadPairedHost(environmentId: string, statuses: RuntimeStatuses): void {
  const status = lastVerifiedRuntimeStatus(statuses.get(environmentId))
  if (status) {
    void loadHostStructuredAgents(
      toRuntimeExecutionHostId(environmentId),
      status.capabilities,
      status.runtimeId
    )
  }
}

function syncPairedHosts(statuses: RuntimeStatuses): void {
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
  const hostStatuses = runtimeStatusSubscriptionsFor(useAppStore)
  void syncLocalHost(initial.settings)
  if (launchesMayOpenChats(initial)) {
    syncPairedHosts(hostStatuses.readStatuses())
  }
  const stopLocal = subscribeLocalRuntimeCapabilitiesKnown(() => {
    if (!readHostStructuredAgentsForRuntime(LOCAL_EXECUTION_HOST_ID, null)) {
      void syncLocalHost(useAppStore.getState().settings)
    }
  })
  const stopStore = subscribeStoreWithStatuses(useAppStore, (state, previousState, statuses) => {
    if (state.settings === previousState.settings) {
      return
    }
    if (launchesMayOpenChats(state) && !launchesMayOpenChats(previousState)) {
      void syncLocalHost(state.settings)
      syncPairedHosts(statuses)
    }
  })
  // A status write re-reads only the hosts it touched; an unpaired host is forgotten without loading the rest.
  const stopStatuses = hostStatuses.subscribeStatusChanges((change) => {
    if (change.deleted.size > 0) {
      forgetHostStructuredAgents([...change.deleted].map(toRuntimeExecutionHostId))
    }
    const state = useAppStore.getState()
    if (!launchesMayOpenChats(state)) {
      return
    }
    // Deleted ids have no status left, so loading them is a no-op.
    for (const environmentId of change.ids) {
      loadPairedHost(environmentId, hostStatuses.readStatuses())
    }
  })
  return () => {
    stopLocal()
    stopStatuses()
    stopStore()
  }
}

export function useHostStructuredAgentsSync(): void {
  useEffect(() => installHostStructuredAgentsSync(), [])
}
