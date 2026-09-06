import { describe, expect, it } from 'vitest'
import {
  canLoadEarlierNativeChatHistory,
  hasMoreNativeChatHistory,
  nativeChatBridgeHasMore,
  nativeChatOlderHistoryFromFrame,
  nativeChatOlderHistoryFromRead,
  nativeChatOlderHistoryFromReadResult,
  nativeChatWindowOmitsOlderRecords,
  NATIVE_CHAT_INITIAL_LIMIT,
  NATIVE_CHAT_PAGE,
  nextNativeChatLimit,
  initialNativeChatReadWindow,
  nextNativeChatPage
} from './native-chat-pagination'
import {
  NATIVE_CHAT_REMOTE_DEFAULT_WINDOW,
  NATIVE_CHAT_REMOTE_MAX_WINDOW
} from '../../../../shared/native-chat-types'

describe('nextNativeChatLimit', () => {
  it('grows the limit by one page', () => {
    expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT)).toBe(
      NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE
    )
    expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE)).toBe(
      NATIVE_CHAT_INITIAL_LIMIT + 2 * NATIVE_CHAT_PAGE
    )
  })

  // XLR-049 (cross-lab review): a runtime that predates the host-side clamp
  // validated `limit` with a hard rejection at the same ceiling, so a request
  // past it fails the read outright -- and load-earlier swallows the rejection,
  // keeping the limit and the 'filled' verdict, so it repeats the rejected
  // request forever and the oldest records stay unreachable.
  it('never grows past the runtime ceiling', () => {
    expect(nextNativeChatLimit(NATIVE_CHAT_REMOTE_MAX_WINDOW - 1)).toBe(
      NATIVE_CHAT_REMOTE_MAX_WINDOW
    )
    expect(nextNativeChatLimit(NATIVE_CHAT_REMOTE_MAX_WINDOW)).toBe(NATIVE_CHAT_REMOTE_MAX_WINDOW)
  })

  it('lands exactly on the ceiling when paging from the first page', () => {
    let limit = NATIVE_CHAT_INITIAL_LIMIT
    for (let page = 0; page < 100; page += 1) {
      limit = nextNativeChatLimit(limit)
      expect(limit).toBeLessThanOrEqual(NATIVE_CHAT_REMOTE_MAX_WINDOW)
    }
    expect(limit).toBe(NATIVE_CHAT_REMOTE_MAX_WINDOW)
  })
})

describe('nextNativeChatPage', () => {
  it('grows the tail limit while growth still makes progress', () => {
    expect(nextNativeChatPage(initialNativeChatReadWindow())).toEqual({
      limit: NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE,
      tailLimit: NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE
    })
    // A cursor is ignored while the limit can still widen: a wider tail re-reads
    // everything behind it and so cannot leave a hole.
    expect(nextNativeChatPage({ limit: NATIVE_CHAT_INITIAL_LIMIT, beforeOffset: 900 })).toEqual({
      limit: NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE,
      tailLimit: NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE
    })
  })

  // XLR-R1-001: at the ceiling the limit alone can no longer reach further back,
  // so without the cursor every later request returns the identical tail and the
  // records behind it are unreachable for the rest of the session.
  it('continues by byte offset once the limit saturates at the ceiling', () => {
    expect(
      nextNativeChatPage({ limit: NATIVE_CHAT_REMOTE_MAX_WINDOW, beforeOffset: 4096 })
    ).toEqual({
      limit: NATIVE_CHAT_PAGE,
      beforeOffset: 4096,
      tailLimit: NATIVE_CHAT_REMOTE_MAX_WINDOW
    })
  })

  // A host too old to report a cursor keeps the pre-existing saturated tail read
  // rather than an offset request it cannot honor.
  it('falls back to a ceiling-wide tail read when no cursor is known', () => {
    expect(nextNativeChatPage({ limit: NATIVE_CHAT_REMOTE_MAX_WINDOW })).toEqual({
      limit: NATIVE_CHAT_REMOTE_MAX_WINDOW,
      tailLimit: NATIVE_CHAT_REMOTE_MAX_WINDOW
    })
  })

  it('keeps making progress page after page past the ceiling', () => {
    let window = initialNativeChatReadWindow()
    const requested: number[] = []
    for (let page = 0; page < 40; page += 1) {
      const next = nextNativeChatPage(window)
      requested.push(next.beforeOffset ?? Number.NaN)
      // Each page reports a cursor further back in the file, as a real read does.
      window = { limit: next.tailLimit, beforeOffset: 100_000 - page * 1_000 }
    }
    const offsets = requested.filter((offset) => !Number.isNaN(offset))
    expect(offsets.length).toBeGreaterThan(0)
    // Every offset-anchored request is strictly older than the one before it.
    expect(offsets).toEqual([...offsets].sort((a, b) => b - a))
    expect(new Set(offsets).size).toBe(offsets.length)
  })
})

describe('hasMoreNativeChatHistory', () => {
  it('reports more when the read filled the requested window', () => {
    expect(hasMoreNativeChatHistory(300, 300)).toBe(true)
    expect(hasMoreNativeChatHistory(301, 300)).toBe(true)
  })

  it('reports done when the read returned fewer than requested (head reached)', () => {
    expect(hasMoreNativeChatHistory(120, 300)).toBe(false)
    expect(hasMoreNativeChatHistory(0, 300)).toBe(false)
  })
})

describe('nativeChatOlderHistoryFromReadResult', () => {
  // XLR-R3-003 (cross-lab review, round 3): a mixed-version host that predates
  // the client-supplied limit answers a 300-record request with its own fixed
  // 40-record page and no `hasMore`. Grading that against the request called it
  // the transcript head and retired Load-earlier for the whole session, even
  // though the subscription path already refuses that inference (XLR-008).
  it('grades a legacy fixed window against the legacy default, not the request', () => {
    const legacyPage = { messages: Array.from({ length: NATIVE_CHAT_REMOTE_DEFAULT_WINDOW }) }
    expect(nativeChatOlderHistoryFromReadResult(legacyPage, 300)).toBe('filled')
    expect(nativeChatOlderHistoryFromReadResult(legacyPage, 500)).toBe('filled')
  })

  it('still reaches the head when even the legacy window came back short', () => {
    expect(
      nativeChatOlderHistoryFromReadResult({ messages: Array.from({ length: 12 }) }, 300)
    ).toBe('none')
  })

  it('prefers the host measurement whenever the read carries one', () => {
    expect(
      nativeChatOlderHistoryFromReadResult(
        { messages: Array.from({ length: 300 }), hasMore: false },
        300
      )
    ).toBe('none')
    // A read is never proof of omission, however the host measured it (SA-008).
    expect(
      nativeChatOlderHistoryFromReadResult(
        { messages: Array.from({ length: 40 }), hasMore: true },
        300
      )
    ).toBe('filled')
  })
})

// XLR-R8-002 (cross-lab review, round 8): a load-earlier page must be able to
// withdraw where the seed read deliberately cannot. Against a legacy host that
// ignores the requested limit and reports neither `hasMore` nor `beforeOffset`,
// the seed's leniency graded every repeat of the same 40 records as 'filled',
// so Load-earlier stayed enabled and each click reissued a request that had
// already failed -- forever once the limit saturated at the wire ceiling.
describe('nativeChatOlderHistoryFromReadResult graded against a load-earlier page', () => {
  const legacyWindow = { messages: Array.from({ length: NATIVE_CHAT_REMOTE_DEFAULT_WINDOW }) }

  it('retires load-earlier when a cursorless host ignored the widened limit', () => {
    expect(nativeChatOlderHistoryFromReadResult(legacyWindow, { limit: 500, tailLimit: 500 })).toBe(
      'none'
    )
  })

  // The seed read keeps its over-offer (XLR-008): the control must still be
  // OFFERED on such a host, it just may not survive the click that proves it.
  it('leaves the seed read grading untouched', () => {
    expect(nativeChatOlderHistoryFromReadResult(legacyWindow, 500)).toBe('filled')
  })

  it('keeps offering while a widened tail is still returning more', () => {
    expect(
      nativeChatOlderHistoryFromReadResult(
        { messages: Array.from({ length: 500 }), beforeOffset: 4096 },
        { limit: 500, tailLimit: 500 }
      )
    ).toBe('filled')
  })

  it('reaches the head when a limit-honouring host answered short', () => {
    expect(
      nativeChatOlderHistoryFromReadResult(
        { messages: Array.from({ length: 380 }), beforeOffset: 12 },
        { limit: 500, tailLimit: 500 }
      )
    ).toBe('none')
  })

  // Growth is exhausted at the ceiling, so a cursor is the only continuation
  // left; without one every later request is byte-identical to this one.
  it('retires a ceiling-wide page that came back with no cursor', () => {
    expect(
      nativeChatOlderHistoryFromReadResult(
        { messages: Array.from({ length: NATIVE_CHAT_REMOTE_MAX_WINDOW }), hasMore: true },
        { limit: NATIVE_CHAT_REMOTE_MAX_WINDOW, tailLimit: NATIVE_CHAT_REMOTE_MAX_WINDOW }
      )
    ).toBe('none')
  })

  it('keeps offering at the ceiling once a cursor anchors the next page', () => {
    expect(
      nativeChatOlderHistoryFromReadResult(
        {
          messages: Array.from({ length: NATIVE_CHAT_REMOTE_MAX_WINDOW }),
          hasMore: true,
          beforeOffset: 8192
        },
        { limit: NATIVE_CHAT_REMOTE_MAX_WINDOW, tailLimit: NATIVE_CHAT_REMOTE_MAX_WINDOW }
      )
    ).toBe('filled')
  })

  it('keeps offering while an offset-anchored continuation still reports a cursor', () => {
    expect(
      nativeChatOlderHistoryFromReadResult(
        { messages: Array.from({ length: NATIVE_CHAT_PAGE }), beforeOffset: 64 },
        {
          limit: NATIVE_CHAT_PAGE,
          beforeOffset: 512,
          tailLimit: NATIVE_CHAT_REMOTE_MAX_WINDOW
        }
      )
    ).toBe('filled')
  })

  it('retires an offset-anchored continuation that stopped reporting a cursor', () => {
    expect(
      nativeChatOlderHistoryFromReadResult(
        { messages: Array.from({ length: NATIVE_CHAT_PAGE }) },
        {
          limit: NATIVE_CHAT_PAGE,
          beforeOffset: 512,
          tailLimit: NATIVE_CHAT_REMOTE_MAX_WINDOW
        }
      )
    ).toBe('none')
  })
})

describe('nativeChatOlderHistoryFromFrame', () => {
  it('grades a host-reported hasMore as a measurement', () => {
    // transcript-tail-reader counts STRICTLY past the limit, so a hasMore the
    // emitter actually sent is proof of a record behind the window.
    expect(nativeChatOlderHistoryFromFrame(true)).toBe('measured')
  })

  it('grades a client-synthesized hasMore no higher than a read (SA-011)', () => {
    // An older remote runtime omits hasMore; both client bridges then infer it
    // from `messages.length >= limit` (native-chat-session-transport.ts,
    // web-native-chat-api.ts). That is the same ambiguous exact-fill count
    // `nativeChatOlderHistoryFromRead` produces, and labelling it 'measured'
    // would let the advisor horizon retire a card no record was ever observed
    // behind.
    expect(nativeChatOlderHistoryFromFrame(true, true)).toBe('filled')
    expect(nativeChatOlderHistoryFromFrame(true, true)).toBe(
      nativeChatOlderHistoryFromRead(300, 300)
    )
  })

  it('reaches the transcript head the same way whoever produced the value', () => {
    expect(nativeChatOlderHistoryFromFrame(false)).toBe('none')
    expect(nativeChatOlderHistoryFromFrame(false, true)).toBe('none')
  })
})

describe('nativeChatBridgeHasMore', () => {
  it('passes an emitter-sent hasMore through unlabeled, both polarities', () => {
    expect(nativeChatBridgeHasMore(true, 2, 2)).toEqual({ hasMore: true })
    // An emitted false is the host reporting the head; the exact fill must not
    // upgrade it back to true.
    expect(nativeChatBridgeHasMore(false, 2, 2)).toEqual({ hasMore: false })
  })

  it('synthesizes and labels an omitted hasMore from the exact fill', () => {
    expect(nativeChatBridgeHasMore(undefined, 2, 2)).toEqual({
      hasMore: true,
      hasMoreInferred: true
    })
  })

  it('reports the head when an omitting runtime underfilled the window', () => {
    // Under-fill is unambiguous, so there is no guess to label.
    expect(nativeChatBridgeHasMore(undefined, 1, 2)).toEqual({ hasMore: false })
  })

  it('grades a legacy full window as a fill even under a larger request (XLR-008)', () => {
    // A runtime old enough to omit `hasMore` is old enough to ignore `limit`:
    // it answers with its own fixed window. Graded against the client's 300 the
    // 40 records it sent read as the transcript head, which suppresses the
    // parallel read and hides Load-earlier over every older record.
    expect(
      nativeChatBridgeHasMore(
        undefined,
        NATIVE_CHAT_REMOTE_DEFAULT_WINDOW,
        NATIVE_CHAT_INITIAL_LIMIT
      )
    ).toEqual({ hasMore: true, hasMoreInferred: true })
    // Under-filling that fixed window is still unambiguous head evidence.
    expect(
      nativeChatBridgeHasMore(
        undefined,
        NATIVE_CHAT_REMOTE_DEFAULT_WINDOW - 1,
        NATIVE_CHAT_INITIAL_LIMIT
      )
    ).toEqual({ hasMore: false })
  })

  it('grades a no-limit read against the window the host actually applied (SA-014)', () => {
    // A caller that omits `limit` does not get NATIVE_CHAT_INITIAL_LIMIT: the
    // runtime RPC substitutes its OWN default (the same shared constant, in
    // main/runtime/rpc/methods/native-chat.ts). An omitting runtime that
    // returns an exactly full default page must therefore read as a fill, not as
    // the transcript head -- grading it against 300 would emit hasMore:false and
    // hide Load-earlier over records that are really there.
    expect(
      nativeChatBridgeHasMore(undefined, NATIVE_CHAT_REMOTE_DEFAULT_WINDOW, undefined)
    ).toEqual({
      hasMore: true,
      hasMoreInferred: true
    })
    expect(
      nativeChatBridgeHasMore(undefined, NATIVE_CHAT_REMOTE_DEFAULT_WINDOW - 1, undefined)
    ).toEqual({
      hasMore: false
    })
  })
})

describe('canLoadEarlierNativeChatHistory', () => {
  it('keeps the affordance for every verdict that is not the transcript head', () => {
    // SA-010: nothing about the RPC session may withdraw it. RPC history walks
    // the ACTIVE LEAF while the JSONL transcript also retains abandoned-branch
    // records, so covering one says nothing about the other — and a 'measured'
    // verdict demotes to 'filled' the moment load-earlier re-derives it at a
    // wider limit, which would otherwise hide the control over records the host
    // had already proven exist.
    expect(canLoadEarlierNativeChatHistory('filled')).toBe(true)
    expect(canLoadEarlierNativeChatHistory('measured')).toBe(true)
  })

  it('never resurrects the affordance on a window that reached the transcript head', () => {
    expect(canLoadEarlierNativeChatHistory('none')).toBe(false)
  })

  it('keeps paginating a window that exactly filled its limit', () => {
    expect(canLoadEarlierNativeChatHistory(nativeChatOlderHistoryFromRead(300, 300))).toBe(true)
  })
})

// The one question a horizon inference may ask of the window: are there older
// records it does not show? Only then does "everything here is newer than X"
// mean X fell off the back rather than X never having been written yet.
//
// SA-008: the answer may NOT be `hasMoreNativeChatHistory`, which is true of an
// exactly-full window and so cannot tell a truncated window from one sitting on
// the transcript head. Keeping the proof in its own field means the wrong value
// fails to typecheck at the construction site; that site's behavior is pinned in
// use-native-chat-live-session.test.ts ('older-record omission proof').
describe('nativeChatWindowOmitsOlderRecords', () => {
  it('is true only for a settled read that still has older history behind it', () => {
    expect(nativeChatWindowOmitsOlderRecords({ settled: true, omitsOlderRecords: true })).toBe(true)
  })

  it('is false when the window reaches the head of the transcript', () => {
    expect(nativeChatWindowOmitsOlderRecords({ settled: true, omitsOlderRecords: false })).toBe(
      false
    )
  })

  it('is false while the read has not settled, whatever the stale proof says', () => {
    // 'loading'/'awaiting' hold a partial list (live appends only), so its
    // oldest row is not the window's horizon.
    expect(nativeChatWindowOmitsOlderRecords({ settled: false, omitsOlderRecords: true })).toBe(
      false
    )
  })

  it('is false when no window metadata is supplied at all', () => {
    expect(nativeChatWindowOmitsOlderRecords(null)).toBe(false)
    expect(nativeChatWindowOmitsOlderRecords(undefined)).toBe(false)
  })
})
