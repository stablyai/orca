import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LinearInboxPage,
  LinearTriagePage
} from '../../../../../shared/linear/attention-types'
import type { LinearPersonalReadScope } from '../../../../../shared/linear/personal-read-types'

export type AttentionPage = LinearInboxPage | LinearTriagePage

function mergeAttentionRows<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const items = new Map(previous.map((item) => [item.id, item]))
  for (const item of next) {
    items.set(item.id, item)
  }
  return [...items.values()]
}

export function useLinearAttentionPage(options: {
  mode: 'inbox' | 'triage'
  workspaceId: string
  teamId: string | null
  scope: LinearPersonalReadScope | null
  unavailable: string | null
}) {
  const [page, setPage] = useState<AttentionPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const alive = useRef(true)
  const busy = useRef(false)
  const [initial] = useState(options)
  const { mode, workspaceId, teamId, scope, unavailable } = initial

  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      if (busy.current || unavailable) {
        return
      }
      busy.current = true
      setLoading(true)
      setError(null)
      if (!cursor) {
        setPage(null)
      }
      try {
        let result: AttentionPage
        if (mode === 'inbox') {
          if (!scope || !window.api.linear.personalInbox) {
            throw new Error('Inbox is unavailable in this client.')
          }
          const inbox = await window.api.linear.personalInbox({ workspaceId, cursor })
          if (JSON.stringify(inbox.scope) !== JSON.stringify(scope)) {
            throw new Error(
              'Linear identity changed. Refresh the connection before reading your Inbox.'
            )
          }
          result = inbox
        } else {
          if (!teamId || !window.api.linear.triagePage) {
            throw new Error('Triage is unavailable in this client.')
          }
          result = await window.api.linear.triagePage({ workspaceId, teamId, cursor })
        }
        if (!alive.current) {
          return
        }
        setPage((previous) => {
          if (!cursor || !previous) {
            return result
          }
          if ('scope' in result && 'scope' in previous) {
            return { ...result, items: mergeAttentionRows(previous.items, result.items) }
          }
          if (!('scope' in result) && !('scope' in previous)) {
            return { ...result, items: mergeAttentionRows(previous.items, result.items) }
          }
          return result
        })
      } catch (failure) {
        if (alive.current) {
          setPage(null)
          setError(failure instanceof Error ? failure.message : 'Linear could not load this list.')
        }
      } finally {
        busy.current = false
        if (alive.current) {
          setLoading(false)
        }
      }
    },
    [mode, workspaceId, teamId, scope, unavailable]
  )

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])
  return { page, error, loading, load }
}
