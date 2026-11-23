import { useRef } from 'react'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { agentTypeToIconAgent } from '../../../../shared/agent-status/presentation/agent-type-icon-agent'
import { formatNotchElapsedSince } from '../../../../shared/notch/notch-duration-format'
import { SESSION_ROW_HEIGHT } from '../../../../shared/notch/notch-panel-rect'
import type { NotchRow } from '../../../../shared/notch/notch-snapshot'
import type { NotchLane } from '../../../../shared/notch/notch-status-summary'

const LANE_DOT: Record<NotchLane, string> = {
  working: 'bg-foreground',
  attention: 'bg-destructive',
  done: 'bg-status-success'
}

export function NotchSessionRow({
  row,
  onActivate
}: {
  row: NotchRow
  onActivate: (row: NotchRow) => void
}): React.JSX.Element {
  const pointerPressed = useRef(false)
  const elapsed = formatNotchElapsedSince(row.stateStartedAt, useNow(1000))
  // A row with no pane to route to still lists, but must not look actionable.
  const actionable = row.worktreeId !== null && row.tabId !== null
  const t = useTranslate()
  const state = {
    working: t('notch.rowState.working', 'Working'),
    attention: t('notch.rowState.attention', 'Needs you'),
    done: t('notch.rowState.done', 'Finished')
  }[row.lane]

  return (
    <button
      type="button"
      disabled={!actionable}
      onPointerDown={(event) => {
        pointerPressed.current = event.isPrimary && event.button === 0
      }}
      onPointerCancel={() => {
        pointerPressed.current = false
      }}
      onPointerLeave={() => {
        pointerPressed.current = false
      }}
      onClick={(event) => {
        const accepted = event.detail === 0 || pointerPressed.current
        pointerPressed.current = false
        if (accepted) {
          onActivate(row)
        }
      }}
      style={{ height: SESSION_ROW_HEIGHT }}
      aria-label={`${row.title} — ${state}${row.agentType ? ` — ${row.agentType}` : ''}`}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${LANE_DOT[row.lane]}`} />
      {/* Why the shared AgentIcon: it already resolves every provider Orca ships, so the notch
          and the sidebar can't disagree about what a Codex row looks like. Falls back to a
          neutral glyph when the agent identity has not arrived yet. */}
      <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
        <AgentIcon agent={agentTypeToIconAgent(row.agentType)} size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs leading-none text-foreground">
        {row.title}
      </span>
      <span
        aria-hidden="true"
        className="shrink-0 text-2xs leading-none tabular-nums text-muted-foreground"
      >
        {elapsed}
      </span>
    </button>
  )
}
