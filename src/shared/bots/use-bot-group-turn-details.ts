import { useEffect, useRef, useState } from 'react'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'

export type BotGroupTurnDetailPage = { items: AgentJournalRenderItem[]; beforeSequence?: number }

export function useBotGroupTurnDetails(
  read: (before: number | undefined, signal: AbortSignal) => Promise<BotGroupTurnDetailPage>,
  readOnOpen: boolean,
  visible = true
) {
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState<BotGroupTurnDetailPage | null>(null)
  const [loading, setLoading] = useState(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [read, visible])

  const load = (before?: number) => {
    if (!visible || (pending.current && !pending.current.signal.aborted)) {
      return
    }
    const request = new AbortController()
    pending.current = request
    setLoading(true)
    void read(before, request.signal)
      .then((next) => {
        if (request.signal.aborted) {
          return
        }
        setPage((previous) => {
          if (before === undefined || !previous) {
            return next
          }
          const items = new Map(
            [...next.items, ...previous.items].map((item) => [item.itemId, item])
          )
          return {
            ...next,
            items: [...items.values()].sort(
              (a, b) => a.sequence - b.sequence || (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
            )
          }
        })
      })
      .catch(() => {
        // Closing and reopening the disclosure retries a failed first read.
      })
      .finally(() => {
        if (!request.signal.aborted) {
          pending.current = null
          setLoading(false)
        }
      })
  }

  const toggle = () => {
    setExpanded(!expanded)
    if (expanded) {
      pending.current?.abort()
      pending.current = null
      setLoading(false)
      setPage(null)
    } else if (readOnOpen) {
      load()
    }
  }

  return {
    expanded,
    toggle,
    items: page?.items,
    loadEarlier: page?.beforeSequence === undefined ? undefined : () => load(page.beforeSequence),
    loading
  }
}
