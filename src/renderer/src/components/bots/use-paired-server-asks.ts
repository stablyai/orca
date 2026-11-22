import { useSyncExternalStore } from 'react'
import type { Bot } from '../../../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  PairedServerAskList,
  type PairedServerAskCard
} from '../../../../shared/rpc-contract/paired-server-asks-params'
import { callBotRpc, ownBotHost } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { createBotHostRead, useBotHostRead } from './use-bot-host-read'

const NO_CARDS: readonly PairedServerAskCard[] = []

// An older host has no such cards to show.
const isMethodNotFound = (error: unknown): boolean =>
  error instanceof RuntimeRpcCallError && error.code === 'method_not_found'

// A card comes and goes with a `chats` notice for its bot.
const botCardsRead = createBotHostRead<readonly PairedServerAskCard[]>(
  'pairedServerAsks.list',
  (result: never) => result,
  'Failed to read messages waiting from paired servers:',
  ['chats'],
  0,
  false,
  {
    partsOf: () => null,
    maxParts: 0,
    load: async (bot) => {
      try {
        const read = await callBotRpc(bot, 'pairedServerAsks.list', { botId: bot.id })
        return PairedServerAskList.parse(read).cards
      } catch (error) {
        if (isMethodNotFound(error)) {
          return NO_CARDS
        }
        throw error
      }
    }
  }
)

/** Agents on paired servers waiting for a person to let them message `bot`, read from its host. */
export function usePairedServerAsks(bot: Bot | null): readonly PairedServerAskCard[] {
  return useBotHostRead(botCardsRead, bot) ?? NO_CARDS
}

// Every card this computer holds, for the server chats they are answered in.
let localCards: readonly PairedServerAskCard[] = NO_CARDS
let localReading: Promise<void> | null = null
let localAgain = false
const localListeners = new Set<() => void>()
let stopLocalNotices: (() => void) | null = null

function readLocalCards(): void {
  if (localReading) {
    localAgain = true
    return
  }
  localReading = callRuntimeRpc(ownBotHost().target, 'pairedServerAsks.list', {})
    .then((read) => {
      localCards = PairedServerAskList.parse(read).cards
      localListeners.forEach((listener) => listener())
    })
    .catch((error: unknown) => {
      if (!isMethodNotFound(error)) {
        console.error('Failed to read messages waiting from paired servers:', error)
      }
    })
    .finally(() => {
      localReading = null
      if (localAgain) {
        localAgain = false
        readLocalCards()
      }
    })
}

function subscribeLocalCards(listener: () => void): () => void {
  localListeners.add(listener)
  if (!stopLocalNotices) {
    stopLocalNotices = onBotsChanged(readLocalCards, LOCAL_EXECUTION_HOST_ID, { kinds: ['chats'] })
    readLocalCards()
  }
  return () => {
    localListeners.delete(listener)
    if (localListeners.size === 0) {
      stopLocalNotices?.()
      stopLocalNotices = null
    }
  }
}

const readLocalSnapshot = (): readonly PairedServerAskCard[] => localCards
const readNoCards = (): readonly PairedServerAskCard[] => NO_CARDS
const subscribeToNothing = (): (() => void) => () => {}

/** The cards this computer holds for asks from one chat on a paired server (its root chat). */
export function usePairedServerCardsForChat(
  environmentId: string | null,
  rootSession: string | null
): readonly PairedServerAskCard[] {
  // Only a server's chat can hold its cards: a chat here never reads the list.
  const remote = environmentId !== null && rootSession !== null
  const cards = useSyncExternalStore(
    remote ? subscribeLocalCards : subscribeToNothing,
    remote ? readLocalSnapshot : readNoCards,
    remote ? readLocalSnapshot : readNoCards
  )
  if (!environmentId || !rootSession) {
    return NO_CARDS
  }
  const shown = cards.filter(
    (card) => card.environmentId === environmentId && card.rootSession === rootSession
  )
  return shown.length === 0 ? NO_CARDS : shown
}
