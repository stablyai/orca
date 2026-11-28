// Which agents a bot can run on a host, and whether each can start; the desktop's New bot and the
// host's own answer to a phone read it the same way.
import {
  agentMenuRowReady,
  agentMenuRowSupportsChat,
  type ChatUnavailableReason,
  type NewTabAgentMenuRow
} from '../agent-launch/picker/agent-launch-picker-rows'
import { BOT_AGENTS, BOT_NEW_AGENT_PRIORITY, type Bot, type BotAgent } from '../bot-types'

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
  const own = model.rows.filter((entry) => entry.agent === agent)
  if (own.length === 0) {
    // No row: the agent is not on this host, or the host could not be asked.
    return {
      agent,
      unavailable: model.detection.detectedIds === null ? 'check-failed' : 'not-installed'
    }
  }
  // A bot runs a chat, so an unavailable chat row wins over the agent's CLI row wherever it sits.
  const unavailable = own.find((entry) => entry.kind === 'chat-unavailable')
  return unavailable ? { agent, unavailable: unavailable.reason } : { agent }
}

/** Whether the user has `agent` here: the menu's rows already leave out agents disabled in Agent
 *  settings, and a chat that only offers to install the agent first doesn't count. */
function botAgentEnabledOnHost(agent: BotAgent, rows: readonly NewTabAgentMenuRow[]): boolean {
  return rows.some((row) => row.agent === agent && !(row.kind === 'chat' && row.setup))
}

/** The bot's own agent first, then every other agent enabled here; each unavailable one says why,
 *  as agent rows do. With none enabled, the bot's own agent as it stands here, so the list is never
 *  empty. Only the bot's own while the menu is still learning the host. */
export function botNewChatAgents(
  bot: Pick<Bot, 'agent'>,
  model: BotAgentMenuModel
): BotNewChatAgent[] {
  if (model.state === 'loading') {
    return [{ agent: bot.agent }]
  }
  const enabled = [bot.agent, ...BOT_AGENTS.filter((agent) => agent !== bot.agent)]
    .filter((agent) => botAgentEnabledOnHost(agent, model.rows))
    .map((agent) => botAgentOnHost(agent, model))
    .filter((entry) => entry.unavailable !== 'not-installed')
  return enabled.length > 0 ? enabled : [botAgentOnHost(bot.agent, model)]
}

/** The agents a bot can be set to here: the installed ones, and `current` always; empty while the
 *  menu is still learning the host. `installedOnly` drops chats that would install their agent first,
 *  so a new bot's default (`newBotAgent`) is never an agent the host lacks. */
export function botAgentChoices(
  model: BotAgentMenuModel,
  current?: BotAgent,
  installedOnly = false
): BotAgent[] {
  if (model.state === 'loading') {
    return current ? [current] : []
  }
  return BOT_AGENTS.filter(
    (agent) =>
      agent === current ||
      model.rows.some(
        (row) =>
          row.agent === agent &&
          agentMenuRowSupportsChat(row) &&
          (!installedOnly || agentMenuRowReady(row))
      )
  )
}

/** The host's default agent when a bot can start it there as it is now, not by installing it first:
 *  the menu leads with chats the host runs now, so an install-first default doesn't beat a ready one. */
export function readyBotDefaultAgent(
  model: BotAgentMenuModel,
  defaultAgent: string | null | undefined
): BotAgent | undefined {
  return botAgentChoices(model, undefined, true).find((agent) => agent === defaultAgent)
}

/** A new bot's agent from `choices`: the host's default agent when a bot can run it, else the
 *  highest-priority choice. */
export function newBotAgent(
  choices: readonly BotAgent[],
  defaultAgent: string | null | undefined
): BotAgent | undefined {
  return (
    choices.find((agent) => agent === defaultAgent) ??
    BOT_NEW_AGENT_PRIORITY.find((agent) => choices.includes(agent))
  )
}
