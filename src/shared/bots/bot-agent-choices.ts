// Which agents a bot can run on a host, and whether each can start; the desktop's New bot and the
// host's own answer to a phone read it the same way.
import {
  agentMenuRowSupportsChat,
  type ChatUnavailableReason,
  type NewTabAgentMenuRow
} from '../agent-launch/picker/agent-launch-picker-rows'
import { BOT_AGENTS, type Bot, type BotAgent } from '../bot-types'

/** What these choices read of a host's agent menu; `detectedIds` is null when the check failed. */
export type BotAgentMenuModel =
  | { state: 'loading' }
  | {
      state: 'settled'
      rows: readonly NewTabAgentMenuRow[]
      detection: { detectedIds: readonly string[] | null }
    }

export type BotNewChatAgent = {
  agent: BotAgent
  /** Absent while it can start, or while the menu has not settled what this host offers. */
  unavailable?: ChatUnavailableReason
}

/** Whether `agent`'s chat can start here, as its agent row says. */
function botAgentOnHost(
  agent: BotAgent,
  model: Extract<BotAgentMenuModel, { state: 'settled' }>
): BotNewChatAgent {
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
    return [{ agent: bot.agent }]
  }
  return [bot.agent, ...BOT_AGENTS.filter((agent) => agent !== bot.agent)]
    .map((agent) => botAgentOnHost(agent, model))
    .filter((entry) => entry.agent === bot.agent || entry.unavailable !== 'not-installed')
}

/** The agents a bot can be set to here: the installed ones, and `current` always; empty while the
 *  menu is still learning the host. */
export function botAgentChoices(model: BotAgentMenuModel, current?: BotAgent): BotAgent[] {
  if (model.state === 'loading') {
    return current ? [current] : []
  }
  return BOT_AGENTS.filter(
    (agent) =>
      agent === current ||
      model.rows.some((row) => row.agent === agent && agentMenuRowSupportsChat(row))
  )
}
