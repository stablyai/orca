import { useEffect } from 'react'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import {
  readRuntimeStatuses,
  subscribeRuntimeStatuses,
  type RuntimeStatuses
} from '@/store/slices/runtime-status/views/runtime-status-owner'
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

function syncPairedHosts(statuses: RuntimeStatuses): void {
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
    syncPairedHosts(readRuntimeStatuses())
  }
  const stopLocal = subscribeLocalRuntimeCapabilitiesKnown(() => {
    if (!readHostStructuredAgentsForRuntime(LOCAL_EXECUTION_HOST_ID, null)) {
      void syncLocalHost(useAppStore.getState().settings)
    }
  })
  const stopStore = useAppStore.subscribe((state, previousState) => {
    if (launchesMayOpenChats(state) && !launchesMayOpenChats(previousState)) {
      void syncLocalHost(state.settings)
      syncPairedHosts(readRuntimeStatuses())
    }
  })
  const stopStatuses = subscribeRuntimeStatuses(() => {
    if (launchesMayOpenChats(useAppStore.getState())) {
      syncPairedHosts(readRuntimeStatuses())
    }
  })
  return () => {
    stopLocal()
    stopStore()
    stopStatuses()
  }
}

export function useHostStructuredAgentsSync(): void {
  useEffect(() => installHostStructuredAgentsSync(), [])
}
