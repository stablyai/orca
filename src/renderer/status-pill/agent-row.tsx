import type { StatusPillAgentRow } from '../../shared/status-pill-preload-api'
import {
  formatAgentLabel,
  formatRelativeTime,
  pickAvatarClass,
  pickInitials
} from './status-pill-formatters'

/** One row in the expanded multi-agent list. Staggers fade-in by index so
 *  the list cascades instead of popping in as a single block. Clicking a row
 *  focuses that agent's terminal pane in the Orca main window. */
export function AgentRowView({
  row,
  index,
  onFocusPane
}: {
  row: StatusPillAgentRow
  index: number
  onFocusPane: (paneKey: string, worktreeId?: string | null) => void
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
  const handleFocus = (): void => {
    onFocusPane(row.paneKey, row.worktreeId)
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleFocus()
    }
  }
  return (
    <div
      className="agent-row"
      style={style}
      role="button"
      tabIndex={0}
      title={`Focus ${label} in Orca`}
      onClick={handleFocus}
      onKeyDown={onKeyDown}
    >
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
