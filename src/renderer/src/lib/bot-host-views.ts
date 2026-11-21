// Each bot host's state for views, apart from bot-catalog so a row reads it without loading the list.
import { useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { readBotHostIds, readBotHostState, subscribeToBotChanges } from './bot-catalog-snapshot'

/** Whether the host's bots show from its last read because it is disconnected. */
export function useBotHostOffline(hostId: ExecutionHostId): boolean {
  const read = (): boolean => readBotHostState(hostId) === 'offline'
  return useSyncExternalStore(subscribeToBotChanges, read, read)
}

function readOfflineBotHostIds(): string {
  return readBotHostIds()
    .filter((hostId) => readBotHostState(hostId) === 'offline')
    .join('\n')
}

/** The disconnected hosts, one per line: one subscription for a whole list's rows. */
export function useOfflineBotHostIds(): string {
  return useSyncExternalStore(subscribeToBotChanges, readOfflineBotHostIds, readOfflineBotHostIds)
}
