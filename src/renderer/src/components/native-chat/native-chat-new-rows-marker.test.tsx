// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import {
  nativeChatNewRowsMarkerPlacement,
  useNativeChatNewRowsMarker
} from './native-chat-new-rows-marker'

const at = (sequence: number) => ({ sequence, index: 0 })

/** A row the journal placed at `sequence`; null for one it has not (a terminal-backed chat's). */
function row(
  id: string,
  sequence: number | null,
  role: NativeChatMessage['role'] = 'assistant',
  text = id
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript',
    ...(sequence === null ? {} : { journalPosition: at(sequence) })
  }
}

/** The rows as one turn: still `working`, or settled after `worked` seconds, or neither. */
type Turn = { working?: boolean; worked?: number; expanded?: boolean }

function slotsOf(
  messages: NativeChatMessage[],
  { working = false, worked, expanded = false }: Turn = {}
) {
  const turnKey = working || worked !== undefined ? 'prompt' : undefined
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => turnKey),
    liveTurnKey: working ? turnKey : undefined,
    receipts: new Map(),
    turnStatuses: {
      active: null,
      completedByTurn:
        worked === undefined
          ? {}
          : { prompt: { startedAt: null, thinking: false, workedSeconds: worked } }
    },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(expanded && turnKey ? [turnKey] : []),
    isWorking: working,
    lifecycleWorking: working
  })
}

const SEEN = [row('prompt', 1, 'user'), row('reply', 2)]
const LATER = [...SEEN, row('answer', 3), row('more', 4)]
/** The reader asks, then the agent works a step and answers. */
const ASKED = [row('prompt', 1, 'user')]
const DONE = [...ASKED, row('step', 2), row('answer', 3)]

const missed = (key: string, after: number, through: number) => ({
  key,
  after: at(after),
  through: at(through)
})

describe('where the "New" marker draws', () => {
  it('is above the first row that came while the reader was away', () => {
    expect(nativeChatNewRowsMarkerPlacement(slotsOf(LATER), missed('answer', 2, 4))).toEqual({
      key: 'answer',
      place: 'above-row'
    })
  })

  // The bar's own line would otherwise sit against the marker's.
  it("is above the turn bar when only that bar parts the row from the reader's prompt", () => {
    const asked = [row('prompt', 1, 'user'), row('answer', 2)]
    expect(
      nativeChatNewRowsMarkerPlacement(slotsOf(asked, { worked: 17 }), missed('answer', 1, 2))
    ).toEqual({ key: 'prompt', place: 'above-turn-bar' })
  })

  it('stays under the rows of an opened turn the reader had already seen', () => {
    expect(
      nativeChatNewRowsMarkerPlacement(
        slotsOf(DONE, { worked: 17, expanded: true }),
        missed('answer', 2, 3)
      )
    ).toEqual({ key: 'answer', place: 'above-row' })
  })

  // With no prompt of the reader's, the turn's bar draws above its first row, folded or not.
  it('is above the bar of a turn the agent opened, whether the turn is open or shut', () => {
    const turn = DONE.slice(1)
    for (const expanded of [false, true]) {
      expect(
        nativeChatNewRowsMarkerPlacement(
          slotsOf(turn, { worked: 17, expanded }),
          missed('answer', 1, 3)
        )
      ).toEqual({ key: 'step', place: 'above-row' })
    }
  })

  it('is absent when nothing came, or the row that did is gone', () => {
    expect(nativeChatNewRowsMarkerPlacement(slotsOf(LATER), null)).toBeUndefined()
    expect(nativeChatNewRowsMarkerPlacement(slotsOf(SEEN), missed('answer', 2, 4))).toBeUndefined()
  })
})

describe('useNativeChatNewRowsMarker', () => {
  let hasFocus: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })
  afterEach(() => hasFocus.mockRestore())

  type ChatProps = {
    messages: NativeChatMessage[]
    showing: boolean
    waiting?: NativeChatMessage[]
    turn?: Turn
  }

  function chat(messages: NativeChatMessage[], turn?: Turn) {
    const initialProps: ChatProps = { messages, showing: true }
    return renderHook(
      (props: ChatProps) =>
        useNativeChatNewRowsMarker(
          slotsOf(props.messages, props.turn ?? turn),
          slotsOf(props.waiting ?? []),
          props.showing
        ),
      { initialProps }
    )
  }

  /** The reader goes to another tab, the chat becomes `onReturn`, and they come back. */
  function leaveAndReturn(left: NativeChatMessage[], onReturn: NativeChatMessage[], turn?: Turn) {
    const view = chat(left, turn)
    view.rerender({ messages: left, showing: false })
    view.rerender({ messages: onReturn, showing: true })
    return view
  }

  it('marks nothing that arrives while the reader is looking', () => {
    const view = chat(SEEN)
    view.rerender({ messages: LATER, showing: true })
    expect(view.result.current.marker).toBeUndefined()
  })

  it('marks what a hidden chat is handed when the reader comes back to it', () => {
    expect(leaveAndReturn(SEEN, LATER).result.current.marker?.key).toBe('answer')
  })

  it("is never above the reader's own prompt", () => {
    const sent = [...SEEN, row('next-prompt', 3, 'user'), row('answer', 4)]
    expect(leaveAndReturn(SEEN, sent).result.current.marker?.key).toBe('answer')
  })

  it('marks nothing the reader watches arrive after missing nothing', () => {
    const view = leaveAndReturn(SEEN, SEEN)
    view.rerender({ messages: LATER, showing: true })
    expect(view.result.current.marker).toBeUndefined()
  })

  it('marks what came while the window was in the background', () => {
    const view = chat(SEEN)
    hasFocus.mockReturnValue(false)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    view.rerender({ messages: LATER, showing: true })
    hasFocus.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(view.result.current.marker?.key).toBe('answer')
  })

  it('goes once the reader answers', () => {
    const view = leaveAndReturn(SEEN, LATER)
    act(() => view.result.current.dismiss())
    expect(view.result.current.marker).toBeUndefined()
  })

  it('does not appear when the reader answered before the chat had caught up', () => {
    const view = chat(SEEN)
    view.rerender({ messages: SEEN, showing: false })
    act(() => view.result.current.dismiss())
    view.rerender({ messages: LATER, showing: true })
    expect(view.result.current.marker).toBeUndefined()
  })

  // The reader left before the journal had placed the prompt they had just sent.
  it('marks the first reply to a chat that held no row the journal had placed', () => {
    const sending = [row('prompt', null, 'user')]
    const view = leaveAndReturn(sending, [row('prompt', 1, 'user'), row('answer', 2)])
    expect(view.result.current.marker?.key).toBe('answer')
  })

  it('is arriving on the return, until the row that draws it has brought it into view', () => {
    const view = leaveAndReturn(SEEN, LATER)
    expect(view.result.current.marker?.arriving).toBe(true)
    act(() => view.result.current.marker?.onArrived())
    expect(view.result.current.marker).toMatchObject({ key: 'answer', arriving: false })
  })

  // The reader may be midway through what it marks: a glance at another tab must not move it.
  it('stays where it is through another look away, until the reader answers', () => {
    const view = leaveAndReturn(SEEN, LATER)
    act(() => view.result.current.marker?.onArrived())

    view.rerender({ messages: LATER, showing: false })
    expect(view.result.current.marker?.key).toBe('answer')

    view.rerender({ messages: [...LATER, row('newer', 5)], showing: true })
    expect(view.result.current.marker).toMatchObject({ key: 'answer', arriving: false })
  })

  it('marks the next time away afresh once the reader has answered', () => {
    const view = leaveAndReturn(SEEN, LATER)
    act(() => view.result.current.dismiss())

    view.rerender({ messages: LATER, showing: false })
    view.rerender({ messages: [...LATER, row('newer', 5)], showing: true })
    expect(view.result.current.marker).toMatchObject({ key: 'newer', arriving: true })
  })

  it('marks the next time away afresh when the row it marked has gone', () => {
    const view = leaveAndReturn(SEEN, LATER)
    view.rerender({ messages: SEEN, showing: true })
    expect(view.result.current.marker).toBeUndefined()

    view.rerender({ messages: SEEN, showing: false })
    view.rerender({ messages: [...SEEN, row('newer', 5)], showing: true })
    expect(view.result.current.marker?.key).toBe('newer')
  })

  // Another agent's message waits behind the running turn, drawn outside the transcript's rows.
  it('marks a message that was held behind the running turn once it joins the transcript', () => {
    const view = chat(SEEN)
    view.rerender({ messages: SEEN, showing: false })
    view.rerender({ messages: SEEN, showing: true, waiting: [row('held', 3)] })
    expect(view.result.current.marker).toBeUndefined()

    // The turn writes on in front of the reader, then the handover places the message after that.
    view.rerender({ messages: [...SEEN, row('live', 4)], showing: true, waiting: [row('held', 3)] })
    expect(view.result.current.marker).toBeUndefined()
    view.rerender({ messages: [...SEEN, row('live', 4), row('held', 5)], showing: true })
    expect(view.result.current.marker?.key).toBe('held')
  })

  // Queued behind an ordinary turn, it draws after everything the agent goes on to write.
  it('stays above a queued message while the turn writes on ahead of it', () => {
    const queued: NativeChatMessage = { ...row('held', 3), queued: true }
    const view = leaveAndReturn(SEEN, [...SEEN, queued])
    expect(view.result.current.marker?.key).toBe('held')

    view.rerender({ messages: [...SEEN, row('live', 4), queued], showing: true })
    expect(view.result.current.marker?.key).toBe('held')
  })

  it('keeps its place when the reader opens the turn that came while they were away', () => {
    const view = leaveAndReturn(ASKED, DONE, { worked: 17 })
    expect(view.result.current.marker).toMatchObject({ key: 'prompt', place: 'above-turn-bar' })

    view.rerender({ messages: DONE, showing: true, turn: { worked: 17, expanded: true } })
    expect(view.result.current.marker).toMatchObject({ key: 'prompt', place: 'above-turn-bar' })
  })

  it('stays through another look away after the reader shuts the turn they opened', () => {
    const shut = { worked: 17 }
    const view = leaveAndReturn(ASKED, DONE, { worked: 17, expanded: true })
    view.rerender({ messages: DONE, showing: true, turn: shut })
    view.rerender({ messages: DONE, showing: false, turn: shut })
    view.rerender({ messages: DONE, showing: true, turn: shut })
    expect(view.result.current.marker).toMatchObject({ key: 'prompt', place: 'above-turn-bar' })
  })

  describe('a reply still being written when the reader left', () => {
    const begun = [row('prompt', 1, 'user'), row('reply', 2, 'assistant', 'The plan')]
    const grown = [row('prompt', 1, 'user'), row('reply', 2, 'assistant', 'The plan has parts.')]
    const marked = (onReturn: NativeChatMessage[]) =>
      leaveAndReturn(begun, onReturn, { working: true }).result.current.marker?.key

    it('is marked new when it grew while they were away', () => {
      expect(marked(grown)).toBe('reply')
    })

    it('is not marked when it is as they left it', () => {
      expect(marked(begun)).toBeUndefined()
    })

    it('gives way to the next row when it is as they left it', () => {
      expect(marked([...begun, row('more', 3)])).toBe('more')
    })

    it('is marked new when it grew with no row placed before it', () => {
      const alone = [row('reply', 2, 'assistant', 'The plan')]
      const grownAlone = [row('reply', 2, 'assistant', 'The plan has parts.')]
      const view = leaveAndReturn(alone, grownAlone, { working: true })
      expect(view.result.current.marker?.key).toBe('reply')
    })

    describe('with a follow-up delivered into the turn after it', () => {
      const followUp = row('follow-up', 3, 'user')
      const marked = (onReturn: NativeChatMessage[]) =>
        leaveAndReturn([...begun, followUp], onReturn, { working: true }).result.current.marker?.key

      it('is still marked new when it grew', () => {
        expect(marked([...grown, followUp])).toBe('reply')
      })

      it('gives way to what answers the follow-up when it is as they left it', () => {
        expect(marked([...begun, followUp, row('answer', 4)])).toBe('answer')
      })

      it('marks nothing when nothing changed', () => {
        expect(marked([...begun, followUp])).toBeUndefined()
      })
    })

    describe('with a message held behind the turn, placed after it', () => {
      const markedWith = (held: NativeChatMessage, onReturn: NativeChatMessage[]) => {
        const view = chat(begun, { working: true })
        view.rerender({ messages: begun, showing: true, waiting: [held] })
        view.rerender({ messages: begun, showing: false, waiting: [held] })
        view.rerender({ messages: onReturn, showing: true, waiting: [held] })
        return view.result.current.marker?.key
      }

      it('is still marked new when it grew', () => {
        expect(markedWith(row('held', 3, 'user'), grown)).toBe('reply')
      })

      it('marks nothing when neither it nor the held message changed', () => {
        const fromAgent: NativeChatMessage = {
          ...row('held', 3, 'user'),
          from: {
            kind: 'agent',
            senders: [
              {
                party: { address: 'term_peer', terminalHandle: 'term_peer', orcaSessionId: null },
                name: 'Claude'
              }
            ],
            orchestration: null
          }
        }
        // Seen while it waited, it is not news once the turn ends and it joins the transcript.
        expect(markedWith(fromAgent, [...begun, fromAgent])).toBeUndefined()
      })
    })
  })

  it('marks nothing in a chat read from a terminal, whose rows the journal never placed', () => {
    const view = leaveAndReturn([row('a', null)], [row('a', null), row('b', null)])
    expect(view.result.current.marker).toBeUndefined()
  })
})
