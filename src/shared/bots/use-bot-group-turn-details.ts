import type * as React from 'react'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import type { BotGroupTurnDetailCursor } from './bot-group-read-schema'

export type BotGroupTurnDetailPage = {
  items: AgentJournalRenderItem[]
  before?: BotGroupTurnDetailCursor
}

let nextDetailRequestId = 0

/** Local IPC and phone request cancellation need an explicit release at the room host. */
export async function requestBotGroupTurnPage(
  read: (
    viewer: { requestId: string; cancel?: true },
    signal?: AbortSignal
  ) => Promise<BotGroupTurnDetailPage>,
  signal: AbortSignal
): Promise<BotGroupTurnDetailPage> {
  signal.throwIfAborted()
  const requestId = `${Date.now()}-${++nextDetailRequestId}`
  const release = () => void read({ requestId, cancel: true }).catch(() => {})
  signal.addEventListener('abort', release, { once: true })
  try {
    return await read({ requestId }, signal)
  } finally {
    signal.removeEventListener('abort', release)
  }
}

/** Each application resolves its own React instance. */
export function createBotGroupTurnDetailsHook({
  useEffect,
  useRef,
  useState
}: Pick<typeof React, 'useEffect' | 'useRef' | 'useState'>) {
  return function useBotGroupTurnDetails(
    read: (
      before: BotGroupTurnDetailCursor | undefined,
      signal: AbortSignal
    ) => Promise<BotGroupTurnDetailPage>,
    readOnOpen: boolean,
    visible = true
  ) {
    const [open, setOpen] = useState(false)
    const [storedPage, setPage] = useState<
      (BotGroupTurnDetailPage & { earlier: boolean; read: typeof read }) | null
    >(null)
    const [request, setRequest] = useState<{
      controller: AbortController
      read: typeof read
    } | null>(null)
    const pending = useRef<AbortController | null>(null)
    useEffect(() => () => pending.current?.abort(), [read, visible])
    const page = storedPage?.read === read ? storedPage : null
    const loading = visible && request?.read === read && !request.controller.signal.aborted
    const expanded = open && (!readOnOpen || page !== null || loading)

    const load = (before?: BotGroupTurnDetailCursor) => {
      if (!visible || (pending.current && !pending.current.signal.aborted)) {
        return
      }
      const request = new AbortController()
      pending.current = request
      setRequest({ controller: request, read })
      void read(before, request.signal)
        .then((next) => {
          if (request.signal.aborted) {
            return
          }
          setPage({ ...next, earlier: before !== undefined, read })
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
      setOpen(!expanded)
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
      loading
    }
  }
}
