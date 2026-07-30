import type { RefObject } from 'react'
import type {
  StatusPillAgentRow,
  StatusPillPendingQuestion,
  StatusPillSummary
} from '../../shared/status-pill-preload-api'
import { formatAgentLabel, formatRelativeTime } from './status-pill-formatters'
import { PendingQuestionCard } from './pending-question-card'
import orcaLogoUrl from '../../../resources/icon.png'

/** A collapsed session row (colored dot + name + agent/worktree chips + time). */
function SessionMini({
  row,
  onFocusPane
}: {
  row: StatusPillAgentRow
  onFocusPane: (paneKey: string, worktreeId?: string | null) => void
}): React.JSX.Element {
  const prompt = row.prompt || row.toolName || ''
  return (
    <div
      className="session"
      role="button"
      tabIndex={0}
      title={`Focus ${formatAgentLabel(row.agentType)} in Orca`}
      onClick={() => onFocusPane(row.paneKey, row.worktreeId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onFocusPane(row.paneKey, row.worktreeId)
        }
      }}
    >
      <span className={`sd sd-${row.state}`} />
      <span className="si">
        <span className="sname">{prompt || formatAgentLabel(row.agentType)}</span>
      </span>
      <span className="chip">{formatAgentLabel(row.agentType)}</span>
      {row.worktreeLabel ? <span className="chip">{row.worktreeLabel}</span> : null}
      <span className="dur">{formatRelativeTime(row.receivedAt)}</span>
    </div>
  )
}

/** The Dynamic Island. A single morphing black shape (Vibe Island): compact
 *  (pet + task + count) at rest, expanding to a hero session + collapsed
 *  sessions + the live question/approval card. */
export function Island({
  summary,
  rows,
  expanded,
  entered,
  attention,
  dragging,
  pinned,
  onTogglePin,
  pending,
  onAnswer,
  onFocusPane,
  answeringPaneKey,
  answerError,
  onMouseDown,
  onClick,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  stackRef
}: {
  summary: StatusPillSummary
  rows: StatusPillAgentRow[]
  expanded: boolean
  entered: boolean
  attention: boolean
  dragging: boolean
  pinned: boolean
  onTogglePin: () => void
  pending?: StatusPillPendingQuestion
  onAnswer: (paneKey: string, raw: string) => Promise<void>
  onFocusPane: (paneKey: string, worktreeId?: string | null) => void
  answeringPaneKey: string | null
  answerError: string | null
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void
  onClick: () => void
  onContextMenu: (event: React.MouseEvent) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  stackRef: RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const lead = rows[0]
  const total = summary.working + summary.blocked + summary.waiting + summary.recentDone
  const idleText = lead
    ? lead.prompt || lead.toolName || formatAgentLabel(lead.agentType)
    : summary.activityLabel || 'No agents'

  return (
    <div
      ref={stackRef}
      role="button"
      tabIndex={0}
      aria-label="Orca agent status"
      onMouseDown={onMouseDown}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={`island ${entered ? 'island-enter' : ''} ${
        attention ? 'island-attention' : ''
      } ${dragging ? 'is-dragging' : ''}`}
    >
      <div className="island-stack">
        {expanded && rows.length > 0 ? (
          <div
            className="island-expanded"
            onClick={(event) => event.stopPropagation()}
            role="presentation"
          >
            <div className="island-head">
              <span className="island-head-title">
                {total} session{total === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className={`pin-btn ${pinned ? 'is-pinned' : ''}`}
                title={pinned ? 'Unpin' : 'Pin to move'}
                aria-label={pinned ? 'Unpin island' : 'Pin island'}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onTogglePin()
                }}
              >
                {pinned ? '📌' : '📍'}
              </button>
            </div>
            <div className="session session-hero">
              <img className="orca-logo" src={orcaLogoUrl} alt="" width={18} height={18} />
              <div className="si">
                <div className="srow">
                  <span className="sname">
                    {lead?.worktreeLabel || formatAgentLabel(lead?.agentType ?? 'agent')}
                  </span>
                  <span className="chip">{formatAgentLabel(lead?.agentType ?? 'agent')}</span>
                  <span className="dur">{lead ? formatRelativeTime(lead.receivedAt) : ''}</span>
                </div>
                {lead?.prompt ? <div className="you">{lead.prompt}</div> : null}
                <div className="activity" style={{ color: 'var(--muted)' }}>
                  {lead?.toolName || (lead ? stateLabel(lead.state) : '')}
                </div>
              </div>
            </div>
            {rows.slice(1).map((row) => (
              <SessionMini
                key={`${row.paneKey}-${row.receivedAt}`}
                row={row}
                onFocusPane={onFocusPane}
              />
            ))}
          </div>
        ) : (
          <div className="island-compact">
            <img className="orca-logo" src={orcaLogoUrl} alt="" width={16} height={16} />
            <span className={`idle-text ${total === 0 ? 'idle-text-muted' : ''}`}>{idleText}</span>
            {total > 0 ? <span className="idle-count">{total}</span> : null}
          </div>
        )}
        {expanded && pending ? (
          <div
            style={{ padding: '0 4px 4px' }}
            onClick={(event) => event.stopPropagation()}
            role="presentation"
          >
            <PendingQuestionCard
              pending={pending}
              onAnswer={onAnswer}
              submitting={answeringPaneKey === pending.paneKey}
              error={answerError}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function stateLabel(state: string): string {
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
