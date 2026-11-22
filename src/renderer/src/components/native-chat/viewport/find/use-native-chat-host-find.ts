import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  stepNativeChatFindLocally,
  type NativeChatFindInput,
  type NativeChatFindOutcome,
  type NativeChatFindPosition,
  type NativeChatFindResult
} from '../../../../../../shared/native-chat/find/native-chat-session-find'

/** Searches the chat's whole history on the host that owns it. */
export type NativeChatFindSearch = {
  run: (input: NativeChatFindInput) => Promise<NativeChatFindOutcome>
  /** Changes when the chat's content does, so open results refresh. */
  revision: unknown
}

/** A host match to show: `navigationId` changes on each search or step the reader makes. */
export type NativeChatFindTarget = NativeChatFindPosition & { navigationId: number }

export type NativeChatHostFind =
  | { mode: 'dom' }
  | {
      mode: 'host'
      /** No result for the typed query yet. */
      pending: boolean
      totalMatches: number
      activeIndex: number
      target: NativeChatFindTarget | null
      step: (delta: 1 | -1) => void
    }

const QUERY_DEBOUNCE_MS = 100
const CONTENT_REFRESH_MS = 300

type Request = { start?: NativeChatFindPosition; offset: number; navigationId: number }
type Shown = {
  query: string
  result: NativeChatFindResult
  activeIndex: number
  match: NativeChatFindPosition | null
  navigationId: number
}

/** Runs only while the bar has a query; each newer request replaces the one before it. */
export function useNativeChatHostFind({
  search,
  query,
  isVisible,
  readStart
}: {
  search: NativeChatFindSearch | undefined
  query: string
  isVisible: boolean
  /** The message the reader is looking at, where a new query starts. */
  readStart: () => NativeChatFindPosition | undefined
}): NativeChatHostFind {
  const trimmed = query.trim()
  const [unsupported, setUnsupported] = useState(false)
  const [failedQuery, setFailedQuery] = useState<string | null>(null)
  const [debounced, setDebounced] = useState(trimmed)
  const [request, setRequest] = useState<Request>({ offset: 0, navigationId: 0 })
  const [shown, setShown] = useState<Shown | null>(null)
  const navigationRef = useRef(0)
  const shownRef = useRef(shown)
  useLayoutEffect(() => {
    shownRef.current = shown
  }, [shown])
  const startHere = useEffectEvent(readStart)
  const run = search?.run
  const active = Boolean(run) && !unsupported && isVisible

  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setTimeout(() => {
      navigationRef.current += 1
      setRequest({
        start: trimmed ? startHere() : undefined,
        offset: 0,
        navigationId: navigationRef.current
      })
      setDebounced(trimmed)
    }, QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [active, trimmed])

  useEffect(() => {
    if (!active || !run || !debounced) {
      return
    }
    let current = true
    void run({ query: debounced, start: request.start, offset: request.offset }).then(
      (outcome) => {
        if (!current) {
          return
        }
        if ('unsupported' in outcome) {
          setUnsupported(true)
          return
        }
        if ('error' in outcome) {
          if (outcome.error !== 'superseded') {
            setFailedQuery(debounced)
          }
          return
        }
        setFailedQuery(null)
        setShown({
          query: debounced,
          result: outcome,
          activeIndex: outcome.activeIndex,
          match: outcome.match,
          navigationId: request.navigationId
        })
      },
      () => {
        if (current) {
          setFailedQuery(debounced)
        }
      }
    )
    return () => {
      current = false
    }
  }, [active, run, debounced, request])

  // Streamed rows change the counts: search again from the shown match, without moving to it.
  const revision = search?.revision
  const seenRevisionRef = useRef(revision)
  useEffect(() => {
    if (seenRevisionRef.current === revision) {
      return
    }
    seenRevisionRef.current = revision
    if (!active || !debounced) {
      return
    }
    const timer = setTimeout(() => {
      const match = shownRef.current?.match
      setRequest((previous) => ({
        start: match ?? previous.start,
        offset: 0,
        navigationId: shownRef.current?.navigationId ?? previous.navigationId
      }))
    }, CONTENT_REFRESH_MS)
    return () => clearTimeout(timer)
  }, [active, debounced, revision])

  const step = useCallback((delta: 1 | -1) => {
    const current = shownRef.current
    if (!current || current.result.totalMatches === 0) {
      return
    }
    navigationRef.current += 1
    const navigationId = navigationRef.current
    const local = stepNativeChatFindLocally(current.result, current.activeIndex, delta)
    if (local) {
      setShown({ ...current, ...local, navigationId })
      return
    }
    setRequest({ start: current.match ?? undefined, offset: delta, navigationId })
  }, [])

  const showing = shown && shown.query === trimmed ? shown : null
  const entryId = showing?.match?.entryId
  const occurrence = showing?.match?.occurrence
  const navigationId = showing?.navigationId
  // Stable while the match is: the highlighter searches the page again when it changes.
  const target = useMemo(
    () =>
      entryId !== undefined && occurrence !== undefined && navigationId !== undefined
        ? { entryId, occurrence, navigationId }
        : null,
    [entryId, occurrence, navigationId]
  )
  if (!active || failedQuery === trimmed) {
    return { mode: 'dom' }
  }
  return {
    mode: 'host',
    pending: trimmed.length > 0 && !showing,
    totalMatches: showing?.result.totalMatches ?? 0,
    activeIndex: showing?.activeIndex ?? -1,
    target,
    step
  }
}
