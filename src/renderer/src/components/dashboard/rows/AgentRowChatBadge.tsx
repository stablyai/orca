import type { AgentSessionBadge } from '../../../../../shared/agent-session/conversation-naming/agent-session-badge'

/** Another program's picture on a chat (`orca chat badge`), drawn beside the chat's title. The
 *  host and the status feed only pass a checked data URL, so the source is never a fetched URL. */
export function AgentRowChatBadge({
  badge,
  size
}: {
  badge: AgentSessionBadge | null
  size: number
}): React.JSX.Element | null {
  if (!badge) {
    return null
  }
  return (
    <img
      src={badge.icon}
      alt={badge.label}
      title={badge.label}
      width={size}
      height={size}
      draggable={false}
      className="shrink-0 object-contain"
      data-testid="agent-row-chat-badge"
    />
  )
}
