import { useEffect, useRef, useState } from 'react'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import type { BotGroupTurnDetailCursor } from './bot-group-read-schema'

export type BotGroupTurnDetailPage = {
  items: AgentJournalRenderItem[]
  before?: BotGroupTurnDetailCursor
}

export function useBotGroupTurnDetails(
  read: (
    before: BotGroupTurnDetailCursor | undefined,
    signal: AbortSignal
  ) => Promise<BotGroupTurnDetailPage>,
  readOnOpen: boolean,
  visible = true
) {
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState<(BotGroupTurnDetailPage & { earlier: boolean }) | null>(null)
  const [request, setRequest] = useState<AbortController | null>(null)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [read, visible])

  const load = (before?: BotGroupTurnDetailCursor) => {
    if (!visible || (pending.current && !pending.current.signal.aborted)) {
      return
    }
    const request = new AbortController()
    pending.current = request
    setRequest(request)
    void read(before, request.signal)
      .then((next) => {
        if (request.signal.aborted) {
          return
        }
        setPage({ ...next, earlier: before !== undefined })
      })
      .catch(() => {
        // Closing and reopening the disclosure retries a failed first read.
      })
      .finally(() => {
        if (!request.signal.aborted) {
          pending.current = null
          setRequest(null)
        }
      })
  }

  const toggle = () => {
    setExpanded(!expanded)
    if (expanded) {
      pending.current?.abort()
      pending.current = null
      setRequest(null)
      setPage(null)
    } else if (readOnOpen) {
      load()
    }
  }

  return {
    expanded,
    toggle,
    items: page?.items,
    back: page?.earlier ? () => load() : undefined,
    loadEarlier: page?.before === undefined ? undefined : () => load(page.before),
    loading: visible && request !== null && !request.signal.aborted
  }
}
