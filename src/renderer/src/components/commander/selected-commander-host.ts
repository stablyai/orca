import { translate } from '@/i18n/i18n'
import { useSyncExternalStore } from 'react'
import { listBotHosts, ownBotHost, type BotHost } from '@/lib/bot-hosts'
import { readLiveBotHostIds, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

let selectedId = ownBotHost().hostId
const listeners = new Set<() => void>()

export function selectCommanderHost(id: string): void {
  const host = listBotHosts().find((candidate) => candidate.hostId === id)
  if (host && selectedId !== host.hostId) {
    selectedId = host.hostId
    listeners.forEach((listener) => listener())
  }
}

export function selectedCommanderHost(): BotHost {
  const host = listBotHosts().find((candidate) => candidate.hostId === selectedId)
  if (!host) {
    throw new Error(
      translate(
        'commander.hostUnavailable',
        'The selected Commander host is offline. Reconnect it or select another host.'
      )
    )
  }
  return host
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCommanderHostOptions(): {
  selected: ExecutionHostId
  live: readonly ExecutionHostId[]
} {
  const selected = useSyncExternalStore(subscribe, () => selectedId)
  const live = useSyncExternalStore(subscribeToBotChanges, readLiveBotHostIds)
  return { selected, live }
}
