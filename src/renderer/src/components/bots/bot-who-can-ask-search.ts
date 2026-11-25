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

export type Search = (
  | { status: 'loading'; announce: boolean }
  | { status: 'ready'; found: BotWhoCanAskFound }
  | { status: 'failed'; error: string }
) & { searchPlaceholder?: string }

function applySearchResult(previous: Search, result: BotSlackResult<BotWhoCanAskFound>): Search {
  return result.ok
    ? { status: 'ready', found: result.value, searchPlaceholder: result.value.searchPlaceholder }
    : { status: 'failed', error: result.error, searchPlaceholder: previous.searchPlaceholder }
}

/** What live lookups confirmed during this picker open: current names by id, and ids whose
 *  listed name was given to someone else. A later confirmation of an id clears its doubt. */
export type Identities = {
  names: Readonly<Record<string, string>>
  superseded: ReadonlySet<string>
}
const NO_IDENTITIES: Identities = { names: {}, superseded: new Set() }

function learnIdentities(known: Identities, confirmed: BotWhoCanAskIdentityUpdate): Identities {
  const superseded = new Set(known.superseded)
  for (const { id, name } of confirmed.superseded) {
    const current = known.names[id]
    if (!current || current.toLowerCase() === name.toLowerCase()) {
      superseded.add(id)
    }
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
  checkingIdentities: boolean
  isCheckingIdentities: () => boolean
} {
  const [search, setSearch] = useState<Search>({ status: 'loading', announce: false })
  const [identities, setIdentities] = useState<Identities>(NO_IDENTITIES)
  const [attempt, setAttempt] = useState(0)
  const { begin, search: runSearch, kind } = service
  // One search session per picker open, kept across keystrokes.
  const active = useMemo(
    (): BotWhoCanAskSession => (attempt >= 0 && begin ? begin() : { search: runSearch }),
    [begin, runSearch, attempt]
  )
  // Bumped whenever the query or session changes, or the picker closes: an in-place retry paints
  // only if nothing changed since it was asked for (it never repaints an old query).
  const generation = useRef(0)
  // The one in-place retry in flight, by the generation it was asked in: clicks while it runs
  // join it rather than asking again; a query change or close leaves it to settle unpainted.
  // The ref answers a second click before React re-renders; the state disables the button.
  const retryAsked = useRef<number | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [checkingIdentities, setCheckingIdentities] = useState(false)
  const isCheckingIdentities = (): boolean => active.isCheckingIdentities?.() ?? false
  useEffect(() => {
    generation.current += 1
    const mine = generation.current
    let current = true
    const show = (result: BotSlackResult<BotWhoCanAskFound>): void => {
      if (current) {
        setSearch((previous) => applySearchResult(previous, result))
      }
    }
    setSearch((previous) => ({
      status: 'loading',
      announce: kind !== 'github',
      searchPlaceholder: previous.searchPlaceholder
    }))
    // A retry asked for the previous query no longer speaks for this one.
    setRetrying(false)
    setCheckingIdentities(active.isCheckingIdentities?.() ?? false)
    // When more of the search lands (a list still loading, a username check an early answer went
    // out without), ask again for this same query in place: the rows stay up until the fuller
    // answer replaces them. One listener per query, dropped when the query changes or the picker
    // closes; before this query's first search has gone out, that search will see the arrival.
    let issued = false
    const stopWatching =
      active.onUpdate?.((refresh, confirmed) => {
        if (!current) {
          return
        }
        setCheckingIdentities(active.isCheckingIdentities?.() ?? false)
        if (confirmed) {
          setIdentities((known) => learnIdentities(known, confirmed))
        }
        // A held in-place retry owns this query's next answer; it waits for the whole of it.
        if (issued && refresh && retryAsked.current !== mine) {
          void active.search(query.trim()).then(show)
        }
      }) ?? (() => {})
    const timer = setTimeout(() => {
      issued = true
      void active.search(query.trim()).then(show)
    }, SEARCH_DEBOUNCE_MS)
    const announce = setTimeout(() => {
      setSearch((previous) =>
        previous.status === 'loading' ? { ...previous, announce: true } : previous
      )
    }, SEARCH_DEBOUNCE_MS + 200)
    return () => {
      current = false
      generation.current += 1
      clearTimeout(timer)
      clearTimeout(announce)
      stopWatching()
    }
  }, [active, kind, query])
  // Keep the answered part of the current search, including when no rows could be shown.
  const retryInPlace = (): void => {
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
        setSearch((previous) => applySearchResult(previous, result))
        setRetrying(false)
      }
    })
  }
  return {
    search,
    retry: active.retry ? retryInPlace : () => setAttempt((count) => count + 1),
    retryInPlace,
    retrying,
    identities,
    checkingIdentities,
    isCheckingIdentities
  }
}
