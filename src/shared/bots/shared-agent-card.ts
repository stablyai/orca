// An agent's card (agent-card-contract.ts) from its own picture and links, and back to the avatar fields
// a teammate's Orca draws it with.
import { mascotAvatar, parseBotAvatar } from '../bot-avatar'
import { botLinearWorkspaces, botSlackApps, type Bot } from '../bot-types'
import { AGENT_CARD_SERVICES, type AgentCard, type AgentCardService } from './agent-card-contract'
import { BotAvatarColorSchema } from './bot-avatar-color'
import { BotStoredOutfitSchema } from './bot-avatar-outfit'

type CardSource = Pick<
  Bot,
  | 'avatar'
  | 'avatarColor'
  | 'avatarOutfit'
  | 'slack'
  | 'slackApps'
  | 'linear'
  | 'linearWorkspaces'
  | 'github'
>

/** The card the hello carries for an agent; absent when it has neither a mascot nor a service.
 *  `google`: one of the Google accounts it may use works (see ConnectorBotGoogle). */
export function agentCardOf(agent: CardSource, google = false): AgentCard | undefined {
  const picture = parseBotAvatar(agent.avatar)
  const on: Record<AgentCardService, boolean> = {
    github: agent.github !== null,
    slack: botSlackApps(agent).length > 0,
    linear: botLinearWorkspaces(agent).length > 0,
    google
  }
  const services = AGENT_CARD_SERVICES.filter((service) => on[service])
  const card: AgentCard = {
    ...(picture?.kind === 'mascot'
      ? {
          mascot: picture.id,
          ...(agent.avatarColor ? { color: agent.avatarColor } : {}),
          ...(agent.avatarOutfit ? { outfit: agent.avatarOutfit } : {})
        }
      : {}),
    ...(services.length > 0 ? { services } : {})
  }
  return Object.keys(card).length > 0 ? card : undefined
}

/** The card's picture as an agent's avatar fields: an unknown mascot or color (from a newer Orca)
 *  draws the agent's initial or the default color, as the agent's own would. */
export function agentCardAvatar(
  card: AgentCard | undefined
): Pick<Bot, 'avatar' | 'avatarColor' | 'avatarOutfit'> {
  const picture = card?.mascot ? parseBotAvatar(`mascot:${card.mascot}`) : null
  if (picture?.kind !== 'mascot') {
    return { avatar: null }
  }
  const color = BotAvatarColorSchema.safeParse(card?.color)
  const outfit = BotStoredOutfitSchema.safeParse(card?.outfit)
  return {
    avatar: mascotAvatar(picture.id),
    ...(color.success ? { avatarColor: color.data } : {}),
    ...(outfit.success ? { avatarOutfit: outfit.data } : {})
  }
}

/** The services of a card this app can name, in invite order. */
export function agentCardServices(card: AgentCard | undefined): AgentCardService[] {
  const named = new Set(card?.services ?? [])
  return AGENT_CARD_SERVICES.filter((service) => named.has(service))
}
