import type { StatusPillAgentRow } from '../../shared/status-pill-preload-api'
import {
  formatAgentLabel,
  formatRelativeTime,
  pickAvatarClass,
  pickInitials
} from './status-pill-formatters'

export function AgentRowView({
  row,
  index
}: {
  row: StatusPillAgentRow
  index: number
}): React.JSX.Element {
  // Why: stagger each row by a few ms so the list reveals smoothly rather
  // than as one block. Cap the stagger so long lists do not trail.
  const stagger = Math.min(index, 6) * 24
  const style = { animationDelay: `${stagger}ms` } as const
  const initials = pickInitials(row.agentType)
  const avatarClass = pickAvatarClass(row.agentType)
  const label = formatAgentLabel(row.agentType)
  const timeLabel = formatRelativeTime(row.receivedAt)
  const prompt = row.prompt || row.toolName || stateFallback(row.state)
  return (
    <div className="agent-row" style={style}>
      <div className={`agent-avatar ${avatarClass}`}>{initials}</div>
      <div className="agent-body">
        <div className="agent-name">
          {label}
          {row.worktreeLabel ? <span className="term">· {row.worktreeLabel}</span> : null}
        </div>
        <div className="agent-prompt">{prompt}</div>
      </div>
      <span className={`agent-state ${row.state}`} />
      <span className="agent-time">{timeLabel}</span>
    </div>
  )
}

function stateFallback(state: StatusPillAgentRow['state']): string {
  switch (state) {
    case 'working':
      return 'Working…'
    case 'blocked':
      return 'Permission request'
    case 'waiting':
      return 'Waiting for an answer'
    case 'done':
      return 'Done'
    default:
      return 'Idle'
  }
}
