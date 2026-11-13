// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscriptSlots } from '../../conversation/slots/native-chat-transcript-slots'
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
const ASKED = [row('prompt', 1, 'user')]
const DONE = [...ASKED, row('step', 2), row('answer', 3)]

const missed = (key: string, after: number, through: number) => ({
  key,
  after: at(after),
  through: at(through)
})

describe('where the "New" marker draws', () => {
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

  function leaveAndReturn(left: NativeChatMessage[], onReturn: NativeChatMessage[], turn?: Turn) {
    const view = chat(left, turn)
    view.rerender({ messages: left, showing: false })
    view.rerender({ messages: onReturn, showing: true })
    return view
  }

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

  it('does not appear when the reader answered before the chat had caught up', () => {
    const view = chat(SEEN)
    view.rerender({ messages: SEEN, showing: false })
    act(() => view.result.current.dismiss())
    view.rerender({ messages: LATER, showing: true })
    expect(view.result.current.marker).toBeUndefined()
  })

  it('marks the first reply to a chat that held no row the journal had placed', () => {
    const sending = [row('prompt', null, 'user')]
    const view = leaveAndReturn(sending, [row('prompt', 1, 'user'), row('answer', 2)])
    expect(view.result.current.marker?.key).toBe('answer')
  })

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

  it('stays above a queued message while the turn writes on ahead of it', () => {
    const queued: NativeChatMessage = { ...row('held', 3), queued: true }
    const view = leaveAndReturn(SEEN, [...SEEN, queued])
    expect(view.result.current.marker?.key).toBe('held')

    view.rerender({ messages: [...SEEN, row('live', 4), queued], showing: true })
    expect(view.result.current.marker?.key).toBe('held')
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

  describe('whether it draws a line', () => {
    const fromAgent = (id: string, sequence: number): NativeChatMessage => ({
      ...row(id, sequence, 'user'),
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
    })

    it('weighs by height a short reply under the prompt the reader just sent', () => {
      const sent = [...SEEN, row('next-prompt', 3, 'user')]
      const view = leaveAndReturn(sent, [...sent, row('answer', 4)])
      expect(view.result.current.marker).toMatchObject({ key: 'answer', look: 'measure' })
    })

    it('draws when another agent posted', () => {
      const view = leaveAndReturn(SEEN, [...SEEN, fromAgent('peer', 3), row('answer', 4)])
      expect(view.result.current.marker).toMatchObject({ key: 'peer', look: 'line' })
    })

    it('draws when a queued send was handed over', () => {
      const queued: NativeChatMessage = { ...row('held', 3, 'user'), queued: true }
      const view = chat(SEEN)
      view.rerender({ messages: SEEN, showing: true, waiting: [queued] })
      view.rerender({ messages: SEEN, showing: false, waiting: [queued] })
      view.rerender({
        messages: [...SEEN, row('done', 4), row('held', 5, 'user'), row('answer', 6)],
        showing: true
      })
      expect(view.result.current.marker).toMatchObject({ key: 'done', look: 'line' })
    })

    it('draws when a queued send ran after the turn the reader had watched to its end', () => {
      const begun = [row('prompt', 1, 'user'), row('reply', 2)]
      const queued: NativeChatMessage = { ...row('held', 3, 'user'), queued: true }
      const view = chat(begun, { working: true })
      view.rerender({ messages: begun, showing: true, waiting: [queued] })
      view.rerender({ messages: begun, showing: false, waiting: [queued] })
      view.rerender({
        messages: [...begun, row('held', 4, 'user'), row('answer', 5)],
        showing: true,
        turn: { worked: 3 }
      })
      expect(view.result.current.marker).toMatchObject({ key: 'answer', look: 'line' })
    })

    it('draws when a queued send ran behind a turn that had drawn no reply when the reader left', () => {
      const asked = [row('prompt', 1, 'user')]
      const queued: NativeChatMessage = { ...row('held', 2, 'user'), queued: true }
      const view = chat(asked, { working: true })
      view.rerender({ messages: asked, showing: true, waiting: [queued] })
      view.rerender({ messages: asked, showing: false, waiting: [queued] })
      // The running turn settles with nothing to show; the held send runs and gets a short answer.
      view.rerender({
        messages: [...asked, row('held', 3, 'user'), row('answer', 4)],
        showing: true,
        turn: { worked: 3 }
      })
      expect(view.result.current.marker).toMatchObject({ key: 'answer', look: 'line' })
    })

    it('weighs by height a short reply to a turn that had drawn no reply when the reader left', () => {
      const asked = [row('prompt', 1, 'user')]
      const view = chat(asked, { working: true })
      view.rerender({ messages: asked, showing: false })
      view.rerender({
        messages: [...asked, row('answer', 2)],
        showing: true,
        turn: { worked: 3 }
      })
      // Drawn above the turn bar that parts the answer from the reader's prompt.
      expect(view.result.current.marker).toMatchObject({ key: 'prompt', look: 'measure' })
    })

    it('draws when a prompt this pane never sent ran, such as an auto-continue', () => {
      const view = leaveAndReturn(SEEN, [...SEEN, row('continue', 3, 'user'), row('answer', 4)])
      expect(view.result.current.marker).toMatchObject({ key: 'answer', look: 'line' })
    })

    it('does not draw for the send journalled after the reader looked away', () => {
      // Drawn before the journal places it, just after the newest row; placed later than that.
      const sending = [...SEEN, { ...row('next-prompt', null, 'user'), journalPosition: at(2.5) }]
      const view = leaveAndReturn(sending, [...SEEN, row('next-prompt', 3, 'user'), row('a', 4)])
      expect(view.result.current.marker).toMatchObject({ key: 'a', look: 'measure' })
    })

    it('does not draw for a first send the host held while the chat opened', () => {
      const sent: NativeChatMessage = { ...row('prompt', null, 'user'), queued: true }
      const view = chat([])
      view.rerender({ messages: [], showing: true, waiting: [sent] })
      view.rerender({ messages: [], showing: false, waiting: [sent] })
      const ran = row('prompt', 1, 'user')
      view.rerender({ messages: [ran, row('answer', 2)], showing: true })
      expect(view.result.current.marker).toMatchObject({ key: 'answer', look: 'measure' })
    })

    it('tells of the rows but draws nothing when they measure short', () => {
      const view = leaveAndReturn(SEEN, LATER)
      const { announcement } = view.result.current
      act(() => view.result.current.marker?.onMeasured(false))
      expect(view.result.current).toMatchObject({ marker: undefined, index: -1, announcement })
    })

    it('weighs the next return afresh once faded, and announces it again', () => {
      const view = leaveAndReturn(SEEN, LATER)
      const first = view.result.current.announcement
      act(() => view.result.current.marker?.onMeasured(true))
      act(() => view.result.current.marker?.onFaded())
      expect(view.result.current.marker).toMatchObject({ key: 'answer', look: 'faded' })

      view.rerender({ messages: LATER, showing: false })
      expect(view.result.current.marker).toMatchObject({ key: 'answer', look: 'faded' })
      const newer = [...LATER, fromAgent('peer', 5)]
      view.rerender({ messages: newer, showing: true })
      expect(view.result.current.marker).toMatchObject({
        key: 'peer',
        look: 'line',
        arriving: true
      })
      expect(view.result.current.announcement).not.toBe(first)
    })

    it('keeps a faded line in place when the next return needs none', () => {
      const view = leaveAndReturn(SEEN, LATER)
      act(() => view.result.current.marker?.onMeasured(true))
      act(() => view.result.current.marker?.onFaded())
      const first = view.result.current.announcement

      view.rerender({ messages: LATER, showing: false })
      view.rerender({ messages: [...LATER, row('short', 5)], showing: true })
      expect(view.result.current.marker).toMatchObject({ key: 'short', look: 'measure' })
      act(() => view.result.current.marker?.onMeasured(false))
      expect(view.result.current.marker).toMatchObject({
        key: 'answer',
        look: 'faded',
        arriving: false
      })
      expect(view.result.current.announcement).not.toBe(first)
    })

    it('stays faded through a look away that brings nothing new', () => {
      const view = leaveAndReturn(SEEN, LATER)
      act(() => view.result.current.marker?.onMeasured(true))
      act(() => view.result.current.marker?.onFaded())
      view.rerender({ messages: LATER, showing: false })
      view.rerender({ messages: LATER, showing: true })
      expect(view.result.current.marker).toMatchObject({
        key: 'answer',
        look: 'faded',
        arriving: false
      })
    })

    it('keeps a line not yet faded through a look away', () => {
      const view = leaveAndReturn(SEEN, LATER)
      act(() => view.result.current.marker?.onMeasured(true))
      act(() => view.result.current.marker?.onArrived())
      view.rerender({ messages: LATER, showing: false })
      view.rerender({ messages: [...LATER, fromAgent('peer', 5)], showing: true })
      expect(view.result.current.marker).toMatchObject({
        key: 'answer',
        look: 'line',
        arriving: false
      })
    })
  })

  it('marks nothing in a chat read from a terminal, whose rows the journal never placed', () => {
    const view = leaveAndReturn([row('a', null)], [row('a', null), row('b', null)])
    expect(view.result.current.marker).toBeUndefined()
  })
})
