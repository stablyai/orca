import './pill.css'

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  StatusPillAgentRow,
  StatusPillPreferences,
  StatusPillPreloadApi,
  StatusPillSummary
} from '../../shared/status-pill-preload-api'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    api: StatusPillPreloadApi | undefined
  }
}

const EMPTY_SUMMARY: StatusPillSummary = {
  working: 0,
  blocked: 0,
  waiting: 0,
  recentDone: 0,
  hasAnyActivity: false,
  activityLabel: '',
  activityPaneKey: null,
  activePaneKey: null,
  activeTabId: null
}

type Tone = 'idle' | 'working' | 'blocked' | 'waiting' | 'done'

function StatusPill(): React.JSX.Element {
  const api = window.api
  const [summary, setSummary] = useState<StatusPillSummary>(EMPTY_SUMMARY)
  const [rows, setRows] = useState<StatusPillAgentRow[]>([])
  const [preferences, setPreferences] = useState<StatusPillPreferences | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [entered, setEntered] = useState(false)

  // Why: opt-in debug hook so screenshots and e2e tests can force the panel
  // open without simulating React synthetic events. Activated only when the
  // preload exposes window.__orcaPillDebugExpand (mock harness / tests only).
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      (window as Window & { __orcaPillDebugExpand?: boolean }).__orcaPillDebugExpand === true
    ) {
      setExpanded(true)
    }
  }, [])

  useEffect(() => {
    if (!api) {
      return
    }
    let mounted = true
    const unsubSummary = api.onSnapshot((next) => {
      if (mounted) {
        setSummary(next)
      }
    })
    const unsubRows = api.onAgentRows((next) => {
      if (mounted) {
        setRows(next)
      }
    })
    void api.getSnapshot().then((snapshot) => {
      if (mounted) {
        setSummary(snapshot)
      }
    })
    void api.getAgentRows().then((snapshotRows) => {
      if (mounted) {
        setRows(snapshotRows)
      }
    })
    void api.getInitialPreferences().then((prefs) => {
      if (mounted) {
        setPreferences(prefs)
      }
    })
    // Why: trigger the entrance animation one frame after first paint so the
    // CSS animation runs from the start state instead of jumping to the end.
    const enterRaf = window.requestAnimationFrame(() => {
      if (mounted) {
        setEntered(true)
      }
    })
    return () => {
      mounted = false
      unsubSummary()
      unsubRows()
      window.cancelAnimationFrame(enterRaf)
    }
  }, [api])

  useEffect(() => {
    // Why: the pill renderer is the only place that can read the user's OS
    // reduced-motion preference (main process cannot reach matchMedia). Merge
    // it with the dark-mode snapshot from main.
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      const apply = (): void => {
        setPreferences((prev) => ({
          shouldUseDarkColors: prev?.shouldUseDarkColors ?? false,
          prefersReducedMotion: mq.matches
        }))
      }
      apply()
      try {
        mq.addEventListener('change', apply)
      } catch {
        // Safari < 14 fallback.
        mq.addListener(apply)
      }
      return () => {
        try {
          mq.removeEventListener('change', apply)
        } catch {
          mq.removeListener(apply)
        }
      }
    }
  }, [])

  useEffect(() => {
    // Why: keep the document root class in sync with the resolved theme so the
    // CSS variables defined in pill.css flip correctly.
    const isDark = preferences?.shouldUseDarkColors ?? false
    document.documentElement.classList.toggle('dark', isDark)
  }, [preferences?.shouldUseDarkColors])

  const tone = pickTone(summary)
  const pulse =
    preferences?.prefersReducedMotion !== true &&
    (summary.working > 0 || summary.blocked > 0 || summary.waiting > 0)

  return (
    <div
      className={`pill-stack ${entered ? 'pill-enter' : ''}`}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      <PillBody
        tone={tone}
        pulse={pulse}
        summary={summary}
        onClick={() => window.api?.fireClick()}
        onContextMenu={(event) => {
          event.preventDefault()
          window.api?.fireContextMenu()
        }}
      />
      {expanded && rows.length > 0 ? (
        <AgentPanel summary={summary} rows={rows} tone={tone} pulse={pulse} />
      ) : null}
      <StyleBaseline />
    </div>
  )
}

function PillBody({
  tone,
  pulse,
  summary,
  onClick,
  onContextMenu
}: {
  tone: Tone
  pulse: boolean
  summary: StatusPillSummary
  onClick: () => void
  onContextMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div
      role="button"
      aria-label="Orca agent status"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`pill pill-${tone} ${pulse ? 'pill-pulse' : ''}`}
    >
      <span className="indicator" aria-hidden="true">
        <span className="indicator-ring" />
        <span className="indicator-dot" />
      </span>
      {summary.hasAnyActivity ? (
        <span className="counts">
          {summary.working > 0 ? <CountGroup kind="working" value={summary.working} /> : null}
          {summary.blocked > 0 ? <CountGroup kind="blocked" value={summary.blocked} /> : null}
          {summary.waiting > 0 ? <CountGroup kind="waiting" value={summary.waiting} /> : null}
          {summary.recentDone > 0 ? <CountGroup kind="done" value={summary.recentDone} /> : null}
        </span>
      ) : null}
      {summary.activityLabel ? (
        <>
          <span className="divider" />
          <span className="label" title={summary.activityLabel}>
            {summary.activityLabel}
          </span>
        </>
      ) : (
        <span className="label label-idle">No recent activity</span>
      )}
    </div>
  )
}

function CountGroup({
  kind,
  value
}: {
  kind: 'working' | 'blocked' | 'waiting' | 'done'
  value: number
}): React.JSX.Element {
  return (
    <span className="count-group">
      <span className={`count-dot count-dot-${kind}`} />
      <span className="count-value">{value}</span>
    </span>
  )
}

function AgentPanel({
  summary,
  rows,
  tone,
  pulse
}: {
  summary: StatusPillSummary
  rows: StatusPillAgentRow[]
  tone: Tone
  pulse: boolean
}): React.JSX.Element {
  const total = summary.working + summary.blocked + summary.waiting + summary.recentDone
  const title = buildPanelTitle(summary)
  return (
    <div className="panel" role="dialog" aria-label="Orca agents">
      <div className="panel-head">
        <span className={`indicator pill-${tone} ${pulse ? 'pill-pulse' : ''}`} aria-hidden="true">
          <span className="indicator-ring" />
          <span className="indicator-dot" />
        </span>
        <span className="panel-title">{title}</span>
        <span className="panel-meta">
          {total} session{total === 1 ? '' : 's'}
        </span>
      </div>
      <div className="agent-list">
        {rows.map((row, index) => (
          <AgentRowView key={`${row.paneKey}-${row.receivedAt}`} row={row} index={index} />
        ))}
      </div>
    </div>
  )
}

function AgentRowView({
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

function buildPanelTitle(summary: StatusPillSummary): string {
  const parts: string[] = []
  if (summary.working > 0) {
    parts.push(`${summary.working} working`)
  }
  if (summary.blocked > 0) {
    parts.push(`${summary.blocked} blocked`)
  }
  if (summary.waiting > 0) {
    parts.push(`${summary.waiting} waiting`)
  }
  if (parts.length === 0) {
    return summary.recentDone > 0 ? `${summary.recentDone} recently done` : 'No active agents'
  }
  return parts.join(' · ')
}

function pickTone(summary: StatusPillSummary): Tone {
  if (summary.blocked > 0) {
    return 'blocked'
  }
  if (summary.waiting > 0) {
    return 'waiting'
  }
  if (summary.working > 0) {
    return 'working'
  }
  if (summary.recentDone > 0) {
    return 'done'
  }
  return 'idle'
}

function pickInitials(agentType: string): string {
  const lower = agentType.toLowerCase()
  const map: Record<string, string> = {
    claude: 'Cl',
    openclaude: 'Cl',
    codex: 'Co',
    gemini: 'Ge',
    copilot: 'Cp',
    cursor: 'Cu',
    opencode: 'Oc',
    aider: 'Ai',
    droid: 'Dr',
    amp: 'Am',
    grok: 'Gr'
  }
  return map[lower] ?? agentType.slice(0, 2).toUpperCase()
}

function pickAvatarClass(agentType: string): string {
  const lower = agentType.toLowerCase()
  const map: Record<string, string> = {
    claude: 'av-claude',
    openclaude: 'av-claude',
    codex: 'av-codex',
    gemini: 'av-gemini',
    cursor: 'av-cursor'
  }
  return map[lower] ?? 'av-default'
}

function formatAgentLabel(agentType: string): string {
  const lower = agentType.toLowerCase()
  const map: Record<string, string> = {
    claude: 'Claude',
    openclaude: 'Claude',
    codex: 'Codex',
    gemini: 'Gemini',
    copilot: 'Copilot',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    aider: 'Aider',
    droid: 'Droid',
    amp: 'Amp',
    grok: 'Grok'
  }
  return map[lower] ?? agentType
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

function formatRelativeTime(receivedAt: number): string {
  if (!receivedAt) {
    return ''
  }
  const seconds = Math.max(0, Math.floor((Date.now() - receivedAt) / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)
  return `${days}d`
}

// Why: small inline <style> for the few layout-only rules that don't belong
// in pill.css (the stacking + alignment of pill + panel under #root). Keeps
// the css file focused on the pill component itself.
function StyleBaseline(): React.JSX.Element {
  return (
    <style>{`
      .pill-stack {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding-top: 6px;
      }
    `}</style>
  )
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Status pill root element not found.')
}
createRoot(rootElement).render(<StatusPill />)
