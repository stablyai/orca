import { normalizeAgentSessionConversationName } from './agent-session-conversation-name'

// A small picture another program pins on a chat (`orca chat badge`), such as the logo of an app the
// chat is linked to. Orca ships no badge art: the caller sends the picture, so a mark it may not
// redistribute never ships in Orca itself.

export type AgentSessionBadge = Readonly<{
  /** What the picture means, shown as its tooltip and read by screen readers. */
  label: string
  /** The picture as a base64 data URL: PNG, WebP or SVG. */
  icon: string
}>

export const AGENT_SESSION_BADGE_LABEL_MAX_LENGTH = 64
/** About 6 KB of picture: a 32 px PNG logo is under 2 KB. Every client receives it with the chat. */
export const AGENT_SESSION_BADGE_ICON_MAX_LENGTH = 8192

const BADGE_ICON_PREFIX = /^data:image\/(png|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/

/** The badge a host or client may keep, or undefined for anything else: unchecked wire and disk
 *  data must never put an arbitrary URL in an image source. */
export function readAgentSessionBadge(value: unknown): AgentSessionBadge | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const label = 'label' in value ? value.label : undefined
  const icon = 'icon' in value ? value.icon : undefined
  if (typeof label !== 'string' || typeof icon !== 'string') {
    return undefined
  }
  // The chat-name rules: controls, bidi overrides and lone surrogates never reach a tooltip.
  const shownLabel = normalizeAgentSessionConversationName(label)
  if (
    !shownLabel ||
    shownLabel.length > AGENT_SESSION_BADGE_LABEL_MAX_LENGTH ||
    icon.length > AGENT_SESSION_BADGE_ICON_MAX_LENGTH ||
    !BADGE_ICON_PREFIX.test(icon)
  ) {
    return undefined
  }
  return { label: shownLabel, icon }
}

export function agentSessionBadgesEqual(
  a: AgentSessionBadge | undefined,
  b: AgentSessionBadge | undefined
): boolean {
  return a === b || (a?.label === b?.label && a?.icon === b?.icon)
}
