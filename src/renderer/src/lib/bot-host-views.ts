// Each bot host's state for views, apart from bot-catalog so a row reads it without loading the list.
import { useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { readBotHostState, subscribeToBotChanges, type BotHostState } from './bot-catalog-snapshot'

/** Why a listed host's bots can't be reached now: away, or a shared agent's first link still being
 *  made; null while live, or for a host that lists no bots here. Every unreachable check reads this. */
export type BotHostDown = Exclude<BotHostState, 'live'> | null

export function readBotHostDown(hostId: ExecutionHostId): BotHostDown {
  const state = readBotHostState(hostId)
  return state === 'live' ? null : state
}

export function isBotHostDown(hostId: ExecutionHostId): boolean {
  return readBotHostDown(hostId) !== null
}

export function useBotHostDown(hostId: ExecutionHostId): BotHostDown {
  const read = (): BotHostDown => readBotHostDown(hostId)
  return useSyncExternalStore(subscribeToBotChanges, read, read)
}

/** Whether the host's bots show from its last read because it can't be reached now. */
export function useBotHostOffline(hostId: ExecutionHostId): boolean {
  return useBotHostDown(hostId) !== null
}
