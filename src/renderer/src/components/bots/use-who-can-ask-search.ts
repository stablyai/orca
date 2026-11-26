// Who can ask › Add: one picker open's search as the picker paints it, from the service's session.
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BotWhoCanAskFound,
  BotWhoCanAskService,
  BotWhoCanAskSession
} from './BotWhoCanAskList'
import type { BotSlackResult } from '../../../../shared/connector-bot-slack-contract'
import type { WhoCanAskIdentityLedger } from './who-can-ask-identity-ledger'

const SEARCH_DEBOUNCE_MS = 250

/** `failed` keeps the service's error code; its words are drawn at render, so a changed label or
 *  language never restarts the search. */
export type WhoCanAskSearch =
  | { status: 'loading' }
  | { status: 'ready'; found: BotWhoCanAskFound }
  | { status: 'failed'; code: string }

type Paint = {
  generation: { current: number }
  order: { current: { asked: number; shown: number } }
  setSearch: (search: WhoCanAskSearch) => void
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
    paint.setSearch(
      result.ok
        ? { status: 'ready', found: result.value }
        : { status: 'failed', code: result.error }
    )
  })
}

export function useWhoCanAskSearch(
  service: BotWhoCanAskService,
  query: string,
  ledger: WhoCanAskIdentityLedger
): {
  search: WhoCanAskSearch
  /** A part of the search is being asked again; its Try again does nothing until that answers. */
  retrying: boolean
  /** Try again: in place when the session can ask only what failed, else a fresh session. */
  retry: () => void
} {
  const [search, setSearch] = useState<WhoCanAskSearch>({ status: 'loading' })
  const [retrying, setRetrying] = useState(false)
  // A fresh session, for a service whose session can't retry in place.
  const [session, setSession] = useState(0)
  const { begin, search: searchOnce } = service
  // One search session per picker open and context, kept across keystrokes and across service
  // objects that differ only in presentation (a refresh, a label, a language, a linked owner).
  const active = useMemo(
    (): BotWhoCanAskSession => (session >= 0 && begin ? begin(ledger) : { search: searchOnce }),
    [begin, searchOnce, session, ledger]
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
    const again = (): void => {
      if (issued && retryOwner.current === null && generation.current === gen) {
        ask(active, query, { generation, order, setSearch }, gen)
      }
    }
    const stopWatching = active.onUpdate?.(again) ?? (() => {})
    // A check settling anywhere this open (an earlier session's included) can change who this
    // query's rows are: rank them again from what the session already holds, asking nothing new.
    const stopLedger = ledger.onSettle(again)
    const timer = setTimeout(() => {
      issued = true
      ask(active, query, { generation, order, setSearch }, gen)
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      generation.current += 1
      clearTimeout(timer)
      stopWatching()
      stopLedger()
    }
  }, [active, query, ledger])

  return {
    search,
    retrying,
    // The same query asked once more, in place (no "Searching…"), so the rows, picks and count
    // stay until its whole answer replaces them; one action at a time.
    retry: () => {
      if (!active.retry) {
        setSession((count) => count + 1)
        return
      }
      if (retryOwner.current !== null) {
        return
      }
      const gen = generation.current
      retryOwner.current = gen
      setRetrying(true)
      // Answers asked before this Try again no longer paint: only its own whole answer does.
      order.current.shown = order.current.asked + 1
      active.retry()
      ask(active, query, { generation, order, setSearch }, gen, () => {
        retryOwner.current = null
        setRetrying(false)
      })
    }
  }
}
