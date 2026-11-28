import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'

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

function build({
  messages = steeredTurn,
  running,
  expanded = false
}: {
  messages?: NativeChatMessage[]
  running: boolean
  expanded?: boolean
}) {
  const live: NativeChatTurnStatus = { startedAt: start, thinking: false, workedSeconds: null }
  const settled: NativeChatTurnStatus = { startedAt: start, thinking: false, workedSeconds: 600 }
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => 'ask'),
    liveTurnKey: 'ask',
    receipts: new Map(),
    turnStatuses: running
      ? { active: live, completedByTurn: {} }
      : { active: settled, completedByTurn: { ask: settled } },
    turnDiffs: new Map(),
    expandedTurnKeys: expanded ? new Set(['ask']) : new Set(),
    isWorking: running,
    lifecycleWorking: false
  }).flatMap((slot) => (slot.kind === 'message' ? [slot] : []))
}

const bars = (slots: ReturnType<typeof build>) =>
  slots.flatMap((slot) =>
    slot.status
      ? [
          {
            under: slot.message.id,
            startedAt: slot.status.startedAt,
            workedSeconds: slot.status.workedSeconds
          }
        ]
      : []
  )
const drawn = (slots: ReturnType<typeof build>) =>
  slots.filter((slot) => slot.drawsMessage).map((slot) => slot.message.id)

describe('turn bars when the person writes into a running turn', () => {
  it('moves the live clock under the newest message and settles the work before it', () => {
    const slots = build({ running: true })
    expect(bars(slots)).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: 374 },
      { under: 'follow-up', startedAt: at(374), workedSeconds: null }
    ])
    // The work before the follow-up folds behind its settled row (its words stay, as in a settled
    // turn); the work after it stays live.
    expect(drawn(slots)).toEqual(['ask', 'read-1', 'follow-up', 'read-2', 'read-2-result'])
    const opener = slots.find((slot) => slot.message.id === 'ask')
    expect(opener?.turnFolds).toBe(true)
  })

  it('opens the work before the follow-up when the reader expands it', () => {
    expect(drawn(build({ running: true, expanded: true }))).toEqual(steeredTurn.map(({ id }) => id))
  })

  it('splits at every message the person sent into the turn', () => {
    const messages = [
      ...steeredTurn,
      row('again', 'user', 400, [text('Also check the logs.')]),
      row('read-3', 'assistant', 410, [call])
    ]
    expect(bars(build({ messages, running: true }))).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: 374 },
      { under: 'follow-up', startedAt: at(374), workedSeconds: 26 },
      { under: 'again', startedAt: at(400), workedSeconds: null }
    ])
  })

  it('keeps one bar with the whole turn once it settles', () => {
    const slots = build({ running: false })
    expect(bars(slots)).toEqual([{ under: 'ask', startedAt: start, workedSeconds: 600 }])
    expect(drawn(slots)).toEqual(['ask', 'read-1', 'follow-up'])
  })

  it('keeps the live bar under the prompt when nothing was sent mid-turn', () => {
    const plain = steeredTurn.slice(0, 3)
    expect(bars(build({ messages: plain, running: true }))).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: null }
    ])
    expect(drawn(build({ messages: plain, running: true }))).toEqual(plain.map(({ id }) => id))
  })

  it('draws the live bar under the person’s message in a turn the agent opened on its own', () => {
    const resumed = steeredTurn.slice(1)
    const slots = buildNativeChatTranscriptSlots({
      messages: resumed,
      turnKeys: resumed.map(() => 'resumed-turn'),
      liveTurnKey: 'resumed-turn',
      receipts: new Map(),
      turnStatuses: {
        active: { startedAt: start, thinking: false, workedSeconds: null },
        completedByTurn: {}
      },
      turnDiffs: new Map(),
      expandedTurnKeys: new Set(),
      isWorking: true,
      lifecycleWorking: false
    }).flatMap((slot) => (slot.kind === 'message' ? [slot] : []))
    expect(
      slots.flatMap((slot) =>
        slot.status ? [[slot.message.id, slot.statusAbove, slot.status.workedSeconds] as const] : []
      )
    ).toEqual([
      ['read-1', true, 374],
      ['follow-up', false, null]
    ])
  })

  it('does not split on another agent’s mail, which is work inside the turn', () => {
    const mail = row('mail', 'user', 200, [text('Worker done.')], {
      from: {
        kind: 'agent',
        senders: [],
        orchestration: { message: 'mail-notice', mailbox: 'm', dispatchId: null, messages: [] }
      }
    })
    const messages = [...steeredTurn.slice(0, 3), mail]
    expect(bars(build({ messages, running: true }))).toEqual([
      { under: 'ask', startedAt: start, workedSeconds: null }
    ])
  })
})
