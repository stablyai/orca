// Who can ask › Add: one picker open's search as the picker paints it, from the service's session.
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BotWhoCanAskFound,
  BotWhoCanAskService,
  BotWhoCanAskSession
} from './BotWhoCanAskList'
import type { BotSlackResult } from '../../../../shared/connector-bot-slack-contract'

const SEARCH_DEBOUNCE_MS = 250

export type WhoCanAskSearch =
  | { status: 'loading' }
  | { status: 'ready'; found: BotWhoCanAskFound }
  | { status: 'failed'; error: string }

/** Who the answers so far showed someone to be: live names by id, and ids a live answer retired. */
export type WhoCanAskIdentities = {
  names: Readonly<Record<string, string>>
  retired: ReadonlySet<string>
}

const NO_IDENTITIES: WhoCanAskIdentities = { names: {}, retired: new Set() }

function learned(known: WhoCanAskIdentities, found: BotWhoCanAskFound): WhoCanAskIdentities {
  const live = found.members.filter(
    (person) => person.live && known.names[person.id] !== person.name
  )
  const retired = (found.retired ?? []).filter((id) => !known.retired.has(id))
  if (live.length === 0 && retired.length === 0) {
    return known
  }
  return {
    names: {
      ...known.names,
      ...Object.fromEntries(live.map((person) => [person.id, person.name]))
    },
    retired: new Set([...known.retired, ...retired])
  }
}

type Paint = {
  generation: { current: number }
  order: { current: { asked: number; shown: number } }
  setIdentities: (update: (known: WhoCanAskIdentities) => WhoCanAskIdentities) => void
  setSearch: (search: WhoCanAskSearch) => void
  errorMessage: (code: string) => string
}

/** Asks `active` for `query` and paints the answer only if it is still the current query's
 *  (`gen`) and nothing asked later has painted; `onAnswer` runs just before it paints. */
function ask(
  active: BotWhoCanAskSession,
  query: string,
  paint: Paint,
  gen: number,
  onAnswer?: () => void
): void {
  paint.order.current.asked += 1
  const asked = paint.order.current.asked
  void active.search(query.trim()).then((result: BotSlackResult<BotWhoCanAskFound>) => {
    if (paint.generation.current !== gen || asked < paint.order.current.shown) {
      return
    }
    onAnswer?.()
    paint.order.current.shown = asked
    if (result.ok) {
      paint.setIdentities((known) => learned(known, result.value))
      paint.setSearch({ status: 'ready', found: result.value })
    } else {
      paint.setSearch({ status: 'failed', error: paint.errorMessage(result.error) })
    }
  })
}

export function useWhoCanAskSearch(
  service: BotWhoCanAskService,
  query: string
): {
  search: WhoCanAskSearch
  identities: WhoCanAskIdentities
  /** A part of the search is being asked again; its Try again does nothing until that answers. */
  retrying: boolean
  retry: () => void
  retryInPlace: () => void
} {
  const [search, setSearch] = useState<WhoCanAskSearch>({ status: 'loading' })
  const [identities, setIdentities] = useState(NO_IDENTITIES)
  const [retrying, setRetrying] = useState(false)
  // Try again starts a fresh session (and with it a fresh read of what the service lists).
  const [session, setSession] = useState(0)
  const { errorMessage, begin, search: searchOnce } = service
  // One search session per picker open, kept across keystrokes and across service objects that
  // differ only in presentation (a GitHub state refresh, a newly linked owner).
  const active = useMemo(
    (): BotWhoCanAskSession => (session >= 0 && begin ? begin() : { search: searchOnce }),
    [begin, searchOnce, session]
  )
  // Bumped whenever the query or session changes, or the picker closes: an answer paints only if
  // nothing changed since it was asked for (it never repaints an old query).
  const generation = useRef(0)
  // Answers of one query paint in the order they were asked, so a slow earlier one never
  // replaces a later one.
  const order = useRef({ asked: 0, shown: 0 })
  // The generation an in-place retry was asked in, until its whole answer paints or the query
  // moves on: a second Try again meanwhile starts nothing.
  const retryOwner = useRef<number | null>(null)

  useEffect(() => {
    generation.current += 1
    const gen = generation.current
    retryOwner.current = null
    setRetrying(false)
    setSearch({ status: 'loading' })
    let issued = false
    // When more of the search lands, ask again for this same query in place: the rows stay up
    // until the fuller answer replaces them. Not before this query's own first search (its
    // debounce), and not while a retry waits for its whole answer.
    const stopWatching =
      active.onUpdate?.(() => {
        if (issued && retryOwner.current === null && generation.current === gen) {
          ask(active, query, { generation, order, setIdentities, setSearch, errorMessage }, gen)
        }
      }) ?? (() => {})
    const timer = setTimeout(() => {
      issued = true
      ask(active, query, { generation, order, setIdentities, setSearch, errorMessage }, gen)
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      generation.current += 1
      clearTimeout(timer)
      stopWatching()
    }
  }, [active, errorMessage, query])

  return {
    search,
    identities,
    retrying,
    retry: () => setSession((count) => count + 1),
    // Try again for a part that failed: the same query asked once more, in place (no
    // "Searching…"), so the rows, picks and count stay until its whole answer replaces the rows.
    retryInPlace: () => {
      if (retryOwner.current !== null) {
        return
      }
      const gen = generation.current
      retryOwner.current = gen
      setRetrying(true)
      active.retry?.()
      ask(active, query, { generation, order, setIdentities, setSearch, errorMessage }, gen, () => {
        retryOwner.current = null
        setRetrying(false)
      })
    }
  }
}
