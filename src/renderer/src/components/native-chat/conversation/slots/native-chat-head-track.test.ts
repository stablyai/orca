import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { stageBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { openNativeChatExpandedKeys } from '../../messages/disclosure/native-chat-expanded-keys'
import {
  NO_HEAD_TRACK,
  nativeChatHeadTrackStep,
  type NativeChatHeadTrack
} from './native-chat-head-track'
import { NO_TURNS } from './native-chat-held-open-turns'
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

/** One commit as the slots hook makes it: draw with the held turns and carries, step the track,
 *  and step again until it settles, as a render-phase update re-renders. */
function commit(
  head: NativeChatHeadTrack,
  next: NativeChatTranscriptSlotsInput,
  pages: number,
  generation = 0
): { head: NativeChatHeadTrack; slots: NativeChatTranscriptSlot[] } {
  let current = head
  for (let pass = 0; pass < 4; pass += 1) {
    const drawnInput = {
      ...next,
      expandedTurnKeys: openNativeChatExpandedKeys(next.expandedTurnKeys, current.held),
      carriedDisclosureIds: current.carried
    }
    const slots = buildNativeChatTranscript(drawnInput).slots
    const stepped = nativeChatHeadTrackStep(current, {
      session: 'claude:s',
      generation,
      pages,
      input: { ...drawnInput, expandedTurnKeys: next.expandedTurnKeys },
      structure: next.messages,
      slots
    })
    if (stepped === current) {
      return { head: current, slots }
    }
    current = stepped
  }
  throw new Error('The head track did not settle')
}

const answer = text('answer', 'assistant', 'Done.')
const prompt = text('prompt', 'user', 'Do it')
const none = (count: number) => Array.from({ length: count }, () => undefined)

it('keeps a run under its first id while applied pages grow it, and keeps its turn open', () => {
  // A batched success: only the applied-page count moves, whatever loading did.
  let { head } = commit(NO_HEAD_TRACK, input([calls('r6', 6, 7), answer], none(2), [], NO_TURNS), 0)
  // Two pages that keep the row count (each merges older calls into the head row), then one that
  // brings the prompt and settles the turn.
  const pages: [row: string, from: number][] = [
    ['r4', 4],
    ['r2', 2]
  ]
  for (const [index, [row, from]] of pages.entries()) {
    head = commit(head, input([calls(row, from, 7), answer], none(2), [], NO_TURNS), index + 1).head
    expect([...head.carried]).toEqual([[row, 'r6']])
  }
  const rows = [prompt, calls('r0', 0, 7), answer]
  head = commit(head, input(rows, ['p', 'p', 'p'], ['p'], NO_TURNS), 3).head
  expect([...head.carried]).toEqual([['r0', 'r6']])
  expect([...head.held]).toEqual(['p'])

  // The reader's expanded turns take the held turn over; the run is drawn under its first id.
  const opened = commit(head, input(rows, ['p', 'p', 'p'], ['p'], new Set(['p'])), 3)
  expect(opened.head.held.size).toBe(0)
  const run = opened.slots.find((slot) => slot.kind === 'message' && slot.message.id === 'r0')
  expect(run).toMatchObject({ folded: false, disclosureId: 'r6' })

  // A trim's new generation keeps the carries of rows still loaded.
  const trimmed = commit(opened.head, input(rows, ['p', 'p', 'p'], ['p'], new Set(['p'])), 3, 1)
  expect([...trimmed.head.carried]).toEqual([['r0', 'r6']])
})

it('takes nothing from changes that are not an applied page that continues the window', () => {
  const thought: NativeChatMessage = { ...text('thought', 'assistant', 'Hmm.'), role: 'reasoning' }
  let { head } = commit(
    NO_HEAD_TRACK,
    input([thought, calls('r6', 6, 7), answer], none(3), [], NO_TURNS),
    0
  )
  // A reorder while a page is in flight, then that page completing empty.
  const reordered = [calls('r6', 6, 7), thought, answer]
  head = commit(head, input(reordered, none(3), [], NO_TURNS), 0).head
  head = commit(head, input(reordered, none(3), [], NO_TURNS), 1).head
  expect(head.carried.size).toBe(0)
  // Older rows arriving with no applied page (a first load in steps) hold and carry nothing.
  const stepped = [prompt, calls('r0', 0, 7), thought, answer]
  head = commit(head, input(stepped, ['p', 'p', 'p', 'p'], ['p'], NO_TURNS), 1).head
  expect(head.held.size).toBe(0)
  expect(head.carried.size).toBe(0)
  expect(head.window?.messages).toBe(stepped)
})

it('compares a page with the latest window, after appends that kept the first row', () => {
  const work = calls('w', 0, 1)
  let { head } = commit(NO_HEAD_TRACK, input([work], none(1), [], NO_TURNS), 0)
  const appended = [work, answer]
  head = commit(head, input(appended, none(2), [], NO_TURNS), 0).head
  expect(head.window?.messages).toBe(appended)
  head = commit(head, input([prompt, work, answer], ['p', 'p', 'p'], ['p'], NO_TURNS), 1).head
  expect([...head.held]).toEqual(['p'])
})

it('leaves a turn the reader folded folded when an older page lands', () => {
  const turn = [text('q', 'user', 'Look'), calls('x', 0, 0), text('qa', 'assistant', 'Seen.')]
  // The reader had the turn open when the window was recorded, then folded it again.
  let { head } = commit(NO_HEAD_TRACK, input(turn, ['q', 'q', 'q'], ['q'], new Set(['q'])), 0)
  head = commit(head, input(turn, ['q', 'q', 'q'], ['q'], NO_TURNS), 0).head
  const paged = [text('z', 'user', 'Before'), text('za', 'assistant', 'Earlier.'), ...turn]
  head = commit(head, input(paged, ['z', 'z', 'q', 'q', 'q'], ['z', 'q'], NO_TURNS), 1).head

  expect(head.held.size).toBe(0)
})

it('keeps the streamed fast path for a transcript with a carried run', () => {
  const saved = [calls('r0', 0, 7), text('reply', 'assistant', 'Working on')]
  const carried = {
    ...input(saved, none(2), [], NO_TURNS),
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
