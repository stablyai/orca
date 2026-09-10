import { useEffect, useState } from 'react'

import { useAppStore } from '@/store'
import { odooSearchMentionCandidates } from '@/runtime/runtime-odoo-client'
import type { OdooMentionSuggestion, OdooTicket } from '../../../shared/odoo-types'
import type { OdooMentionQuery } from './odoo-comment-mention-query'

const MENTION_SEARCH_DEBOUNCE_MS = 200

/** Debounced `@` mention search against the ticket's followers/assignable partners. */
export function useOdooMentionSuggestions(
  ticket: OdooTicket,
  mentionQuery: OdooMentionQuery | null
): { suggestions: OdooMentionSuggestion[]; loading: boolean } {
  const settings = useAppStore((s) => s.settings)
  const [suggestions, setSuggestions] = useState<OdooMentionSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const ticketId = ticket.id
  const instanceId = ticket.instanceId ?? null
  const query = mentionQuery?.query ?? null
  const atIndex = mentionQuery?.atIndex ?? null

  useEffect(() => {
    if (query === null) {
      setSuggestions([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      void odooSearchMentionCandidates(settings, ticketId, query, instanceId)
        .then((rows) => {
          if (!cancelled) {
            setSuggestions(rows)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSuggestions([])
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false)
          }
        })
    }, MENTION_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // atIndex is included so re-entering a mention at a new caret position always
    // re-queries, even when the surrounding query text happens to repeat.
  }, [query, atIndex, ticketId, instanceId, settings])

  return { suggestions, loading }
}
