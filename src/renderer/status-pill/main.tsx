import './pill.css'

import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  StatusPillAgentRow,
  StatusPillAnswerResult,
  StatusPillPreferences,
  StatusPillPreloadApi,
  StatusPillSummary
} from '../../shared/status-pill-preload-api'
import { EMPTY_STATUS_PILL_SUMMARY } from '../../shared/status-pill-preload-api'
import { Island } from './island'
import { usePillDrag } from './use-pill-drag'
import { usePillContentRect } from './use-pill-content-rect'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    api: StatusPillPreloadApi | undefined
  }
}

const EMPTY_SUMMARY = EMPTY_STATUS_PILL_SUMMARY

/** Pill root: subscribes to main's snapshot/rows push channels, manages
 *  compact/expand state, routes answer + focus clicks through preload. */
function StatusPill(): React.JSX.Element {
  const api = window.api
  const [summary, setSummary] = useState<StatusPillSummary>(EMPTY_SUMMARY)
  const [rows, setRows] = useState<StatusPillAgentRow[]>([])
  const [preferences, setPreferences] = useState<StatusPillPreferences | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [entered, setEntered] = useState(false)
  const [answeringPaneKey, setAnsweringPaneKey] = useState<string | null>(null)
  const [answerError, setAnswerError] = useState<string | null>(null)
  const [attention, setAttention] = useState(false)
  const attentionTimer = useRef<number | null>(null)
  const stackRef = useRef<HTMLDivElement | null>(null)
  const prefersReducedMotionRef = useRef(false)

  const drag = usePillDrag()
  usePillContentRect(window.api, stackRef)

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
    const unsubAttention = api.onAttentionPulse(() => {
      if (!mounted || prefersReducedMotionRef.current) {
        return
      }
      setAttention(true)
      if (attentionTimer.current !== null) {
        window.clearTimeout(attentionTimer.current)
      }
      attentionTimer.current = window.setTimeout(() => {
        if (mounted) {
          setAttention(false)
        }
      }, 1300)
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
      unsubAttention()
      if (attentionTimer.current !== null) {
        window.clearTimeout(attentionTimer.current)
        attentionTimer.current = null
      }
      window.cancelAnimationFrame(enterRaf)
    }
  }, [api])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      const apply = (): void => {
        prefersReducedMotionRef.current = mq.matches
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

  const handleClick = (): void => {
    if (drag.consumeClick()) {
      return
    }
    window.api?.fireClick()
  }

  // Why: Vibe Island model — compact island always visible, expands on hover or
  //  when a question is pending.
  const showExpanded = hovered || expanded

  return (
    <Island
      summary={summary}
      rows={rows}
      expanded={showExpanded && rows.length > 0}
      entered={entered}
      attention={attention}
      dragging={drag.dragging}
      pending={summary.pendingQuestion}
      onAnswer={handleAnswer}
      onFocusPane={(paneKey, worktreeId) =>
        window.api?.focusPane({ paneKey, worktreeId: worktreeId ?? null })
      }
      answeringPaneKey={answeringPaneKey}
      answerError={answerError}
      onMouseDown={drag.onMouseDown}
      onClick={handleClick}
      onContextMenu={(event) => {
        event.preventDefault()
        window.api?.fireContextMenu()
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false)
        setExpanded(false)
      }}
      stackRef={stackRef}
    />
  )
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Status pill root element not found.')
}
createRoot(rootElement).render(<StatusPill />)
