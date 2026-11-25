// The agents a shared agent's owner offers for a new chat, read from the owner's computer the first
// time its + menu opens here; kept for the session, as that computer's agents rarely change.
import { useEffect, useState } from 'react'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotNewChatAgent } from '../../../../../shared/bots/bot-agent-choices'
import { botRefKey, callBotRpc } from '@/lib/bot-hosts'

const kept = new Map<string, readonly BotNewChatAgent[]>()

/** Null until read (or while the owner's computer can't answer); `menuOpen` starts the read. */
export function useSharedBotOwnerAgents(
  bot: Bot | null,
  shared: boolean,
  menuOpen: boolean
): readonly BotNewChatAgent[] | null {
  const key = bot && shared ? botRefKey(bot) : null
  const [, setRead] = useState(0)
  useEffect(() => {
    if (!bot || !key || !menuOpen || kept.has(key)) {
      return
    }
    let live = true
    void callBotRpc<{ newChatAgents?: BotNewChatAgent[] }>(bot, 'bots.agentChoices')
      .then(({ newChatAgents }) => {
        if (newChatAgents) {
          kept.set(key, newChatAgents)
          if (live) {
            setRead((n) => n + 1)
          }
        }
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [bot, key, menuOpen])
  return key ? (kept.get(key) ?? null) : null
}
