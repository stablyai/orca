// The Add picker's search: one session per open, kept across keystrokes, with in-place retry and
// what live lookups confirmed about people's identities.
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BotWhoCanAskFound,
  BotWhoCanAskIdentityUpdate,
  BotWhoCanAskService,
  BotWhoCanAskSession
} from './BotWhoCanAskList'
import type { BotSlackResult } from '../../../../shared/connector-bot-slack-contract'

const SEARCH_DEBOUNCE_MS = 250

export type Search =
  | { status: 'loading'; searchPlaceholder?: string }
  | { status: 'ready'; found: BotWhoCanAskFound }
  | { status: 'failed'; error: string }

/** What live lookups confirmed during this picker open: current names by id, and ids whose
 *  listed name was given to someone else. A later confirmation of an id clears its doubt. */
export type Identities = {
  names: Readonly<Record<string, string>>
  superseded: ReadonlySet<string>
}
const NO_IDENTITIES: Identities = { names: {}, superseded: new Set() }

function learnIdentities(known: Identities, confirmed: BotWhoCanAskIdentityUpdate): Identities {
  const superseded = new Set(known.superseded)
  for (const id of confirmed.superseded) {
    superseded.add(id)
  }
  const names = { ...known.names }
  for (const { id, name } of confirmed.current) {
    names[id] = name
    superseded.delete(id)
  }
  return { names, superseded }
}

export function useMemberSearch(
  service: BotWhoCanAskService,
  query: string
): {
  search: Search
  retry: () => void
  retryInPlace: () => void
  retrying: boolean
  identities: Identities
} {
  const [search, setSearch] = useState<Search>({ status: 'loading' })
  const [identities, setIdentities] = useState<Identities>(NO_IDENTITIES)
  // Try again starts a fresh session (and with it a fresh read of what the service lists).
  const [session, setSession] = useState(0)
  const { errorMessage } = service
  // One search session per picker open, kept across keystrokes.
  const active = useMemo(
    (): BotWhoCanAskSession =>
      session >= 0 && service.begin ? service.begin() : { search: service.search },
    [service, session]
  )
  // Bumped whenever the query or session changes, or the picker closes: an in-place retry paints
  // only if nothing changed since it was asked for (it never repaints an old query).
  const generation = useRef(0)
  // The one in-place retry in flight, by the generation it was asked in: clicks while it runs
  // join it rather than asking again; a query change or close leaves it to settle unpainted.
  // The ref answers a second click before React re-renders; the state disables the button.
  const retryAsked = useRef<number | null>(null)
  const [retrying, setRetrying] = useState(false)
  useEffect(() => {
    generation.current += 1
    const mine = generation.current
    let current = true
    const show = (result: BotSlackResult<BotWhoCanAskFound>): void => {
      if (current) {
        setSearch(
          result.ok
            ? { status: 'ready', found: result.value }
            : { status: 'failed', error: errorMessage(result.error) }
        )
      }
    }
    setSearch((previous) => ({
      status: 'loading',
      searchPlaceholder:
        previous.status === 'ready'
          ? previous.found.searchPlaceholder
          : previous.status === 'loading'
            ? previous.searchPlaceholder
            : undefined
    }))
    // A retry asked for the previous query no longer speaks for this one.
    setRetrying(false)
    // When more of the search lands (a list still loading, a username check an early answer went
    // out without), ask again for this same query in place: the rows stay up until the fuller
    // answer replaces them. One listener per query, dropped when the query changes or the picker
    // closes; before this query's first search has gone out, that search will see the arrival.
    let issued = false
    const stopWatching =
      active.onUpdate?.((refresh, confirmed) => {
        if (current && confirmed) {
          setIdentities((known) => learnIdentities(known, confirmed))
        }
        // A held in-place retry owns this query's next answer; it waits for the whole of it.
        if (current && issued && refresh && retryAsked.current !== mine) {
          void active.search(query.trim()).then(show)
        }
      }) ?? (() => {})
    const timer = setTimeout(() => {
      issued = true
      void active.search(query.trim()).then(show)
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      generation.current += 1
      clearTimeout(timer)
      stopWatching()
    }
  }, [active, errorMessage, query])
  return {
    search,
    retry: () => setSession((count) => count + 1),
    retrying,
    identities,
    // Try again for a part that failed: the same query asked once more, in place (no
    // "Searching…"), so the rows, picks and count stay until its answer replaces the rows.
    retryInPlace: () => {
      const asked = generation.current
      if (retryAsked.current === asked) {
        return
      }
      retryAsked.current = asked
      setRetrying(true)
      active.retry?.()
      void active.search(query.trim()).then((result) => {
        if (retryAsked.current === asked) {
          retryAsked.current = null
        }
        if (generation.current === asked) {
          setSearch(
            result.ok
              ? { status: 'ready', found: result.value }
              : { status: 'failed', error: errorMessage(result.error) }
          )
          setRetrying(false)
        }
      })
    }
  }
}
