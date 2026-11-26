import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { stageBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import {
  NO_HEAD_TRACK,
  nativeChatNextHeadTrack,
  type NativeChatHeadTrack
} from './native-chat-head-track'
import { NO_TURNS, withTurns } from './native-chat-held-open-turns'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import {
  buildNativeChatTranscript,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'
import { createNativeChatStreamedTranscript } from './native-chat-transcript-streamed-slots'

const text = (id: string, role: 'user' | 'assistant', words: string): NativeChatMessage => ({
  id,
  role,
  source: 'transcript',
  timestamp: null,
  blocks: [{ type: 'text', text: words }]
})

/** One row holding consecutive calls, under the first call's id, as a read projects them. */
const calls = (id: string, from: number, to: number): NativeChatMessage => ({
  id,
  role: 'assistant',
  source: 'transcript',
  timestamp: null,
  blocks: Array.from({ length: to - from + 1 }, (_, offset): NativeChatMessage['blocks'] => [
    {
      type: 'tool-call',
      name: 'shell',
      callId: `c${from + offset}`,
      input: { command: `echo ${from + offset}` },
      state: 'completed'
    },
    { type: 'tool-result', callId: `c${from + offset}`, output: `out ${from + offset}` }
  ]).flat()
})

function input(
  messages: NativeChatMessage[],
  turnKeys: (string | undefined)[],
  settled: readonly string[],
  expandedTurnKeys: ReadonlySet<string>
): NativeChatTranscriptSlotsInput {
  return {
    messages,
    turnKeys,
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: {
      active: null,
      completedByTurn: Object.fromEntries(
        settled.map((key) => [key, { startedAt: 0, thinking: false, workedSeconds: 8 }])
      )
    },
    turnDiffs: new Map(),
    expandedTurnKeys,
    isWorking: false,
    lifecycleWorking: false
  }
}

/** One commit as the slots hook makes it: draw with the held turns and carries, then track. */
function commit(
  head: NativeChatHeadTrack,
  next: NativeChatTranscriptSlotsInput,
  paging: boolean
): { head: NativeChatHeadTrack; slots: NativeChatTranscriptSlot[] } {
  const drawnInput = {
    ...next,
    expandedTurnKeys: withTurns(next.expandedTurnKeys, head.held),
    carriedDisclosureIds: head.carried
  }
  const slots = buildNativeChatTranscript(drawnInput).slots
  // Like the hook, the track only moves when the first row changes.
  const firstRowChanged =
    head.window === null || head.window.messages[0]?.id !== next.messages[0]?.id
  return {
    head: firstRowChanged
      ? nativeChatNextHeadTrack(
          head,
          { ...drawnInput, expandedTurnKeys: next.expandedTurnKeys },
          slots,
          paging
        )
      : head,
    slots
  }
}

const answer = text('answer', 'assistant', 'Done.')
const prompt = text('prompt', 'user', 'Do it')

it('keeps a run under its first id while older pages grow it, and keeps its turn open', () => {
  let { head } = commit(
    NO_HEAD_TRACK,
    input([calls('r6', 6, 7), answer], [undefined, undefined], [], NO_TURNS),
    false
  )
  // Two pages that keep the row count (each merges older calls into the head row), then one that
  // brings the prompt and settles the turn.
  const pages: [row: string, from: number][] = [
    ['r4', 4],
    ['r2', 2]
  ]
  for (const [row, from] of pages) {
    head = commit(
      head,
      input([calls(row, from, 7), answer], [undefined, undefined], [], NO_TURNS),
      true
    ).head
    expect([...head.carried]).toEqual([[row, 'r6']])
  }
  const rows = [prompt, calls('r0', 0, 7), answer]
  head = commit(head, input(rows, ['p', 'p', 'p'], ['p'], NO_TURNS), true).head
  expect([...head.carried]).toEqual([['r0', 'r6']])
  expect([...head.held]).toEqual(['p'])

  // The reader's expanded turns take the held turn over; the run is drawn under its first id.
  const { slots } = commit(
    { ...head, held: NO_TURNS },
    input(rows, ['p', 'p', 'p'], ['p'], new Set(['p'])),
    false
  )
  const run = slots.find((slot) => slot.kind === 'message' && slot.message.id === 'r0')
  expect(run).toMatchObject({ folded: false, disclosureId: 'r6' })
})

it('leaves a turn the reader folded folded when an older page lands', () => {
  const turn = [text('q', 'user', 'Look'), calls('x', 0, 0), text('qa', 'assistant', 'Seen.')]
  // The reader opened the turn when the window was recorded, then folded it again.
  let { head } = commit(NO_HEAD_TRACK, input(turn, ['q', 'q', 'q'], ['q'], new Set(['q'])), false)
  head = commit(head, input(turn, ['q', 'q', 'q'], ['q'], NO_TURNS), false).head
  const paged = [text('z', 'user', 'Before'), text('za', 'assistant', 'Earlier.'), ...turn]
  head = commit(head, input(paged, ['z', 'z', 'q', 'q', 'q'], ['z', 'q'], NO_TURNS), true).head

  expect(head.held.size).toBe(0)
})

it('keeps the streamed fast path for a transcript with a carried run', () => {
  const saved = [calls('r0', 0, 7), text('reply', 'assistant', 'Working on')]
  const carried = {
    ...input(saved, [undefined, undefined], [], NO_TURNS),
    carriedDisclosureIds: new Map([['r0', 'r6']])
  }
  const { messages: _saved, ...structure } = carried
  const streamed = createNativeChatStreamedTranscript()
  const first = streamed(structure, saved, saved)
  const grown = [saved[0]!, text('reply', 'assistant', 'Working on it now')]
  const next = streamed(structure, saved, grown)

  const run = (slots: readonly NativeChatTranscriptSlot[]) =>
    slots.find((slot) => slot.kind === 'message' && slot.message.id === 'r0')
  expect(run(first.slots)).toMatchObject({ disclosureId: 'r6' })
  // Patched, not rebuilt: the carried slot is the same object and the frame keeps its stage.
  expect(run(next.slots)).toBe(run(first.slots))
  expect(stageBesideStreamedText(next.slots)).not.toBe(next.slots)
})
