import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { nativeChatTurnSegmentKey } from './native-chat-turn-segments'

const start = Date.parse('2026-11-27T12:00:00Z')
const at = (seconds: number): number => start + seconds * 1000

const row = (
  id: string,
  role: NativeChatMessage['role'],
  seconds: number,
  blocks: NativeChatMessage['blocks'],
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage => ({
  id,
  role,
  source: 'transcript',
  timestamp: at(seconds),
  blocks,
  ...extra
})

const text = (value: string): NativeChatMessage['blocks'][number] => ({ type: 'text', text: value })
const call: NativeChatMessage['blocks'][number] = { type: 'tool-call', name: 'read', input: {} }
const result: NativeChatMessage['blocks'][number] = { type: 'tool-result', output: 'ok' }

// The person's message, 6m 14s of work, their follow-up mid-turn (a steer, or a Slack message the
// host delivered into the running turn), then more work.
const steeredTurn: NativeChatMessage[] = [
  row('ask', 'user', 0, [text('Scan the release.')]),
  row('read-1', 'assistant', 5, [text('Reading the scan.'), call]),
  row('read-1-result', 'tool', 6, [result]),
  row('follow-up', 'user', 374, [text('Debug deeply.')]),
  row('read-2', 'assistant', 380, [call]),
  row('read-2-result', 'tool', 381, [result])
]
// A second message 26s after the first, then more work.
const twiceSteered: NativeChatMessage[] = [
  ...steeredTurn,
  row('again', 'user', 400, [text('Also check the logs.')]),
  row('read-3', 'assistant', 410, [call]),
  row('read-3-result', 'tool', 411, [result])
]
const answer = row('answer', 'assistant', 600, [text('Both workers hit a usage limit.')])

const live: NativeChatTurnStatus = { startedAt: start, thinking: false, workedSeconds: null }
const settledFor = (extra: Partial<NativeChatTurnStatus> = {}): NativeChatTurnStatus => ({
  startedAt: start,
  thinking: false,
  workedSeconds: 600,
  ...extra
})

function build({
  messages = steeredTurn,
  running,
  expanded = [],
  turnKey = 'ask',
  settled = settledFor(),
  ...rest
}: {
  messages?: NativeChatMessage[]
  running: boolean
  expanded?: string[]
  turnKey?: string
  settled?: NativeChatTurnStatus
} & Partial<NativeChatTranscriptSlotsInput>) {
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => turnKey),
    liveTurnKey: turnKey,
    receipts: new Map(),
    turnStatuses: running
      ? { active: live, completedByTurn: {} }
      : { active: settled, completedByTurn: { [turnKey]: settled } },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(expanded),
    isWorking: running,
    lifecycleWorking: false,
    ...rest
  }).flatMap((slot) => (slot.kind === 'message' ? [slot] : []))
}

type Slots = ReturnType<typeof build>
const bars = (slots: Slots) =>
  slots.flatMap((slot) =>
    slot.status
      ? [
          {
            under: slot.message.id,
            startedAt: slot.status.startedAt,
            workedSeconds: slot.status.workedSeconds,
            ...(slot.status.continued && { continued: true }),
            ...(slot.status.verdict && { verdict: slot.status.verdict }),
            ...(slot.turnFolds && { opens: slot.foldKey ?? slot.turnKey })
          }
        ]
      : []
  )
const drawn = (slots: Slots) =>
  slots.filter((slot) => slot.drawsMessage).map(({ message }) => message.id)
const afterFollowUp = nativeChatTurnSegmentKey('ask', 'follow-up')
const afterAgain = nativeChatTurnSegmentKey('ask', 'again')

describe('turn bars when the person writes into a running turn', () => {
  it('moves the live clock under the newest message and settles the work before it', () => {
    const slots = build({ running: true })
    expect(bars(slots)).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: 374, opens: 'ask' },
      { under: 'follow-up', startedAt: at(374), workedSeconds: null }
    ])
    // The work before the follow-up folds behind its settled row (its words stay, as in a settled
    // turn); the work after it stays live.
    expect(drawn(slots)).toEqual(['ask', 'read-1', 'follow-up', 'read-2', 'read-2-result'])
  })

  it('opens the work before the follow-up when the reader expands it', () => {
    expect(drawn(build({ running: true, expanded: ['ask'] }))).toEqual(
      steeredTurn.map(({ id }) => id)
    )
  })

  it('gives each finished stretch its own row that opens on its own', () => {
    const slots = build({ messages: twiceSteered, running: true })
    expect(bars(slots)).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: 374, opens: 'ask' },
      {
        under: 'follow-up',
        startedAt: at(374),
        workedSeconds: 26,
        continued: true,
        opens: afterFollowUp
      },
      { under: 'again', startedAt: at(400), workedSeconds: null }
    ])
    const live = ['again', 'read-3', 'read-3-result']
    expect(drawn(slots)).toEqual(['ask', 'read-1', 'follow-up', ...live])
    expect(drawn(build({ messages: twiceSteered, running: true, expanded: ['ask'] }))).toEqual([
      'ask',
      'read-1',
      'read-1-result',
      'follow-up',
      ...live
    ])
    expect(
      drawn(build({ messages: twiceSteered, running: true, expanded: [afterFollowUp] }))
    ).toEqual(['ask', 'read-1', 'follow-up', 'read-2', 'read-2-result', ...live])
  })

  it('offers no caret on a stretch that hides nothing', () => {
    const quick = [
      ...steeredTurn.slice(0, 4),
      row('again', 'user', 380, [text('Also check the logs.')]),
      row('read-3', 'assistant', 410, [call])
    ]
    expect(bars(build({ messages: quick, running: true }))).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: 374, opens: 'ask' },
      { under: 'follow-up', startedAt: at(374), workedSeconds: 6, continued: true },
      { under: 'again', startedAt: at(380), workedSeconds: null }
    ])
  })

  it('keeps the live bar under the prompt when nothing was sent mid-turn', () => {
    const plain = steeredTurn.slice(0, 3)
    expect(bars(build({ messages: plain, running: true }))).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: null }
    ])
    expect(drawn(build({ messages: plain, running: true }))).toEqual(plain.map(({ id }) => id))
  })

  it('does not split on another agent’s mail, which is work inside the turn', () => {
    const mail = row('mail', 'user', 200, [text('Worker done.')], {
      from: {
        kind: 'agent',
        senders: [],
        orchestration: { message: 'mail-notice', mailbox: 'm', dispatchId: null, messages: [] }
      }
    })
    expect(bars(build({ messages: [...steeredTurn.slice(0, 3), mail], running: true }))).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: null }
    ])
  })

  it('draws the live bar under the person’s message in a turn the agent opened on its own', () => {
    const slots = build({ messages: steeredTurn.slice(1), running: true, turnKey: 'resumed' })
    expect(
      slots.flatMap((slot) =>
        slot.status ? [[slot.message.id, slot.statusAbove, slot.status.workedSeconds]] : []
      )
    ).toEqual([
      ['read-1', true, 374],
      ['follow-up', false, null]
    ])
  })

  it('splits at the first loaded row when it is the person’s message and the opener is not loaded', () => {
    // Only the turn's tail is loaded: it starts on the follow-up, so the turn's bar draws above it.
    const tail = steeredTurn.slice(3)
    const running = build({ messages: tail, running: true })
    expect(running[0]).toMatchObject({
      leadStatus: { startedAt: start, workedSeconds: 374 },
      status: { startedAt: at(374), workedSeconds: null },
      statusAbove: false
    })
    expect(bars(running)).toEqual([{ under: 'follow-up', startedAt: at(374), workedSeconds: null }])
    const settled = build({ messages: [...tail, answer], running: false })
    expect(settled[0]).toMatchObject({
      leadStatus: { startedAt: start, workedSeconds: 600 },
      status: { startedAt: at(374), workedSeconds: 226, continued: true },
      statusAbove: false
    })
  })

  it('leaves a group turn, whose header opens it whole, uncut', () => {
    const slots = build({ messages: twiceSteered, running: true, turnBarsOnRows: false })
    expect(bars(slots)).toEqual([{ under: 'ask', startedAt: start, workedSeconds: null }])
    expect(drawn(slots)).toEqual(twiceSteered.map(({ id }) => id))
    const settled = build({
      messages: [...twiceSteered, answer],
      running: false,
      turnBarsOnRows: false
    })
    expect(drawn(settled)).toEqual(['ask', 'read-1', 'follow-up', 'again', 'answer'])
    expect(
      drawn(
        build({
          messages: [...twiceSteered, answer],
          running: false,
          turnBarsOnRows: false,
          expanded: ['ask']
        })
      )
    ).toEqual([...twiceSteered, answer].map(({ id }) => id))
  })
})

describe('turn bars once a turn the person wrote into settles', () => {
  const settledTurn = [...twiceSteered, answer]

  it('keeps the whole turn on its own bar and times each stretch under its message', () => {
    expect(bars(build({ messages: settledTurn, running: false }))).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: 600, opens: 'ask' },
      {
        under: 'follow-up',
        startedAt: at(374),
        workedSeconds: 26,
        continued: true,
        opens: afterFollowUp
      },
      {
        under: 'again',
        startedAt: at(400),
        workedSeconds: 200,
        continued: true,
        opens: afterAgain
      }
    ])
  })

  it('keeps the stopped or failed wording on the turn’s own bar only', () => {
    const stopped = build({
      messages: settledTurn,
      running: false,
      settled: settledFor({ verdict: 'cancellation' })
    })
    expect(bars(stopped).map(({ verdict, continued }) => ({ verdict, continued }))).toEqual([
      { verdict: 'cancellation', continued: undefined },
      { verdict: undefined, continued: true },
      { verdict: undefined, continued: true }
    ])
  })

  it('folds each stretch on its own, and every tool call stays one click away', () => {
    const toolRows = settledTurn.filter(({ blocks }) =>
      blocks.some(({ type }) => type === 'tool-call' || type === 'tool-result')
    )
    const folded = build({ messages: settledTurn, running: false })
    expect(drawn(folded)).toEqual(['ask', 'read-1', 'follow-up', 'again', 'answer'])
    const opens = bars(folded).flatMap(({ opens }) => (opens ? [opens] : []))
    expect(opens).toEqual(['ask', afterFollowUp, afterAgain])
    // Each bar opens only its own stretch's rows.
    const opened = (keys: string[]) =>
      drawn(build({ messages: settledTurn, running: false, expanded: keys }))
    expect(opened(['ask'])).toEqual([
      'ask',
      'read-1',
      'read-1-result',
      'follow-up',
      'again',
      'answer'
    ])
    expect(opened([afterFollowUp])).toEqual([
      'ask',
      'read-1',
      'follow-up',
      'read-2',
      'read-2-result',
      'again',
      'answer'
    ])
    expect(opened([afterAgain])).toEqual([
      'ask',
      'read-1',
      'follow-up',
      'again',
      'read-3',
      'read-3-result',
      'answer'
    ])
    // Opening every bar shows every tool call, before and after each message.
    const all = opened(opens)
    for (const { id } of toolRows) {
      expect(all).toContain(id)
    }
    expect(all).toEqual(settledTurn.map(({ id }) => id))
  })

  it('keeps one bar with the whole turn when nobody wrote into it', () => {
    const plain = [...steeredTurn.slice(0, 3), answer]
    const slots = build({ messages: plain, running: false })
    expect(bars(slots)).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: 600, opens: 'ask' }
    ])
    expect(drawn(slots)).toEqual(['ask', 'answer'])
  })
})
