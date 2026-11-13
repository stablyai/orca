// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { useNativeChatPendingDelivery } from './use-native-chat-pending-delivery'
import { clearPendingSendCacheForTests } from './native-chat-pending'
import * as pendingOwner from './native-chat-pending'
import { useNativeChatAssembledMessages } from '../assembly/use-native-chat-assembled-messages'

const boundary: NativeChatMessage = {
  id: 'boundary',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'before' }],
  timestamp: null,
  source: 'transcript'
}
const args = { paneKey: 'pane', agent: 'claude' as const }
function userRow(text: string): NativeChatMessage {
  return { ...boundary, id: `user:${text}`, role: 'user', blocks: [{ type: 'text', text }] }
}
function render() {
  return renderHook(
    ({ messages }) => useNativeChatPendingDelivery({ ...args, session: { messages } }),
    {
      initialProps: { messages: [boundary] }
    }
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  clearPendingSendCacheForTests()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([200, 2000])(
  'searches only the source suffix after a disjoint %i-row reconnect publication',
  (size) => {
    let observing = false
    let reads = 0
    const originalObserve = pendingOwner.observePendingSendCache
    vi.spyOn(pendingOwner, 'observePendingSendCache').mockImplementation((...input) => {
      observing = true
      try {
        return originalObserve(...input)
      } finally {
        observing = false
      }
    })
    const initial = { ...boundary, id: 'original-frontier', timestamp: 1 }
    const first = { ...boundary, id: 'append-one', timestamp: 10_000 }
    const second = { ...boundary, id: 'append-two', timestamp: 10_001 }
    const disjoint = Array.from({ length: size }, (_, index) => ({
      ...boundary,
      timestamp: index + 100,
      get id() {
        if (observing) {
          reads++
        }
        return `disjoint-${index}`
      }
    }))
    const empty: NativeChatMessage[] = []
    const mounted = renderHook(
      ({ baseMessages, appended }) => {
        const assembly = useNativeChatAssembledMessages({
          agent: 'claude',
          sessionId: 'session',
          baseMessages,
          appended
        })
        return useNativeChatPendingDelivery({
          ...args,
          session: {
            messages: assembly.normalizedMessages,
            sourceObservation: assembly.sourceObservation,
            readPhase: 'ready',
            sessionId: 'session'
          }
        })
      },
      { initialProps: { baseMessages: [initial], appended: empty } }
    )
    mounted.rerender({ baseMessages: disjoint, appended: empty })
    expect(reads).toBeLessThanOrEqual(size + 2)
    reads = 0
    mounted.rerender({ baseMessages: disjoint, appended: [first] })
    expect(reads).toBeLessThanOrEqual(2)
    reads = 0
    mounted.rerender({ baseMessages: disjoint, appended: [first, second] })
    expect(reads).toBeLessThanOrEqual(2)
    act(() => mounted.result.current.record('waiting', undefined, false, 'claude'))
    expect(mounted.result.current.pending[0].sourceBoundary?.id).toBe('original-frontier')
    // A newly paged base can restore overlap; a miss never promotes an unfamiliar tail.
    mounted.rerender({ baseMessages: [initial, ...disjoint], appended: [first, second] })
    act(() => mounted.result.current.record('later', undefined, false, 'claude'))
    expect(mounted.result.current.pending.at(-1)?.sourceBoundary?.id).toBe('append-two')
  }
)

it('keeps a new old-host Send behind its visible window after a disjoint reconnect', () => {
  vi.setSystemTime(4000)
  type Session = Parameters<typeof useNativeChatPendingDelivery>[0]['session']
  const initial: Session = {
    messages: [{ ...boundary, id: 'A', timestamp: 1000 }],
    readPhase: 'ready',
    sessionId: 'session'
  }
  const mounted = renderHook(({ session }) => useNativeChatPendingDelivery({ ...args, session }), {
    initialProps: { session: initial }
  })
  const old = [
    { ...userRow('repeat'), id: 'old-user', timestamp: 2000 },
    { ...boundary, id: 'B', timestamp: 3000 }
  ]
  mounted.rerender({ session: { ...initial, messages: old } })
  let id = ''
  act(() => {
    id = mounted.result.current.record('repeat', undefined, false, 'claude')
    mounted.result.current.setSourceEvidence(id, false)
  })
  expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([id])
  const unrelated = { ...userRow('other'), id: 'unrelated', timestamp: 4100 }
  mounted.rerender({ session: { ...initial, messages: [...old, unrelated] } })
  expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([id])
  mounted.rerender({
    session: {
      ...initial,
      messages: [
        ...old,
        unrelated,
        { ...userRow('repeat'), id: 'genuine-user', timestamp: 4200 },
        { ...boundary, id: 'genuine-answer', timestamp: 4300 }
      ]
    }
  })
  expect(mounted.result.current.pending).toEqual([])
})

describe('terminal Chat pending delivery', () => {
  it('keeps uncertain queued input pending until an authoritative session can observe its turn', () => {
    const initialSession: Parameters<typeof useNativeChatPendingDelivery>[0]['session'] = {
      messages: [],
      readPhase: 'loading',
      sessionId: null
    }
    const initialProps: { session: typeof initialSession; workingEpoch: number | null } = {
      session: initialSession,
      workingEpoch: 7
    }
    const { result, rerender } = renderHook(
      ({ session, workingEpoch }) =>
        useNativeChatPendingDelivery({ ...args, session, workingEpoch }),
      { initialProps }
    )
    act(() => {
      const id = result.current.record('queued content', undefined, false, 'claude')
      result.current.holdUnconfirmed(id)
    })
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.pending[0].delivery).toBeUndefined()
    rerender({
      session: { messages: [], readPhase: 'ready', sessionId: 'session' },
      workingEpoch: 7
    })
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.pending[0].delivery).toBeUndefined()
    rerender({
      session: { messages: [], readPhase: 'ready', sessionId: 'session' },
      workingEpoch: null
    })
    act(() => vi.advanceTimersByTime(19_999))
    expect(result.current.pending[0].delivery).toBeUndefined()
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.pending.map((entry) => [entry.text, entry.delivery])).toEqual([
      ['queued content', 'unconfirmed']
    ])
  })

  it('keeps a send, and its failure notice, when a different session with old history loads', () => {
    const old: NativeChatMessage[] = [
      { ...userRow('run tests'), id: 'old-user', timestamp: 10 },
      { ...boundary, id: 'old-answer', timestamp: 20 }
    ]
    const initialSession: Parameters<typeof useNativeChatPendingDelivery>[0]['session'] = {
      messages: [],
      readPhase: 'ready',
      sessionId: 'new-session'
    }
    const { result, rerender } = renderHook(
      ({ session }) => useNativeChatPendingDelivery({ ...args, session }),
      { initialProps: { session: initialSession } }
    )
    act(() => {
      result.current.reject(result.current.record('run tests'))
    })
    rerender({ session: { messages: old, readPhase: 'ready', sessionId: 'resumed-session' } })
    expect(result.current.pending.map((entry) => entry.text)).toEqual(['run tests'])
    expect(result.current.notices.size).toBe(1)
  })
  it('keeps a failed send through Stop while dropping sends Stop may have cancelled', () => {
    const { result } = render()
    act(() => {
      result.current.reject(result.current.record('refused'))
      result.current.record('in flight')
    })
    act(() => result.current.clear())
    expect(result.current.pending.map((entry) => [entry.text, entry.delivery])).toEqual([
      ['refused', 'rejected']
    ])
  })
})

it('retains spent receipts and the source frontier across hook remounts and an empty drain', () => {
  const source = (id: string, order: number): NativeChatMessage => ({
    ...userRow('repeat'),
    id,
    transcriptOrder: order,
    inputContent: {
      provider: 'opencode',
      textDigest: createHash('sha256').update('repeat').digest('hex'),
      images: []
    }
  })
  const completed = (id: string, order: number): NativeChatMessage => ({
    ...boundary,
    id,
    transcriptOrder: order
  })
  const mount = (messages: NativeChatMessage[]) =>
    renderHook(
      ({ messages }) =>
        useNativeChatPendingDelivery({
          ...args,
          agent: 'opencode',
          session: { messages, readPhase: 'ready', sessionId: 'session' }
        }),
      { initialProps: { messages } }
    )
  const first = mount([{ ...boundary, transcriptOrder: 0 }])
  act(() => {
    first.result.current.record('repeat', undefined, false, 'opencode')
    first.result.current.record('repeat', undefined, false, 'opencode')
  })
  first.rerender({ messages: [source('receipt', 1), completed('answer', 2)] })
  expect(first.result.current.pending).toHaveLength(1)
  const survivor = first.result.current.pending[0].id
  first.unmount()
  const remounted = mount([])
  act(() => {
    remounted.result.current.record('repeat', undefined, false, 'opencode')
  })
  remounted.rerender({ messages: [source('receipt', 1), completed('answer', 2)] })
  expect(remounted.result.current.pending).toHaveLength(2)
  remounted.rerender({ messages: [source('next', 3), completed('next-answer', 4)] })
  expect(remounted.result.current.pending).toHaveLength(1)
  expect(remounted.result.current.pending[0].id).not.toBe(survivor)
  act(() => {
    remounted.result.current.cancel(remounted.result.current.pending[0].id, true)
  })
  remounted.rerender({ messages: [] })
  act(() => {
    remounted.result.current.record('repeat', undefined, false, 'opencode')
  })
  remounted.rerender({ messages: [source('next', 3), completed('next-answer', 4)] })
  expect(remounted.result.current.pending).toHaveLength(1)
  remounted.rerender({ messages: [source('last', 5), completed('last-answer', 6)] })
  expect(remounted.result.current.pending).toEqual([])
})

function mountOwned(messages: NativeChatMessage[] = [boundary]) {
  return renderHook(
    ({ messages }) =>
      useNativeChatPendingDelivery({
        ...args,
        agent: 'opencode',
        session: { messages, readPhase: 'ready', sessionId: 'session' }
      }),
    { initialProps: { messages } }
  )
}
function sourceRow(text: string, id = `source:${text}`): NativeChatMessage {
  return {
    ...userRow(text),
    id,
    inputContent: {
      provider: 'opencode',
      textDigest: createHash('sha256').update(text).digest('hex'),
      images: []
    }
  }
}

it.each([true, false])(
  'keeps a source=%s survivor behind its timestamp after the session changes',
  (source) => {
    vi.setSystemTime(4000)
    type Session = Parameters<typeof useNativeChatPendingDelivery>[0]['session']
    const initial: Session = {
      messages: [{ ...boundary, id: 'reused-boundary', timestamp: 1000 }],
      readPhase: 'ready',
      sessionId: 'A'
    }
    const mounted = renderHook(
      ({ session }) => useNativeChatPendingDelivery({ ...args, agent: 'opencode', session }),
      { initialProps: { session: initial } }
    )
    let id = ''
    act(() => {
      id = mounted.result.current.record('repeat', undefined, false, 'opencode')
      mounted.result.current.setSourceEvidence(id, source)
    })
    const old = [
      { ...sourceRow('repeat', 'old-user'), timestamp: 500 },
      { ...boundary, id: 'reused-boundary', timestamp: 600 }
    ]
    mounted.rerender({ session: { ...initial, sessionId: 'B', messages: old } })
    expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([id])
    mounted.rerender({
      session: {
        ...initial,
        sessionId: 'B',
        messages: [
          ...old,
          { ...sourceRow('repeat', 'new-user'), timestamp: 4100 },
          { ...boundary, id: 'new-answer', timestamp: 4200 }
        ]
      }
    })
    expect(mounted.result.current.pending).toEqual([])
  }
)

it('assigns identical legacy occurrences at the real capability fallback and never double-charges a spent row', () => {
  const first = mountOwned()
  let one = '',
    two = ''
  act(() => {
    one = first.result.current.record('repeat', undefined, false, 'opencode')
    two = first.result.current.record('repeat', undefined, false, 'opencode')
    first.result.current.setSourceEvidence(one, false)
    first.result.current.setSourceEvidence(two, false)
    first.result.current.setSourceEvidence(two, false)
  })
  const messages = [sourceRow('repeat', 'x'), { ...boundary, id: 'answer' }]
  first.rerender({ messages })
  expect(first.result.current.pending.map((entry) => entry.id)).toEqual([two])
  first.rerender({ messages: [...messages] })
  expect(first.result.current.pending.map((entry) => entry.id)).toEqual([two])
  first.unmount()
  const remounted = mountOwned(messages)
  expect(remounted.result.current.pending.map((entry) => entry.id)).toEqual([two])
  remounted.rerender({
    messages: [...messages, sourceRow('repeat', 'y'), { ...boundary, id: 'answer-y' }]
  })
  expect(remounted.result.current.pending).toEqual([])
})

it.each([false, true])(
  'transfers spent ownership to reachable fallback legacy proof, image member: %s',
  (image) => {
    const first = mountOwned()
    let source = '',
      attachment = '',
      one = '',
      two = ''
    act(() => {
      source = first.result.current.record('first second', undefined, false, 'opencode')
      first.result.current.setSourceEvidence(source, true)
      if (image) {
        attachment = first.result.current.record('first second', ['/tmp/image.png'], false)
      }
      one = first.result.current.record('first', undefined, false, 'opencode')
      two = first.result.current.record('second', undefined, false, 'opencode')
    })
    const x = sourceRow('first second', 'x')
    first.rerender({ messages: [x] })
    act(() => {
      first.result.current.setSourceEvidence(one, false)
      first.result.current.setSourceEvidence(two, false)
    })
    const messages = [x, { ...boundary, id: 'answer' }]
    first.rerender({ messages })
    expect(first.result.current.pending.map((entry) => entry.id)).toEqual(
      image ? [attachment, one, two] : [one, two]
    )
    first.unmount()
    const remounted = mountOwned(messages)
    expect(remounted.result.current.pending.map((entry) => entry.id)).toEqual(
      image ? [attachment, one, two] : [one, two]
    )
    remounted.rerender({
      messages: [...messages, sourceRow('first second', 'y'), { ...boundary, id: 'answer-y' }]
    })
    expect(remounted.result.current.pending).toEqual([])
  }
)

it('releases dead fallback group dependencies and does not accumulate receipts behind an incompatible draft', () => {
  const mounted = mountOwned()
  let one = '',
    two = ''
  act(() => {
    mounted.result.current.record('first second', undefined, false, 'opencode')
    one = mounted.result.current.record('first', undefined, false, 'opencode')
    two = mounted.result.current.record('second', undefined, false, 'opencode')
  })
  mounted.rerender({ messages: [sourceRow('first second', 'x'), { ...boundary, id: 'answer' }] })
  expect(mounted.result.current.pending.some((entry) => entry.receiptDependencies?.length)).toBe(
    true
  )
  act(() => mounted.result.current.cancel(two, true))
  expect(mounted.result.current.pending[0].receiptDependencies).toBeUndefined()
  act(() => mounted.result.current.finishSourceEvidence(one))
  for (let index = 0; index < 20; index++) {
    act(() => {
      const id = mounted.result.current.record(`later-${index}`, undefined, false, 'opencode')
      mounted.result.current.setSourceEvidence(id, true)
    })
    mounted.rerender({
      messages: [sourceRow(`later-${index}`, `u${index}`), { ...boundary, id: `a${index}` }]
    })
  }
  expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([one])
  expect(mounted.result.current.pending[0].receiptDependencies).toBeUndefined()
  act(() => mounted.result.current.reject(one))
  act(() => mounted.result.current.record('first', undefined, false, 'opencode'))
  expect(mounted.result.current.pending).toHaveLength(1)
  expect(mounted.result.current.pending[0].id).not.toBe(one)
})

it('keeps a committed source lock through a late real fallback and prevents legacy continuation reuse', () => {
  const mounted = mountOwned()
  let owner = '',
    continuation = ''
  act(() => {
    owner = mounted.result.current.record('first second', undefined, false, 'opencode')
    continuation = mounted.result.current.record('first\\', undefined, false, 'opencode')
  })
  const x = sourceRow('first second', 'x')
  mounted.rerender({ messages: [x] })
  act(() => {
    mounted.result.current.setSourceEvidence(owner, false)
    mounted.result.current.setSourceEvidence(continuation, false)
  })
  mounted.rerender({ messages: [x, { ...boundary, id: 'answer' }] })
  expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([continuation])
  mounted.rerender({ messages: [x, { ...boundary, id: 'answer' }] })
  expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([continuation])
  mounted.rerender({
    messages: [
      x,
      { ...boundary, id: 'answer' },
      sourceRow('first next', 'y'),
      { ...boundary, id: 'answer-y' }
    ]
  })
  expect(mounted.result.current.pending).toEqual([])
})

it.each([false, true])(
  'records a new loading-session Send without another session frontier, empty namespace first: %s',
  (emptyFirst) => {
    vi.setSystemTime(3000)
    type Session = Parameters<typeof useNativeChatPendingDelivery>[0]['session']
    const initial: Session = {
      messages: [{ ...boundary, id: 'a-answer', timestamp: 1000, transcriptOrder: 9 }],
      readPhase: 'ready',
      sessionId: 'A'
    }
    const mounted = renderHook(
      ({ session }) => useNativeChatPendingDelivery({ ...args, agent: 'opencode', session }),
      { initialProps: { session: initial } }
    )
    if (emptyFirst) {
      mounted.rerender({ session: { messages: [], readPhase: 'ready', sessionId: 'B' } })
    }
    mounted.rerender({ session: { messages: [], readPhase: 'loading', sessionId: 'B' } })
    let id = ''
    act(() => {
      id = mounted.result.current.record('repeat', undefined, false, 'opencode')
    })
    const old = [
      { ...sourceRow('repeat', 'b-old'), timestamp: 2000, transcriptOrder: 1 },
      { ...boundary, id: 'b-old-answer', timestamp: 2500, transcriptOrder: 2 }
    ]
    mounted.rerender({ session: { messages: old, readPhase: 'ready', sessionId: 'B' } })
    expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([id])
    mounted.rerender({
      session: {
        messages: [
          ...old,
          { ...sourceRow('repeat', 'b-new'), timestamp: 3100, transcriptOrder: 3 },
          { ...boundary, id: 'b-new-answer', timestamp: 3200, transcriptOrder: 4 }
        ],
        readPhase: 'ready',
        sessionId: 'B'
      }
    })
    expect(mounted.result.current.pending).toEqual([])
  }
)

it.each(['repeat', 'repeat '])(
  'replaces failed legacy %j before assigning the resend occurrence',
  (failedText) => {
    const mounted = mountOwned()
    let rejected = '',
      replacement = ''
    act(() => {
      rejected = mounted.result.current.record(failedText, undefined, false, 'opencode')
      mounted.result.current.setSourceEvidence(rejected, false)
      mounted.result.current.reject(rejected)
    })
    act(() => {
      replacement = mounted.result.current.record('repeat', undefined, false, 'opencode')
      mounted.result.current.setSourceEvidence(replacement, false)
    })
    expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([replacement])
    mounted.rerender({ messages: [sourceRow('repeat', 'new'), { ...boundary, id: 'answer' }] })
    expect(mounted.result.current.pending).toEqual([])
  }
)

it.each([false, true])(
  'reconciles an idle source-before-result send after remount=%s with the earlier composer listener',
  async (remount) => {
    const completion = Promise.withResolvers<'submitted'>()
    let mounted = mountOwned()
    let id = ''
    act(() => {
      id = mounted.result.current.record('repeat', undefined, false, 'opencode', completion.promise)
      const finish = mounted.result.current.finishDispatch
      void completion.promise.then((outcome) => finish(id, completion.promise, outcome))
    })
    if (remount) {
      mounted.unmount()
      mounted = mountOwned()
    }
    mounted.rerender({
      messages: [boundary, sourceRow('repeat', 'receipt'), { ...boundary, id: 'reply' }]
    })
    expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([id])
    await act(async () => {
      completion.resolve('submitted')
      await completion.promise
    })
    expect(mounted.result.current.pending).toEqual([])
  }
)

it('keeps the raw original when a source row precedes a definite refusal and cannot settle another scope', async () => {
  const completion = Promise.withResolvers<'not-submitted'>()
  const mounted = mountOwned()
  let id = ''
  act(() => {
    id = mounted.result.current.record('repeat ', undefined, false, 'opencode', completion.promise)
    const finish = mounted.result.current.finishDispatch
    void completion.promise.then((outcome) => finish(id, completion.promise, outcome))
  })
  mounted.rerender({
    messages: [boundary, sourceRow('repeat ', 'receipt'), { ...boundary, id: 'reply' }]
  })
  await act(async () => {
    completion.resolve('not-submitted')
    await completion.promise
  })
  expect(
    mounted.result.current.pending.map((entry) => [entry.id, entry.text, entry.delivery])
  ).toEqual([[id, 'repeat ', 'rejected']])
})

it('keeps a spent normalized row unavailable through source selection and actual-socket legacy fallback', async () => {
  const mounted = mountOwned()
  const completion = Promise.withResolvers<'submitted'>()
  let first = '',
    second = ''
  act(() => {
    first = mounted.result.current.record('a b', undefined, false, 'opencode')
    second = mounted.result.current.record('a  b', undefined, false, 'opencode', completion.promise)
    mounted.result.current.setSourceEvidence(first, true)
    mounted.result.current.setSourceEvidence(second, true)
  })
  const spent = [boundary, sourceRow('a b', 'spent'), { ...boundary, id: 'spent-answer' }]
  mounted.rerender({ messages: spent })
  expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([second])
  act(() => mounted.result.current.setSourceEvidence(second, false))
  await act(async () => {
    completion.resolve('submitted')
    await completion.promise
  })
  mounted.rerender({ messages: [...spent] })
  expect(
    mounted.result.current.pending.map((entry) => [
      entry.id,
      entry.text,
      entry.sourceAgent,
      entry.dispatchPending
    ])
  ).toEqual([[second, 'a  b', undefined, undefined]])
  mounted.rerender({ messages: [...spent, userRow('a b'), { ...boundary, id: 'legacy-answer' }] })
  expect(mounted.result.current.pending).toEqual([])
})

it.each(['submitted', 'uncertain'] as const)(
  'keeps actual %s disposition distinct while a ready source delays its receipt',
  async (outcome) => {
    const mounted = mountOwned()
    const completion = Promise.withResolvers<typeof outcome>()
    let id = ''
    act(() => {
      id = mounted.result.current.record(
        'delayed',
        undefined,
        false,
        'opencode',
        completion.promise
      )
      mounted.result.current.setSourceEvidence(id, true)
    })
    await act(async () => {
      completion.resolve(outcome)
      await completion.promise
    })
    act(() => vi.advanceTimersByTime(20001))
    expect(
      mounted.result.current.pending.map((entry) => [entry.id, entry.text, entry.delivery])
    ).toEqual([[id, 'delayed', outcome === 'submitted' ? undefined : 'unconfirmed']])
    mounted.rerender({
      messages: [
        boundary,
        sourceRow('delayed', 'actual-receipt'),
        { ...boundary, id: 'actual-answer' }
      ]
    })
    expect(mounted.result.current.pending).toEqual([])
  }
)

it('starts actual uncertainty after the original composer callback and preserves its deadline through updates and remount', async () => {
  const completion = Promise.withResolvers<'uncertain'>()
  let mounted = mountOwned()
  let id = ''
  act(() => {
    id = mounted.result.current.record('waiting', undefined, false, 'opencode', completion.promise)
    const finish = mounted.result.current.finishDispatch
    void completion.promise.then((outcome) => finish(id, completion.promise, outcome))
  })
  mounted.unmount()
  mounted = mountOwned()
  await act(async () => {
    completion.resolve('uncertain')
    await completion.promise
  })
  act(() => vi.advanceTimersByTime(10000))
  mounted.rerender({ messages: [boundary] })
  act(() => mounted.result.current.record('other', undefined, false, 'opencode'))
  mounted.unmount()
  mounted = mountOwned()
  act(() => vi.advanceTimersByTime(10001))
  expect(mounted.result.current.pending.map((entry) => [entry.text, entry.delivery])).toEqual([
    ['waiting', 'unconfirmed'],
    ['other', undefined]
  ])
  mounted.rerender({
    messages: [boundary, sourceRow('waiting', 'receipt'), { ...boundary, id: 'answer' }]
  })
  expect(mounted.result.current.pending.map((entry) => entry.text)).toEqual(['other'])
})

it('settles an empty uncached not-ready owner without publishing observation work', () => {
  const write = vi.spyOn(pendingOwner, 'writePendingSendCache')
  const messages: NativeChatMessage[] = []
  const mounted = renderHook(() =>
    useNativeChatPendingDelivery({
      paneKey: 'uncached',
      agent: 'opencode',
      session: { messages, readPhase: 'loading', sessionId: null }
    })
  )
  mounted.rerender()
  act(() => vi.advanceTimersByTime(20001))
  expect(mounted.result.current.pending).toEqual([])
  expect(write).not.toHaveBeenCalled()
})
