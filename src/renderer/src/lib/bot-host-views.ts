// Each bot host's state for views, apart from bot-catalog so a row reads it without loading the list.
import { useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { readBotHostState, subscribeToBotChanges } from './bot-catalog-snapshot'

/** Whether the host's bots show from its last read because it is disconnected. */
export function useBotHostOffline(hostId: ExecutionHostId): boolean {
  const read = (): boolean => readBotHostState(hostId) === 'offline'
  return useSyncExternalStore(subscribeToBotChanges, read, read)
}
