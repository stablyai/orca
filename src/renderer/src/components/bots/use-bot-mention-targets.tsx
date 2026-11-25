import { useCallback, useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import {
  readBotHostIds,
  readBotHostListed,
  subscribeToBotChanges
} from '@/lib/bot-catalog-snapshot'
import type { NativeChatBotMentionTarget } from '../native-chat/native-chat-room-context'
import { BotAvatar } from './BotAvatar'
import { botMentionServerHost } from './bot-mention-server'

const listedHosts = (): string => readBotHostIds().filter(readBotHostListed).join('\n')

/** Each bot a draft names, looked up by id among the bots on the computer the chat's agent runs
 *  on, or on the paired server its token names: its current name, picture and whether it is paused;
 *  null for one that computer's list no longer has; undefined until that list is read. */
export function useBotMentionTargets(
  hostId: ExecutionHostId | null
): (id: string, server?: string) => NativeChatBotMentionTarget | null | undefined {
  const enabled = useBotsEnabled() && hostId !== null
  const bots = useBots(enabled)
  // The hosts that have answered their bot list, so a bot missing from one is gone.
  const listed = useSyncExternalStore(subscribeToBotChanges, listedHosts, listedHosts)
  return useCallback(
    (id: string, server?: string) => {
      const host = server ? botMentionServerHost(server) : hostId
      if (!enabled || host === null) {
        return undefined
      }
      const bot = bots.find((entry) => entry.id === id && entry.hostId === host)
      if (!bot) {
        return listed.split('\n').includes(host) ? null : undefined
      }
      return {
        name: bot.name,
        paused: bot.paused,
        avatar: <BotAvatar bot={bot} className="size-full rounded-sm text-3xs" />
      }
    },
    [bots, enabled, hostId, listed]
  )
}
