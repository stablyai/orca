// "Mute agents started by bots": which agents a bot started, and which of their alerts the person still gets.
import type { AgentSessionAttentionEdge } from '../agent-session/view/agent-session-attention'
import { isAskUserQuestionTool } from '../agent-status/lifecycle/agent-question-answered-intent'
import type { NotificationSettings } from '../notifications/notification-settings-types'
import { nearestBotHome } from './bot-workspace-owner'

/** A bot's home, a workspace the sidebar nests below one, or neither. */
export type BotWorkspacePlace = 'home' | 'below-home' | null

export function botWorkspacePlace(
  identity: string,
  parentIdentityOf: (identity: string) => string | undefined,
  homeIdentities: ReadonlySet<string>
): BotWorkspacePlace {
  const isHome = (candidate: string): boolean => homeIdentities.has(candidate)
  if (isHome(identity)) {
    return 'home'
  }
  return nearestBotHome(identity, parentIdentityOf, isHome) === undefined ? null : 'below-home'
}

/** An alert names its workspace by id alone, which same-id copies on other hosts share: only a place every copy has counts. */
export function agreedBotWorkspacePlace(places: readonly BotWorkspacePlace[]): BotWorkspacePlace {
  const [first = null] = places
  return places.every((place) => place === first) ? first : null
}

/** A bot started the agent: it runs below a bot's home, or in the home as a dispatched worker. The bot's own chats are neither. */
export function isBotSpawnedAgent(
  place: BotWorkspacePlace,
  reportsToCoordinator: () => boolean
): boolean {
  return place === 'below-home' || (place === 'home' && reportsToCoordinator())
}

export type BotSpawnedAgentNews = {
  agentState: string | undefined
  toolName?: string
  /** A chat raises every prompt as `blocked`; its prompt edge says when all it waits on are questions. */
  asksOnlyQuestions?: boolean
}

/** A chat edge as the gate reads it. A turn that settles while a prompt waits still needs the
 *  person, and it does not say what kind of prompt, so it reads as one that stays loud. */
export function botSpawnedChatNews(
  edge: AgentSessionAttentionEdge,
  agentState: string
): BotSpawnedAgentNews {
  if (edge.type === 'prompt') {
    return { agentState, asksOnlyQuestions: edge.prompt.asksOnlyQuestions }
  }
  return { agentState: edge.completion.awaitingUser === true ? 'blocked' : agentState }
}

/** A hook row waits on an ask-the-user tool, or a chat's prompts are all questions. An approval
 *  title makes a terminal row `blocked`, which outranks a question tool the row still names. */
function isQuestion(news: BotSpawnedAgentNews): boolean {
  return news.agentState === 'waiting'
    ? isAskUserQuestionTool(news.toolName)
    : news.agentState === 'blocked' && news.asksOnlyQuestions === true
}

/** Needs the person to approve something: a needs-input stop that is not a question. */
function isPermissionPrompt(news: BotSpawnedAgentNews): boolean {
  return (news.agentState === 'blocked' || news.agentState === 'waiting') && !isQuestion(news)
}

type BotSpawnedMuteSettings = Partial<
  Pick<NotificationSettings, 'muteBotSpawnedAgents' | 'muteBotSpawnedPermissionPrompts'>
>

/** With the setting on, a bot-spawned agent's news is its bot's alone; permission prompts still reach the person unless the second switch is on. */
export function isBotSpawnedAgentNewsMuted(
  settings: BotSpawnedMuteSettings | undefined,
  news: BotSpawnedAgentNews,
  isBotSpawned: () => boolean
): boolean {
  if (settings?.muteBotSpawnedAgents !== true) {
    return false
  }
  if (isPermissionPrompt(news) && settings.muteBotSpawnedPermissionPrompts !== true) {
    return false
  }
  return isBotSpawned()
}
