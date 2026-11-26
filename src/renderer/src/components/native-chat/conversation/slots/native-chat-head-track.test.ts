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

/** Which id each drawn run (a slot holding tool calls) draws its disclosures under, by its head;
 *  and no two drawn runs ever share one. */
function drawnIds(slots: readonly NativeChatTranscriptSlot[]): Record<string, string> {
  const runs: [head: string, id: string][] = slots.flatMap((slot): [string, string][] =>
    slot.kind === 'message' &&
    (slot.workRun ?? [slot.message]).some((row) => row.blocks.some((b) => b.type === 'tool-call'))
      ? [[slot.message.id, slot.disclosureId ?? slot.message.id]]
      : []
  )
  expect(new Set(runs.map(([, id]) => id)).size, 'no two drawn runs share an id').toBe(runs.length)
  return Object.fromEntries(runs)
}

/** One commit as the slots hook makes it: draw with the held turns and kept ids, step the track,
 *  and step again until it settles, as a render-phase update re-renders. */
function commit(
  head: NativeChatHeadTrack,
  rows: NativeChatMessage[],
  pages: number,
  options: {
    turnKeys?: (string | undefined)[]
    settled?: readonly string[]
    expanded?: ReadonlySet<string>
    generation?: number
  } = {}
): { head: NativeChatHeadTrack; slots: NativeChatTranscriptSlot[]; ids: Record<string, string> } {
  const next = input(
    rows,
    options.turnKeys ?? rows.map(() => undefined),
    options.settled ?? [],
    options.expanded ?? NO_TURNS
  )
  let current = head
  for (let pass = 0; pass < 6; pass += 1) {
    const drawnInput = {
      ...next,
      expandedTurnKeys: openNativeChatExpandedKeys(next.expandedTurnKeys, current.held),
      ownedRuns: current.owned
    }
    const built = buildNativeChatTranscript(drawnInput)
    const stepped = nativeChatHeadTrackStep(current, {
      session: 'claude:s',
      generation: options.generation ?? 0,
      pages,
      input: { ...drawnInput, expandedTurnKeys: next.expandedTurnKeys },
      structure: next.messages,
      slots: built.slots,
      owners: built.runOwners
    })
    if (stepped === current) {
      return { head: current, slots: built.slots, ids: drawnIds(built.slots) }
    }
    current = stepped
  }
  throw new Error('The head track did not settle')
}

const answer = text('answer', 'assistant', 'Done.')
const prompt = text('prompt', 'user', 'Do it')
const result = text('ci', 'assistant', 'CI passed.')
const call = (id: string, index: number) => calls(id, index, index)

it('keeps a run under its first id while applied pages grow it, and keeps its turn open', () => {
  // A batched success: only the applied-page count moves, whatever loading did.
  let { head } = commit(NO_HEAD_TRACK, [calls('r6', 6, 7), answer], 0)
  // Two pages that keep the row count (each merges older calls into the head row: merge-away).
  head = commit(head, [calls('r4', 4, 7), answer], 1).head
  const chained = commit(head, [calls('r2', 2, 7), answer], 2)
  expect(chained.ids).toEqual({ r2: 'r6' })
  // A page that brings the prompt and settles the turn.
  const rows = [prompt, calls('r0', 0, 7), answer]
  const turnKeys = ['p', 'p', 'p']
  const prompted = commit(chained.head, rows, 3, { turnKeys, settled: ['p'] })
  expect([...prompted.head.held]).toEqual(['p'])
  expect([...prompted.head.owned.keys()]).toEqual(['r6'])
  // The reader's expanded turns take the held turn over; the run stays drawn under its first id.
  const opened = commit(prompted.head, rows, 3, {
    turnKeys,
    settled: ['p'],
    expanded: new Set(['p'])
  })
  expect(opened.head.held.size).toBe(0)
  expect(opened.ids).toEqual({ r0: 'r6' })
})

it('T1, T2: a run grown over two pages, split at either seam, keeps its id on its own row', () => {
  let { head } = commit(NO_HEAD_TRACK, [call('c', 2), answer], 0)
  head = commit(head, [call('b', 1), call('c', 2), answer], 1).head
  const paged = commit(head, [call('a', 0), call('b', 1), call('c', 2), answer], 2)
  expect(paged.ids).toEqual({ a: 'c' })
  const atFirstSeam = [call('a', 0), result, call('b', 1), call('c', 2), answer]
  expect(commit(paged.head, atFirstSeam, 2).ids).toEqual({ a: 'a', b: 'c' })
  const atSecondSeam = [call('a', 0), call('b', 1), result, call('c', 2), answer]
  expect(commit(paged.head, atSecondSeam, 2).ids).toEqual({ a: 'a', c: 'c' })
})

it('T3: follows merged-away rows and splits, rejoins alike on every path, and breaks ties by the earliest member', () => {
  const { head } = commit(NO_HEAD_TRACK, [calls('r6', 6, 7), answer], 0)
  const merged = commit(head, [calls('r4', 4, 7), answer], 1)
  expect(merged.ids).toEqual({ r4: 'r6' })
  // A reread splits the merged row back out: the row named by the id owns it again.
  const split = commit(merged.head, [calls('r4', 4, 5), result, calls('r6', 6, 7), answer], 1)
  expect(split.ids).toEqual({ r4: 'r4', r6: 'r6' })
  // Split again where the calls land in a row of another name: they take the id there.
  const renamed = [calls('r4', 4, 4), result, calls('r5', 5, 7), answer]
  expect(commit(merged.head, renamed, 1).ids).toEqual({ r4: 'r4', r5: 'r6' })
  // Rejoin by structure, with a page that doesn't continue the window, and in a new generation.
  const rejoined = [calls('r4', 4, 7), answer]
  expect(commit(split.head, rejoined, 1).ids).toEqual({ r4: 'r6' })
  expect(commit(split.head, [call('z', 9), result, ...rejoined], 2).ids).toEqual({
    z: 'z',
    r4: 'r6'
  })
  expect(commit(split.head, rejoined, 1, { generation: 1 }).ids).toEqual({ r4: 'r6' })

  // A run holding two kept ids draws its earliest member's: keep y, then split and page so x is
  // kept too, then rejoin them in one run.
  let pair = commit(NO_HEAD_TRACK, [call('y', 1), answer], 0).head
  pair = commit(pair, [call('x', 0), call('y', 1), answer], 1).head
  pair = commit(pair, [call('x', 0), result, call('y', 1), answer], 1).head
  pair = commit(pair, [call('w', 9), call('x', 0), result, call('y', 1), answer], 2).head
  expect([...pair.owned.keys()].sort()).toEqual(['x', 'y'])
  const joined = [call('w', 9), call('x', 0), call('y', 1), answer]
  expect(commit(pair, joined, 2).ids).toEqual({ w: 'x' })

  // A split that lands with a page (one that doesn't continue the window, so nothing new is
  // kept) or with a new generation keeps the runs apart.
  let grown = commit(NO_HEAD_TRACK, [call('c', 2), answer], 0).head
  grown = commit(grown, [call('b', 1), call('c', 2), answer], 1).head
  grown = commit(grown, [call('a', 0), call('b', 1), call('c', 2), answer], 2).head
  const withPage = [call('z', 9), call('a', 0), result, call('b', 1), call('c', 2), answer]
  expect(commit(grown, withPage, 3).ids).toEqual({ z: 'z', b: 'c' })
  const atSeam = [call('a', 0), result, call('b', 1), call('c', 2), answer]
  expect(commit(grown, atSeam, 2, { generation: 1 }).ids).toEqual({ a: 'a', b: 'c' })
})

it('takes nothing from changes that are not an applied page that continues the window', () => {
  const thought: NativeChatMessage = { ...text('thought', 'assistant', 'Hmm.'), role: 'reasoning' }
  let { head } = commit(NO_HEAD_TRACK, [thought, calls('r6', 6, 7), answer], 0)
  // A reorder while a page is in flight, then that page completing empty.
  const reordered = [calls('r6', 6, 7), thought, answer]
  head = commit(head, reordered, 0).head
  head = commit(head, reordered, 1).head
  expect(head.owned.size).toBe(0)
  // A reorder in the same commit as a page's count moving is not that page continuing the window.
  head = commit(head, [thought, calls('r6', 6, 7), answer], 2).head
  expect(head.owned.size).toBe(0)
  // Older rows arriving with no applied page (a first load in steps) hold and keep nothing.
  const stepped = [prompt, calls('r0', 0, 7), thought, answer]
  head = commit(head, stepped, 2, { turnKeys: ['p', 'p', 'p', 'p'], settled: ['p'] }).head
  expect(head.held.size).toBe(0)
  expect(head.owned.size).toBe(0)
  expect(head.window?.messages).toBe(stepped)
})

it('compares a page with the latest window, after appends and turn-only changes', () => {
  const work = calls('w', 0, 1)
  let { head } = commit(NO_HEAD_TRACK, [work], 0)
  const appended = [work, answer]
  head = commit(head, appended, 0).head
  expect(head.window?.messages).toBe(appended)
  const turns = ['q', 'q']
  head = commit(head, appended, 0, { turnKeys: turns }).head
  expect(head.window?.turnKeys).toBe(turns)
  const paged = [prompt, work, answer]
  head = commit(head, paged, 1, { turnKeys: ['p', 'p', 'p'], settled: ['p'] }).head
  expect([...head.held]).toEqual(['p'])
})

it('leaves a turn the reader folded folded when an older page lands', () => {
  const turn = [text('q', 'user', 'Look'), calls('x', 0, 0), text('qa', 'assistant', 'Seen.')]
  const turnKeys = ['q', 'q', 'q']
  // The reader had the turn open when the window was recorded, then folded it again.
  let { head } = commit(NO_HEAD_TRACK, turn, 0, {
    turnKeys,
    settled: ['q'],
    expanded: new Set(['q'])
  })
  head = commit(head, turn, 0, { turnKeys, settled: ['q'] }).head
  const paged = [text('z', 'user', 'Before'), text('za', 'assistant', 'Earlier.'), ...turn]
  head = commit(head, paged, 1, { turnKeys: ['z', 'z', ...turnKeys], settled: ['z', 'q'] }).head

  expect(head.held.size).toBe(0)
})

it('keeps the streamed fast path for a transcript with a kept id', () => {
  const saved = [calls('r0', 0, 7), text('reply', 'assistant', 'Working on')]
  const kept = {
    ...input(saved, [undefined, undefined], [], NO_TURNS),
    ownedRuns: new Map([['r6', { calls: ['c6', 'c7'] }]])
  }
  const { messages: _saved, ...structure } = kept
  const streamed = createNativeChatStreamedTranscript()
  const first = streamed(structure, saved, saved)
  const grown = [saved[0]!, text('reply', 'assistant', 'Working on it now')]
  const next = streamed(structure, saved, grown)

  const run = (slots: readonly NativeChatTranscriptSlot[]) =>
    slots.find((slot) => slot.kind === 'message' && slot.message.id === 'r0')
  expect(run(first.slots)).toMatchObject({ disclosureId: 'r6' })
  // Patched, not rebuilt: the slot keeping the id is the same object, and the frame its stage.
  expect(run(next.slots)).toBe(run(first.slots))
  expect(stageBesideStreamedText(next.slots)).not.toBe(next.slots)
})
