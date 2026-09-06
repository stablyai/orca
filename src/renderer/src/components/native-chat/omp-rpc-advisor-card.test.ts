// Advisor-card projection: the frame carriers, the cross-carrier identity's
// role as a dedupe key, and the retirement rule that keeps a covered card from
// coming back once its transcript row leaves the bounded window.

import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import { OMP_RPC_ADVISOR_CARDS_MAX } from './omp-rpc-overlay-retention'
import {
  createInitialOmpRpcTurnState,
  ompRpcTurnReducer,
  type OmpRpcTurnState
} from './omp-rpc-turn-reducer'
import {
  OMP_RPC_ADVISOR_ID_PREFIX,
  selectOmpRpcRetirableAdvisorTurnIds,
  selectOmpRpcOverlayMessages
} from './omp-rpc-turn-overlay'

/** A settled read whose window the HOST measured as dropping older records —
 *  the only shape the timestamp-horizon rule may be inferred from. */
const TRUNCATED_WINDOW = { settled: true, omitsOlderRecords: true }

function frame(event: OmpRpcClientEvent): { type: 'frame'; event: OmpRpcClientEvent } {
  return { type: 'frame', event }
}

function reduceAll(events: OmpRpcClientEvent[]): OmpRpcTurnState {
  return events.reduce(
    (state, event) => ompRpcTurnReducer(state, frame(event)),
    createInitialOmpRpcTurnState()
  )
}

describe('ompRpcTurnReducer advisor cards', () => {
  const advisorCardFrame = (
    type: 'message_start' | 'message_end',
    message: Record<string, unknown>
  ): OmpRpcClientEvent =>
    type === 'message_start'
      ? { kind: 'message-start', frame: { type: 'message_start', message } }
      : { kind: 'message-end', frame: { type: 'message_end', message } }

  const advisorCard = (notes: unknown[], extra: Record<string, unknown> = {}) => ({
    role: 'custom',
    customType: 'advisor',
    display: true,
    attribution: 'agent',
    timestamp: 1_700_000_000_000,
    content: '<advisory guidance="x">\nignored when details is present\n</advisory>',
    details: { notes },
    ...extra
  })

  it('captures an advisor card from a message_end frame', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      advisorCardFrame(
        'message_end',
        advisorCard([{ note: 'Watch the coupling.', severity: 'concern', advisor: 'Architecture' }])
      )
    ])
    expect(state.advisorCards).toEqual([
      {
        turnId: 'omp-advisor:1700000000000:Architecture/concern/Watch the coupling.',
        notes: [{ note: 'Watch the coupling.', severity: 'concern', advisor: 'Architecture' }],
        timestamp: 1_700_000_000_000
      }
    ])
  })

  it('does not double-count the start and end frames of one card', () => {
    const card = advisorCard([{ note: 'Stay silent.', severity: 'nit' }])
    const state = reduceAll([
      advisorCardFrame('message_start', card),
      advisorCardFrame('message_end', card)
    ])
    expect(state.advisorCards).toHaveLength(1)
  })

  it('ignores ordinary assistant message frames and hidden advisor cards', () => {
    const state = reduceAll([
      advisorCardFrame('message_end', { role: 'assistant', content: 'hello' }),
      advisorCardFrame('message_end', advisorCard([{ note: 'hidden' }], { display: false })),
      advisorCardFrame('message_end', advisorCard([], { content: '' }))
    ])
    expect(state.advisorCards).toEqual([])
  })

  // The turn boundary is not proof the transcript surfaced the card: OMP emits
  // message_end before it persists the entry, so a prompt or automatic
  // continuation can start first. Only the overlay's transcript-coverage gate
  // may retire a card, so the reducer carries it across agent_start.
  it('keeps an advisor card across the turn boundary until the transcript covers it', () => {
    const state = reduceAll([
      advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }])),
      { kind: 'agent-start', frame: { type: 'agent_start' } }
    ])
    expect(state.advisorCards).toEqual([
      {
        turnId: 'omp-advisor:1700000000000:/nit/Stay silent.',
        notes: [{ note: 'Stay silent.', severity: 'nit' }],
        timestamp: 1_700_000_000_000
      }
    ])
    expect(
      selectOmpRpcOverlayMessages(state, []).filter((message) =>
        message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX)
      )
    ).toHaveLength(1)

    const covered: NativeChatMessage = {
      id: 'rec-adv',
      role: 'system',
      blocks: [{ type: 'text', text: 'anything' }],
      timestamp: 1_700_000_000_000,
      source: 'transcript',
      turnId: 'omp-advisor:1700000000000:/nit/Stay silent.'
    }
    expect(
      selectOmpRpcOverlayMessages(state, [covered]).filter((message) =>
        message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX)
      )
    ).toEqual([])
  })

  it('bounds the carried advisor cards rather than growing them for the session', () => {
    const state = reduceAll(
      Array.from({ length: OMP_RPC_ADVISOR_CARDS_MAX + 5 }, (_unused, index) =>
        advisorCardFrame(
          'message_end',
          advisorCard([{ note: `note ${index}`, severity: 'nit' }], { timestamp: index })
        )
      )
    )
    expect(state.advisorCards).toHaveLength(OMP_RPC_ADVISOR_CARDS_MAX)
    expect(state.advisorCards[0].notes[0].note).toBe('note 5')
  })

  // A session reset (pane teardown / re-own) is the one boundary that DOES
  // retire the cards: the transcript is re-read from scratch behind it.
  it('drops advisor cards on a session reset', () => {
    const state = ompRpcTurnReducer(
      reduceAll([
        advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }]))
      ]),
      { type: 'reset' }
    )
    expect(state.advisorCards).toEqual([])
  })

  // SA-003: hiding a covered card is not enough. The transcript list is a
  // bounded window (native-chat-pagination.ts), so the row that proved
  // coverage eventually scrolls out of it — and a card only hidden would
  // reappear at the tail as brand new advice. Coverage is therefore consumed
  // once and recorded, and the card retires for good.
  it('retires a covered advisor card so a shrunken transcript window cannot resurrect it', () => {
    const turnId = 'omp-advisor:1700000000000:/nit/Stay silent.'
    const state = reduceAll([
      advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }]))
    ])
    const covered: NativeChatMessage = {
      id: 'rec-adv',
      role: 'system',
      blocks: [{ type: 'text', text: 'anything' }],
      timestamp: 1_700_000_000_000,
      source: 'transcript',
      turnId
    }
    expect(selectOmpRpcRetirableAdvisorTurnIds(state, [covered])).toEqual([turnId])

    const retired = ompRpcTurnReducer(state, {
      type: 'advisor-cards-covered',
      turnIds: [turnId]
    })
    expect(retired.advisorCards).toEqual([])
    expect(
      selectOmpRpcOverlayMessages(retired, []).filter((message) =>
        message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX)
      )
    ).toEqual([])
  })

  it('reports nothing to retire while the transcript has not covered the card', () => {
    const state = reduceAll([
      advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }]))
    ])
    expect(selectOmpRpcRetirableAdvisorTurnIds(state, [])).toEqual([])
    expect(ompRpcTurnReducer(state, { type: 'advisor-cards-covered', turnIds: [] })).toBe(state)
  })

  // Both message boundaries carry the finished card, and nothing orders the
  // transcript tailer against them: a retired card must not be re-admitted by
  // the second frame, or it would render again with no coverage left to hide it.
  it('refuses to re-admit a retired card from the other message boundary', () => {
    const turnId = 'omp-advisor:1700000000000:/nit/Stay silent.'
    const card = advisorCard([{ note: 'Stay silent.', severity: 'nit' }])
    const retired = ompRpcTurnReducer(reduceAll([advisorCardFrame('message_start', card)]), {
      type: 'advisor-cards-covered',
      turnIds: [turnId]
    })
    expect(retired.advisorCards).toEqual([])

    const afterEnd = ompRpcTurnReducer(retired, frame(advisorCardFrame('message_end', card)))
    expect(afterEnd.advisorCards).toEqual([])
  })

  it('carries the retirement ledger across a turn boundary and clears it on reset', () => {
    const turnId = 'omp-advisor:1700000000000:/nit/Stay silent.'
    const card = advisorCard([{ note: 'Stay silent.', severity: 'nit' }])
    const retired = ompRpcTurnReducer(reduceAll([advisorCardFrame('message_end', card)]), {
      type: 'advisor-cards-covered',
      turnIds: [turnId]
    })
    const nextTurn = ompRpcTurnReducer(
      retired,
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } })
    )
    expect(nextTurn.retiredAdvisorTurnIds).toEqual([turnId])
    expect(
      ompRpcTurnReducer(nextTurn, frame(advisorCardFrame('message_end', card))).advisorCards
    ).toEqual([])
    expect(ompRpcTurnReducer(nextTurn, { type: 'reset' }).retiredAdvisorTurnIds).toEqual([])
  })

  it('bounds the retirement ledger rather than growing it for the session', () => {
    const turnIds = Array.from(
      { length: OMP_RPC_ADVISOR_CARDS_MAX + 5 },
      (_unused, index) => `omp-advisor:${index}:/nit/note ${index}`
    )
    const state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'advisor-cards-covered',
      turnIds
    })
    expect(state.retiredAdvisorTurnIds).toHaveLength(OMP_RPC_ADVISOR_CARDS_MAX)
    expect(state.retiredAdvisorTurnIds[0]).toBe(turnIds[5])
  })

  // SA-005: coverage is observed only while the Chat view is mounted, but the
  // card lives on the pane-anchored RPC ownership that survives that view's
  // unmount. Switch to Terminal right after an advisor frame and the covering
  // row is never seen; by the time Chat reopens, enough records have pushed
  // that row out of the bounded window, so no turnId in it can ever match. The
  // window's own horizon is the standing proof: every row it still holds is
  // newer than the card, so the card's row is provably behind it and showing
  // the card again would present old advice as new.
  it('retires an advisor card the transcript window has scrolled entirely past', () => {
    const turnId = 'omp-advisor:1700000000000:/nit/Stay silent.'
    const state = reduceAll([
      advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }]))
    ])
    const laterRow: NativeChatMessage = {
      id: 'rec-later',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'much later' }],
      timestamp: 1_700_000_000_001,
      source: 'transcript'
    }
    expect(selectOmpRpcRetirableAdvisorTurnIds(state, [laterRow], TRUNCATED_WINDOW)).toEqual([
      turnId
    ])
    // Rendered too, not just reported: the retirement dispatch runs in an
    // effect, so a render-time gate that disagreed would flash the stale card.
    expect(
      selectOmpRpcOverlayMessages(state, [laterRow], TRUNCATED_WINDOW).filter((message) =>
        message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX)
      )
    ).toEqual([])
  })

  // XLR-R6-006: the list handed to the selector has RPC-hydrated history merged
  // into it, and that snapshot reaches back further than the bounded transcript
  // read — while `omitsOlderRecords` measures the transcript window alone. A
  // retained hydrated row must therefore never lower the horizon, or a card
  // sitting inside the scrolled-past region reappears as fresh advice on every
  // Chat-view remount.
  it('ignores hydrated RPC rows when reading the transcript window horizon', () => {
    const turnId = 'omp-advisor:1700000000000:/nit/Stay silent.'
    const state = reduceAll([
      advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }]))
    ])
    const hydratedOlderRow: NativeChatMessage = {
      id: 'omp-rpc-history-0',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'recovered over the wire' }],
      timestamp: 1_699_999_999_000,
      source: 'rpc'
    }
    const measuredWindowRow: NativeChatMessage = {
      id: 'rec-later',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'much later' }],
      timestamp: 1_700_000_001_000,
      source: 'transcript'
    }
    expect(
      selectOmpRpcRetirableAdvisorTurnIds(
        state,
        [hydratedOlderRow, measuredWindowRow],
        TRUNCATED_WINDOW
      )
    ).toEqual([turnId])
    expect(
      selectOmpRpcOverlayMessages(
        state,
        [hydratedOlderRow, measuredWindowRow],
        TRUNCATED_WINDOW
      ).filter((message) => message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX))
    ).toEqual([])
  })

  // SA-007: the horizon rule is an inference from a window that PROVABLY drops
  // older records — "the covering row fell off the back". A window still
  // holding the head of the transcript has nothing behind it, so a row merely
  // newer than the card proves nothing about the card's own row. The ordinary
  // race has exactly this shape: message_end lands before the tailer persists
  // the advisor entry, while some unrelated later row is already in the list.
  it('keeps the card when the window still reaches the head of the transcript', () => {
    const state = reduceAll([
      advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }]))
    ])
    const unrelatedLaterRow: NativeChatMessage = {
      id: 'rec-later',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'a row that is not the advisor entry' }],
      timestamp: 1_700_000_000_001,
      source: 'transcript'
    }
    const wholeTranscript = { settled: true, omitsOlderRecords: false }
    expect(
      selectOmpRpcRetirableAdvisorTurnIds(state, [unrelatedLaterRow], wholeTranscript)
    ).toEqual([])
    expect(
      selectOmpRpcOverlayMessages(state, [unrelatedLaterRow], wholeTranscript).filter((message) =>
        message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX)
      )
    ).toHaveLength(1)
  })

  it('keeps the card while the windowed read has not settled', () => {
    const state = reduceAll([
      advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }]))
    ])
    const liveAppend: NativeChatMessage = {
      id: 'rec-append',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'watcher append before the read settled' }],
      timestamp: 1_700_000_000_001,
      source: 'transcript'
    }
    expect(
      selectOmpRpcRetirableAdvisorTurnIds(state, [liveAppend], {
        settled: false,
        omitsOlderRecords: true
      })
    ).toEqual([])
  })

  // Fail closed: a caller that supplies no window metadata gets rule 1 only.
  // Rendering a live card twice is recoverable; silently dropping the only
  // copy of advice the user never saw is not.
  it('applies only the turnId rule when no window metadata is supplied', () => {
    const state = reduceAll([
      advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }]))
    ])
    const laterRow: NativeChatMessage = {
      id: 'rec-later',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'much later' }],
      timestamp: 1_700_000_000_001,
      source: 'transcript'
    }
    expect(selectOmpRpcRetirableAdvisorTurnIds(state, [laterRow])).toEqual([])
  })

  // The ordinary lag is the opposite shape and must stay untouched: the card
  // is newer than everything the window holds, which is exactly what "the
  // tailer has not caught up yet" looks like.
  it('keeps an advisor card the transcript window has not yet reached', () => {
    const state = reduceAll([
      advisorCardFrame('message_end', advisorCard([{ note: 'Stay silent.', severity: 'nit' }]))
    ])
    const earlierRow: NativeChatMessage = {
      id: 'rec-earlier',
      role: 'user',
      blocks: [{ type: 'text', text: 'the prompt that drew the advice' }],
      timestamp: 1_699_999_999_000,
      source: 'transcript'
    }
    expect(selectOmpRpcRetirableAdvisorTurnIds(state, [earlierRow])).toEqual([])
    expect(
      selectOmpRpcOverlayMessages(state, [earlierRow]).filter((message) =>
        message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX)
      )
    ).toHaveLength(1)
  })

  it('renders an uncovered advisor card in the overlay and withdraws it once the transcript has it', () => {
    const state = reduceAll([
      advisorCardFrame(
        'message_end',
        advisorCard([{ note: 'Watch the coupling.', severity: 'concern', advisor: 'Architecture' }])
      )
    ])
    const advisorRow = selectOmpRpcOverlayMessages(state, []).find((message) =>
      message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX)
    )
    expect(advisorRow).toMatchObject({
      role: 'system',
      source: 'rpc',
      turnId: 'omp-advisor:1700000000000:Architecture/concern/Watch the coupling.',
      timestamp: 1_700_000_000_000,
      blocks: [
        {
          type: 'text',
          text: '\u203b advisor \u00b7 Architecture \u00b7 concern\nWatch the coupling.'
        }
      ]
    })

    const covered: NativeChatMessage = {
      id: 'rec-adv',
      role: 'system',
      blocks: [{ type: 'text', text: 'anything' }],
      timestamp: 1_700_000_000_000,
      source: 'transcript',
      turnId: 'omp-advisor:1700000000000:Architecture/concern/Watch the coupling.'
    }
    expect(
      selectOmpRpcOverlayMessages(state, [covered]).filter((message) =>
        message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX)
      )
    ).toEqual([])
  })
})
