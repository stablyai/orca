import './pill.css'

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  StatusPillAgentRow,
  StatusPillAnswerResult,
  StatusPillPreferences,
  StatusPillPreloadApi,
  StatusPillSummary
} from '../../shared/status-pill-preload-api'
import { EMPTY_STATUS_PILL_SUMMARY } from '../../shared/status-pill-preload-api'
import { AgentRowView } from './agent-row'
import { PendingQuestionCard } from './pending-question-card'
import { buildPanelTitle, pickTone, type Tone } from './status-pill-formatters'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    api: StatusPillPreloadApi | undefined
  }
}

const EMPTY_SUMMARY = EMPTY_STATUS_PILL_SUMMARY

/** Pill root: subscribes to main's snapshot/rows push channels, manages
 *  expand/collapse state, routes answer clicks to preload.answerQuestion. */
function StatusPill(): React.JSX.Element {
  const api = window.api
  const [summary, setSummary] = useState<StatusPillSummary>(EMPTY_SUMMARY)
  const [rows, setRows] = useState<StatusPillAgentRow[]>([])
  const [preferences, setPreferences] = useState<StatusPillPreferences | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [entered, setEntered] = useState(false)
  const [answeringPaneKey, setAnsweringPaneKey] = useState<string | null>(null)
  const [answerError, setAnswerError] = useState<string | null>(null)

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
    if (
      typeof window !== 'undefined' &&
      (window as Window & { __orcaPillDebugExpand?: boolean }).__orcaPillDebugExpand === true
    ) {
      setExpanded(true)
    }
  }, [])

  // Why: auto-expand the panel when a pending question lands, so the user
  // notices the prompt without having to hover. Stay expanded until the
  // pending question clears. Depends on paneKey + interactivePrompt string
  // rather than the object reference so identical content doesn't loop.
  const pendingKey = summary.pendingQuestion?.paneKey
  const pendingPayload = summary.pendingQuestion?.interactivePrompt
  useEffect(() => {
    if (pendingKey && pendingPayload) {
      setExpanded(true)
    }
  }, [pendingKey, pendingPayload])

  useEffect(() => {
    setAnswerError(null)
  }, [pendingKey])

  useEffect(() => {
    const isDark = preferences?.shouldUseDarkColors ?? false
    document.documentElement.classList.toggle('dark', isDark)
  }, [preferences?.shouldUseDarkColors])

  const tone = pickTone(summary)
  const pulse =
    preferences?.prefersReducedMotion !== true &&
    (summary.working > 0 || summary.blocked > 0 || summary.waiting > 0)

  const handleAnswer = async (paneKey: string, raw: string): Promise<void> => {
    if (!api) {
      return
    }
    setAnsweringPaneKey(paneKey)
    setAnswerError(null)
    try {
      const result: StatusPillAnswerResult = await api.answerQuestion(paneKey, raw)
      if (!result.accepted) {
        setAnswerError(result.error ?? 'send_failed')
      }
    } catch {
      setAnswerError('send_failed')
    } finally {
      setAnsweringPaneKey(null)
    }
  }

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
      {expanded && (summary.pendingQuestion || rows.length > 0) ? (
        <AgentPanel
          summary={summary}
          rows={rows}
          tone={tone}
          pulse={pulse}
          onAnswer={handleAnswer}
          answeringPaneKey={answeringPaneKey}
          answerError={answerError}
        />
      ) : null}
      <StyleBaseline />
    </div>
  )
}

/** Resting capsule: indicator dot + counts + activity label. Keyboard-
 *  operable (Enter / Space) per the WAI-ARIA button pattern. */
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
  // Why: keyboard activation (Enter / Space) so screen-reader and keyboard
  // users can focus the pill via Tab and trigger the click handler. The pill
  // div is `role="button"` so this matches the WAI-ARIA button pattern.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onClick()
    }
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Orca agent status"
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
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

/** Expanded glass panel rendered below the pill on hover or pending question.
 *  Hosts the question/approval card (when present) + the multi-agent list. */
function AgentPanel({
  summary,
  rows,
  tone,
  pulse,
  onAnswer,
  answeringPaneKey,
  answerError
}: {
  summary: StatusPillSummary
  rows: StatusPillAgentRow[]
  tone: Tone
  pulse: boolean
  onAnswer: (paneKey: string, raw: string) => Promise<void>
  answeringPaneKey: string | null
  answerError: string | null
}): React.JSX.Element {
  const total = summary.working + summary.blocked + summary.waiting + summary.recentDone
  const title = summary.pendingQuestion ? 'Agent needs you' : buildPanelTitle(summary)
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
      {summary.pendingQuestion ? (
        <PendingQuestionCard
          pending={summary.pendingQuestion}
          onAnswer={onAnswer}
          submitting={answeringPaneKey === summary.pendingQuestion.paneKey}
          error={answerError}
        />
      ) : null}
      <div className="agent-list">
        {rows.map((row, index) => (
          <AgentRowView key={`${row.paneKey}-${row.receivedAt}`} row={row} index={index} />
        ))}
      </div>
    </div>
  )
}

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
