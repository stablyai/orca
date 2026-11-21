// Each bot host's state for views, apart from bot-catalog so a row reads it without loading the list.
import { useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { readBotHostState, readLiveBotHostIds, subscribeToBotChanges } from './bot-catalog-snapshot'

/** Whether the host's bots show from its last read because it is disconnected. */
export function useBotHostOffline(hostId: ExecutionHostId): boolean {
  const read = (): boolean => readBotHostState(hostId) === 'offline'
  return useSyncExternalStore(subscribeToBotChanges, read, read)
}

const subscribeToNothing = (): (() => void) => () => {}
const NO_HOSTS: readonly ExecutionHostId[] = []
const readNoHosts = (): readonly ExecutionHostId[] => NO_HOSTS

/** The hosts that can be called now; the same array until a host comes or goes, so a list's rows read it
 *  with one subscription and no work on other bot changes. Empty when not `enabled`. */
export function useLiveBotHostIds(enabled: boolean): readonly ExecutionHostId[] {
  return useSyncExternalStore(
    enabled ? subscribeToBotChanges : subscribeToNothing,
    enabled ? readLiveBotHostIds : readNoHosts,
    enabled ? readLiveBotHostIds : readNoHosts
  )
}
