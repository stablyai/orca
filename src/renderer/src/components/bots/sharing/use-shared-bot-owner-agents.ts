// The agents a shared agent's owner offers for a new chat, read from the owner's computer each time its
// + menu opens here, so the menu follows what that computer offers now.
import { useEffect, useState } from 'react'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotNewChatAgent } from '../../../../../shared/bots/bot-agent-choices'
import { botRefKey, callBotRpc } from '@/lib/bot-hosts'

/** The owner's list, or null when its computer didn't answer with one. */
export async function readSharedBotOwnerAgents(bot: Bot): Promise<BotNewChatAgent[] | null> {
  try {
    const { newChatAgents } = await callBotRpc<{ newChatAgents?: BotNewChatAgent[] }>(
      bot,
      'bots.agentChoices'
    )
    return newChatAgents && newChatAgents.length > 0 ? newChatAgents : null
  } catch (error) {
    console.warn('[shared-agents] could not read the owner’s agents', error)
    return null
  }
}

/** The last list the owner's computer answered while this menu was mounted, else null; each open
 *  reads it again, and a read that fails leaves the last answer. */
export function useSharedBotOwnerAgents(
  bot: Bot | null,
  shared: boolean,
  menuOpen: boolean
): readonly BotNewChatAgent[] | null {
  const key = bot && shared ? botRefKey(bot) : null
  const [answer, setAnswer] = useState<{ key: string; agents: BotNewChatAgent[] } | null>(null)
  useEffect(() => {
    if (!bot || !key || !menuOpen) {
      return
    }
    let live = true
    void readSharedBotOwnerAgents(bot).then((agents) => {
      if (live && agents) {
        setAnswer({ key, agents })
      }
    })
    return () => {
      live = false
    }
  }, [bot, key, menuOpen])
  return answer?.key === key ? answer.agents : null
}
