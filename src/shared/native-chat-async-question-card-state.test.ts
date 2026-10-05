import { describe, expect, it, vi } from 'vitest'
import { nativeChatAsyncAnswerProgress } from './native-chat-async-answer-progress'
import {
  createNativeChatAsyncQuestionCardState,
  nativeChatAsyncQuestionScopeView,
  reduceNativeChatAsyncQuestionCard,
  submitNativeChatAsyncQuestionScope,
  type NativeChatAsyncAnswerSeam,
  type NativeChatAsyncQuestionCardAction,
  type NativeChatAsyncQuestionCardState
} from './native-chat-async-question-card-state'
import type { NativeChatAsyncAnswerOutcome } from './native-chat-async-question-answers'
import type { NativeChatAsyncQuestionsView } from './native-chat-async-questions'

const ready = (...keys: string[]): NativeChatAsyncQuestionsView => ({
  state: 'ready',
  questions: keys.map((key, index) => ({ key, index, title: `${key}?`, options: ['Red'] }))
})

const nativeChatAsyncQuestionCardView = (state: NativeChatAsyncQuestionCardState) =>
  nativeChatAsyncQuestionScopeView(state, state.view)

function submitNativeChatAsyncQuestionCard(
  state: NativeChatAsyncQuestionCardState,
  dispatch: (action: NativeChatAsyncQuestionCardAction) => void,
  send: NativeChatAsyncAnswerSeam
): void {
  submitNativeChatAsyncQuestionScope(
    { scopeKey: state.scopeKey, ...nativeChatAsyncQuestionCardView(state) },
    dispatch,
    send
  )
}

function run(
  state: NativeChatAsyncQuestionCardState,
  ...actions: NativeChatAsyncQuestionCardAction[]
): NativeChatAsyncQuestionCardState {
  return actions.reduce(reduceNativeChatAsyncQuestionCard, state)
}

async function submit(
  state: NativeChatAsyncQuestionCardState,
  outcome: NativeChatAsyncAnswerOutcome
): Promise<{ actions: NativeChatAsyncQuestionCardAction[]; text: string }> {
  const actions: NativeChatAsyncQuestionCardAction[] = []
  const send = vi.fn(async (_text: string) => outcome)
  submitNativeChatAsyncQuestionCard(state, (action) => actions.push(action), send)
  await Promise.resolve()
  await Promise.resolve()
  return { actions, text: send.mock.calls[0]?.[0] ?? '' }
}

describe('async question card state', () => {
  it('keeps each conversation’s edits and dismissals across a switch away and back', () => {
    const view = ready('a', 'b')
    const tab1 = run(
      createNativeChatAsyncQuestionCardState('tab-1', view),
      { type: 'edit', key: 'a', edit: { text: 'blue' } },
      { type: 'dismiss', key: 'b' }
    )
    const tab2 = run(tab1, { type: 'observe', scopeKey: 'tab-2', view: ready('c') })
    expect(tab2.edits).toEqual({})
    const back = run(tab2, { type: 'observe', scopeKey: 'tab-1', view })
    expect(back.edits).toEqual({ a: { text: 'blue' } })
    expect(back.dismissed).toEqual({ b: true })
  })

  it('settles a send that finishes while the user is in another conversation', async () => {
    const view = ready('a')
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', view), {
      type: 'edit',
      key: 'a',
      edit: { text: 'blue' }
    })
    const { actions } = await submit(edited, 'accepted')
    const [sending, settled] = actions
    if (!sending || !settled) {
      throw new Error('expected sending and settled actions')
    }
    const away = run(edited, sending, { type: 'observe', scopeKey: 'tab-2', view: ready() })
    const back = run(away, settled, { type: 'observe', scopeKey: 'tab-1', view })
    expect(back.sending).toBe(false)
    expect(back.edits).toEqual({})
  })

  it('keeps Send disabled after switching back while the answer is still in flight', async () => {
    const view = ready('a')
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', view), {
      type: 'edit',
      key: 'a',
      edit: { option: 'Red' }
    })
    const { actions } = await submit(edited, 'accepted')
    const back = run(
      edited,
      actions[0]!,
      { type: 'observe', scopeKey: 'tab-2', view: ready() },
      { type: 'observe', scopeKey: 'tab-1', view }
    )
    expect(nativeChatAsyncQuestionCardView(back).canSend).toBe(false)
  })

  it('restores the sent answers when the send is withdrawn before dispatch', async () => {
    const view = ready('a')
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', view), {
      type: 'edit',
      key: 'a',
      edit: { option: 'Red' }
    })
    const { actions, text } = await submit(edited, 'withdrawn')
    expect(text).toBe('Question: a?\nAnswer: Red')
    const inFlight = run(edited, actions[0]!)
    const restored = run({ ...inFlight, edits: {} }, actions[1]!)
    expect(restored.sending).toBe(false)
    expect(restored.edits).toEqual({ a: { option: 'Red' } })
  })

  it('keeps edits on rejected and unknown, clears them on queued', async () => {
    const view = ready('a')
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', view), {
      type: 'edit',
      key: 'a',
      edit: { text: 'blue' }
    })
    for (const outcome of ['rejected', 'unknown'] as const) {
      const { actions } = await submit(edited, outcome)
      expect(run(edited, ...actions).edits).toEqual({ a: { text: 'blue' } })
    }
    const { actions } = await submit(edited, 'queued')
    expect(run(edited, ...actions).edits).toEqual({})
  })

  it('prunes per-key state only on an authoritative set', () => {
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', ready('a')), {
      type: 'edit',
      key: 'a',
      edit: { text: 'blue' }
    })
    const pending = run(edited, { type: 'observe', scopeKey: 'tab-1', view: { state: 'pending' } })
    expect(pending.edits).toEqual({ a: { text: 'blue' } })
    expect(run(pending, { type: 'observe', scopeKey: 'tab-1', view: ready() }).edits).toEqual({})
  })
})

describe('a delivered answer a transport record holds', () => {
  const settledHeld = (
    receipt: string,
    answers: Record<string, string>
  ): NativeChatAsyncQuestionCardAction => ({
    type: 'settled',
    scopeKey: 'tab-1',
    outcome: 'accepted',
    sent: Object.fromEntries(Object.entries(answers).map(([key, text]) => [key, { text }])),
    held: { receipt, answers }
  })

  it('moves the sent answers from the edits to the record that holds them', () => {
    const state = run(
      createNativeChatAsyncQuestionCardState('tab-1', ready('a')),
      { type: 'edit', key: 'a', edit: { text: 'blue' } },
      { type: 'sending' },
      settledHeld('m1', { a: 'blue' })
    )
    expect(state.edits).toEqual({})
    expect(state.sending).toBe(false)
    expect(state.sent).toEqual([{ receipt: 'm1', answers: { a: 'blue' } }])
  })

  it('lets the newest send of a question decide it, so an older one never gives back over it', () => {
    const state = run(
      createNativeChatAsyncQuestionCardState('tab-1', ready('a', 'b')),
      settledHeld('m1', { a: 'blue', b: 'red' }),
      settledHeld('m2', { a: 'green' })
    )
    expect(state.sent).toEqual([
      { receipt: 'm1', answers: { b: 'red' } },
      { receipt: 'm2', answers: { a: 'green' } }
    ])
  })

  it('drops an entry when the host set drops its questions, or when its send is forgotten', () => {
    const held = run(
      createNativeChatAsyncQuestionCardState('tab-1', ready('a', 'b')),
      settledHeld('m1', { a: 'blue' }),
      settledHeld('m2', { b: 'red' })
    )
    expect(run(held, { type: 'observe', scopeKey: 'tab-1', view: ready('b') }).sent).toEqual([
      { receipt: 'm2', answers: { b: 'red' } }
    ])
    expect(run(held, { type: 'forget', receipts: new Set(['m2']) }).sent).toEqual([
      { receipt: 'm1', answers: { a: 'blue' } }
    ])
    // Nothing to forget leaves the state as it was.
    expect(run(held, { type: 'forget', receipts: new Set(['m9']) })).toBe(held)
  })

  it('reads progress oldest first: a holding record covers its keys, a failed one gives them back', () => {
    const progress = nativeChatAsyncAnswerProgress([
      { answers: { a: 'blue', b: 'red' }, holding: true },
      { answers: { a: 'green' }, holding: false }
    ])
    expect(progress.answers).toEqual({ a: 'green', b: 'red' })
    expect([...progress.sendingKeys]).toEqual(['b'])
  })

  it('holds only the questions its answer covers: a later question stays answerable on its own', async () => {
    const state = run(
      createNativeChatAsyncQuestionCardState('tab-1', ready('b', 'c')),
      { type: 'edit', key: 'b', edit: { text: 'stale' } },
      { type: 'edit', key: 'c', edit: { option: 'Red' } }
    )
    const progress = nativeChatAsyncAnswerProgress([{ answers: { b: '80' }, holding: true }])
    const card = nativeChatAsyncQuestionScopeView(state, state.view, progress)
    expect([...card.held]).toEqual(['b'])
    // The held question shows what it sent; the hold is not this card's write in flight.
    expect(card.edits.b).toEqual({ text: '80' })
    expect(card.sending).toBe(false)
    expect(card.canSend).toBe(true)
    const send = vi.fn(
      async (_text: string, _answers: Record<string, string>) => 'accepted' as const
    )
    submitNativeChatAsyncQuestionScope({ scopeKey: 'tab-1', ...card }, () => {}, send)
    expect(send).toHaveBeenCalledWith('Question: c?\nAnswer: Red', { c: 'Red' })
    // With only held questions open there is nothing to send, and nothing reads as sending.
    const onlyHeld = nativeChatAsyncQuestionScopeView(
      run(state, { type: 'dismiss', key: 'c' }),
      state.view,
      progress
    )
    expect([onlyHeld.canSend, onlyHeld.sending]).toEqual([false, false])
  })

  it('submits through a seam that names the record holding a delivered answer', async () => {
    const state = run(createNativeChatAsyncQuestionCardState('tab-1', ready('a')), {
      type: 'edit',
      key: 'a',
      edit: { option: 'Red' }
    })
    const actions: NativeChatAsyncQuestionCardAction[] = []
    submitNativeChatAsyncQuestionCard(
      state,
      (action) => actions.push(action),
      async () => ({ outcome: 'accepted', receipt: 'm1' })
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(run(state, ...actions).sent).toEqual([{ receipt: 'm1', answers: { a: 'Red' } }])
  })
})
