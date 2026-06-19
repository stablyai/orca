import type { CacheEntry } from '@/store/slices/github'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { GlpiTicket } from '../../../shared/types'

type GlpiTicketCache = Record<string, CacheEntry<GlpiTicket | null>>
type GlpiListCache = Record<string, CacheEntry<GlpiTicket[]>>

export type TaskPageGlpiTicketLookupOptions = {
  sourceContext?: TaskSourceContext | null
  serverId?: string | null
}

export function findTaskPageGlpiTicket(
  glpiTicketCache: GlpiTicketCache,
  glpiListCache: GlpiListCache,
  glpiTicketId: number | null,
  options: TaskPageGlpiTicketLookupOptions = {}
): GlpiTicket | null {
  if (glpiTicketId === null) {
    return null
  }
  const sourceScope =
    options.sourceContext?.provider === 'glpi'
      ? getTaskSourceCacheScope(options.sourceContext)
      : null
  const matchesLookup = (cacheKey: string, ticket: GlpiTicket | null | undefined): boolean => {
    if (!ticket || ticket.id !== glpiTicketId) {
      return false
    }
    if (options.serverId && ticket.serverId !== options.serverId) {
      return false
    }
    // Why: GLPI ticket ids are only unique within a server/source, so drawer
    // lookup must not borrow a same-id ticket cached for another host/account.
    return sourceScope === null || cacheKey.startsWith(`${sourceScope}::`)
  }

  for (const [cacheKey, entry] of Object.entries(glpiTicketCache)) {
    if (matchesLookup(cacheKey, entry?.data)) {
      return entry.data
    }
  }

  for (const [cacheKey, entry] of Object.entries(glpiListCache)) {
    const found = entry?.data?.find((ticket) => matchesLookup(cacheKey, ticket))
    if (found) {
      return found
    }
  }

  return null
}

// Why: GLPI ids are unique per server, so a same-id ticket on a different
// server must not count as still-present when pruning the stale selection.
export function isGlpiTicketStillDisplayed(
  tickets: GlpiTicket[],
  ticketId: number,
  serverId: string | null
): boolean {
  return tickets.some(
    (ticket) => ticket.id === ticketId && (serverId === null || ticket.serverId === serverId)
  )
}
