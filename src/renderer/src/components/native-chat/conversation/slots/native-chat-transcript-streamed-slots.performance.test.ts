import { expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import * as slotsModule from './native-chat-transcript-slots'
import { noteRevisedInPlace } from '../../../../../../shared/agent-session/view/revised-in-place-lists'
import { stageBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { buildNativeChatTranscript } from './native-chat-transcript-slots'
import {
  nativeChatSlotIndexOf,
  splitNativeChatSlotsWaitingBehindLiveTurn
} from './native-chat-transcript-slot-selection'
import {
  createNativeChatStreamedTranscript,
  withStreamedRows
} from './native-chat-transcript-streamed-slots'

const message = (id: string, role: 'user' | 'assistant', text: string): NativeChatMessage => ({
  id,
  role,
  blocks: [{ type: 'text', text }],
  timestamp: 1,
  source: 'transcript'
})

function inputFor(rows: readonly NativeChatMessage[]) {
  return {
    turnKeys: rows.map((_, index) => `turn-${Math.floor(index / 2)}`),
    liveTurnKey: `turn-${Math.floor((rows.length - 1) / 2)}`,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set<string>(),
    isWorking: true,
    lifecycleWorking: true
  }
}

const transcript = (rows: readonly NativeChatMessage[]) =>
  buildNativeChatTranscript({ ...inputFor(rows), messages: rows })

function history(): NativeChatMessage[] {
  const rows: NativeChatMessage[] = []
  for (let turn = 0; turn < 200; turn++) {
    rows.push(message(`ask-${turn}`, 'user', `Question ${turn}`))
    rows.push(message(`answer-${turn}`, 'assistant', `Answer ${turn}`))
  }
  return rows
}

const withReply = (rows: readonly NativeChatMessage[], text: string) => [
  ...rows.slice(0, -1),
  message('answer-199', 'assistant', text)
]

// Perf contract: a live window that only grows a reply keeps every other slot as built, so the
// transcript is not rebuilt across its whole history; the reply's slot carries its newest text.
it('swaps only the streaming row into slots built from the saved rows', () => {
  const saved = history()
  const { slots } = transcript(saved)
  // More lines, so the reply's height estimate must move with it.
  const current = withReply(saved, 'Answer 199\nand more\nof it')
  const streamed = withStreamedRows(slots, saved, current)!
  expect(streamed.filter((slot, index) => slot !== slots[index])).toHaveLength(1)
  expect(streamed.at(-1)).toMatchObject({
    kind: 'message',
    message: { blocks: [{ text: 'Answer 199\nand more\nof it' }] }
  })
  const fields = (slot: (typeof slots)[number]) => ({ ...slot, message: undefined })
  expect(streamed.map(fields)).toEqual(transcript(current).slots.map(fields))

  // A reply's first words change what its slot draws, so the transcript is built again.
  const empty = withReply(saved, ' ')
  expect(withStreamedRows(transcript(empty).slots, empty, current)).toBeNull()
})

it('patches from a full build its streamed rows needed, instead of building every window', () => {
  const saved = withReply(history(), ' ')
  const input = inputFor(saved)
  const project = createNativeChatStreamedTranscript()
  project(input, saved, saved)
  // First words: built in full once.
  const first = project(input, saved, withReply(saved, 'The reply'))
  const later = project(input, saved, withReply(saved, 'The reply, and more of it'))
  expect(later.slots.filter((slot, index) => slot !== first.slots[index])).toHaveLength(1)
})

function workingRun(thought: string): NativeChatMessage[] {
  const call = (id: string): NativeChatMessage => ({
    id,
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Read', input: { path: id } }],
    timestamp: 1,
    source: 'transcript'
  })
  const thinking = (id: string, text: string): NativeChatMessage => ({
    id,
    role: 'reasoning',
    state: 'running',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  })
  return [
    ...history(),
    message('ask-live', 'user', 'Look around'),
    call('call-1'),
    thinking('thought-1', 'First'),
    call('call-2'),
    thinking('thought-2', thought)
  ]
}

const withThought = (rows: readonly NativeChatMessage[], text: string): NativeChatMessage[] => [
  ...rows.slice(0, -1),
  { ...rows.at(-1)!, blocks: [{ type: 'text', text }] }
]

it('patches only the run slot while a thought streams inside a work run', () => {
  const saved = workingRun('Thinking')
  const input = {
    ...inputFor(saved),
    turnKeys: saved.map((_, index) => (index >= 400 ? 'turn-live' : `turn-${index >> 1}`)),
    liveTurnKey: 'turn-live'
  }
  const builds = vi.spyOn(slotsModule, 'buildNativeChatTranscript')
  const project = createNativeChatStreamedTranscript()
  const first = project(input, saved, saved)
  const run = first.slots.at(-1)
  expect(run).toMatchObject({ kind: 'message' })
  expect(run?.kind === 'message' ? run.workRun?.map((row) => row.id) : []).toEqual([
    'call-1',
    'thought-1',
    'call-2',
    'thought-2'
  ])
  let previous = first
  let text = 'Thinking'
  for (let window = 0; window < 20; window++) {
    text += ` step ${window}`
    const next = project(input, saved, withThought(saved, text))
    expect(next.slots.filter((slot, index) => slot !== previous.slots[index])).toHaveLength(1)
    previous = next
  }
  expect(builds).toHaveBeenCalledTimes(1)
  const last = previous.slots.at(-1)
  expect(last?.kind === 'message' ? last.workRun?.at(-1)?.blocks : []).toEqual([
    { type: 'text', text }
  ])
  expect(last?.estimatedHeight).toBe(run?.estimatedHeight)
  // The thought ending regroups the run, so it builds again.
  const ended = withThought(saved, text)
  project(input, saved, [...ended.slice(0, -1), { ...ended.at(-1)!, state: 'completed' }])
  expect(builds).toHaveBeenCalledTimes(2)
  builds.mockRestore()
})

it('caps a settled reply whose controls stay in flow as a full build does', () => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, line) => `Line ${line}`).join('\n')
  const saved = withReply(history(), lines(72))
  const settled = { ...inputFor(saved), isWorking: false, lifecycleWorking: false }
  const build = (rows: readonly NativeChatMessage[]) =>
    buildNativeChatTranscript({ ...settled, messages: rows }).slots
  const current = withReply(saved, lines(73))
  const streamed = withStreamedRows(build(saved), saved, current)!
  expect(build(current).at(-1)?.estimatedHeight).toBe(1600)
  expect(streamed.at(-1)?.estimatedHeight).toBe(1600)
})

it('builds again when a capped estimate cannot tell whether controls were in flow', () => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, line) => `Line ${line}`).join('\n')
  const saved = withReply(history(), lines(73))
  const settled = { ...inputFor(saved), isWorking: false, lifecycleWorking: false }
  const build = (rows: readonly NativeChatMessage[]) =>
    buildNativeChatTranscript({ ...settled, messages: rows }).slots
  // Text-only revisions may shrink a reply, not only grow it.
  expect(withStreamedRows(build(saved), saved, withReply(saved, lines(72)))).toBeNull()
})

let fieldReads = 0

/** A history row that counts reads of the fields every slot pass reads. */
function counted(row: NativeChatMessage): NativeChatMessage {
  const { id, role } = row
  return Object.defineProperties(
    { ...row },
    {
      id: { get: () => (fieldReads++, id), enumerable: true },
      role: { get: () => (fieldReads++, role), enumerable: true }
    }
  )
}

function historyOf(turns: number): NativeChatMessage[] {
  const rows: NativeChatMessage[] = []
  for (let turn = 0; turn < turns; turn++) {
    rows.push(counted(message(`ask-${turn}`, 'user', `Question ${turn}`)))
    rows.push(counted(message(`answer-${turn}`, 'assistant', `Answer ${turn}`)))
  }
  return rows
}

/** Row reads the last 19 of a stream of 20 windows make, each revising the previous window's last row in place,
 *  through the slots, the waiting split and a row lookup. */
function rowReadsStreaming(turns: number): { reads: number; keysHeld: boolean } {
  const saved = historyOf(turns)
  const input = {
    ...inputFor(saved),
    turnKeys: saved.map((_, index) => `turn-${index >> 1}`),
    liveTurnKey: `turn-${turns - 1}`
  }
  const project = createNativeChatStreamedTranscript()
  const built = project(input, saved, saved).slots
  let previous: readonly NativeChatMessage[] = saved
  let raw = saved
  let reads = 0
  let keysHeld = true
  const lookedUp = `ask-${turns - 1}`
  splitNativeChatSlotsWaitingBehindLiveTurn(built, undefined)
  nativeChatSlotIndexOf(built, lookedUp)
  fieldReads = 0
  let text = `Answer ${turns - 1}`
  for (let window = 0; window < 20; window++) {
    text += ` and more ${window}`
    const next = [...raw.slice(0, -1), message(`answer-${turns - 1}`, 'assistant', text)]
    const countedRows = new Proxy(next, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads++
        }
        return Reflect.get(target, key, receiver)
      }
    })
    noteRevisedInPlace(countedRows, previous, [next.length - 1])
    const { slots } = project(input, saved, countedRows)
    const split = splitNativeChatSlotsWaitingBehindLiveTurn(slots, undefined)
    keysHeld &&= stageBesideStreamedText(split.slots) === built
    keysHeld &&= nativeChatSlotIndexOf(split.slots, lookedUp) === built.length - 2
    previous = countedRows
    raw = next
    // The first window indexes the built slots, once per build; later windows reuse it.
    if (window === 0) {
      reads = 0
      fieldReads = 0
    }
  }
  return { reads: reads + fieldReads, keysHeld }
}

// Perf contract: a live window visits only the rows it revised, so its cost does not grow with
// history: its slots stay linked to the built ones that key, marker, timed-row and rail readers
// kept, and the waiting split and row lookups answer from what they found for those.
it('visits only revised rows each window, at any history length', () => {
  const small = rowReadsStreaming(200)
  const large = rowReadsStreaming(2000)
  expect(small.keysHeld).toBe(true)
  expect(large.keysHeld).toBe(true)
  expect(large.reads).toBe(small.reads)
  expect(large.reads).toBeLessThan(200)
})
