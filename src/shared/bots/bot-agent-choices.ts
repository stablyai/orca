// Which agents a bot can run on a host, and whether each can start; the desktop's New bot and the
// host's own answer to a phone read it the same way.
import type {
  ChatUnavailableReason,
  NewTabAgentMenuRow
} from '../agent-launch/picker/agent-launch-picker-rows'
import { BOT_AGENTS, type Bot, type BotAgent } from '../bot-types'
import { botAgentHostRefusal, botAgentNeedsManagedRuntime } from './bot-agent-runtime'

/** What these choices read of a host's agent menu; `detectedIds` is null when the check failed. */
export type BotAgentMenuModel =
  | { state: 'loading' }
  | {
      state: 'settled'
      rows: readonly NewTabAgentMenuRow[]
      detection: { detectedIds: readonly string[] | null }
      /** Agents the host publishes Orca's managed runtime for; absent until its agent list is read. */
      managedRuntimeAgents?: readonly string[] | undefined
    }

export type BotNewChatAgent = {
  agent: BotAgent
  /** Absent while it can start, or while the menu has not settled what this host offers. */
  unavailable?: ChatUnavailableReason
}

/** Whether `agent`'s chat can start here, as its agent row says; null when a bot can't run on it
 *  here, or not yet known: the host's own agy may list it, but a bot runs only on Orca's managed one. */
function botAgentOnHost(
  agent: BotAgent,
  model: Extract<BotAgentMenuModel, { state: 'settled' }>
): BotNewChatAgent | null {
  if (botAgentHostRefusal(agent, model.managedRuntimeAgents?.includes(agent) === true)) {
    return null
  }
  const row = model.rows.find((entry) => entry.agent === agent)
  if (!row) {
    // No row: the agent is not on this host, or the host could not be asked.
    return {
      agent,
      unavailable: model.detection.detectedIds === null ? 'check-failed' : 'not-installed'
    }
  }
  return row.kind === 'chat-unavailable' ? { agent, unavailable: row.reason } : { agent }
}

/** The bot's own agent first, then every other one installed here; each unavailable one says why,
 *  as agent rows do. Only the bot's own while the menu is still learning the host. */
export function botNewChatAgents(
  bot: Pick<Bot, 'agent'>,
  model: BotAgentMenuModel
): BotNewChatAgent[] {
  if (model.state === 'loading') {
    return botAgentNeedsManagedRuntime(bot.agent) ? [] : [{ agent: bot.agent }]
  }
  return [bot.agent, ...BOT_AGENTS.filter((agent) => agent !== bot.agent)]
    .map((agent) => botAgentOnHost(agent, model))
    .filter(
      (entry): entry is BotNewChatAgent =>
        entry !== null && (entry.agent === bot.agent || entry.unavailable !== 'not-installed')
    )
}

/** The agents a bot can be set to here: the installed ones, and `current` always; empty while the
 *  menu is still learning the host. */
export function botAgentChoices(model: BotAgentMenuModel, current?: BotAgent): BotAgent[] {
  if (model.state === 'loading') {
    return current ? [current] : []
  }
  return BOT_AGENTS.filter((agent) => {
    if (agent === current) {
      return true
    }
    const entry = botAgentOnHost(agent, model)
    return entry !== null && entry.unavailable !== 'not-installed'
  })
}
