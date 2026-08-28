import { isPtyIncarnationId } from '../../../../shared/pty-incarnation'
import { clampUtf8Tail } from './pty-eager-buffer-clamp'
import type { PtyDataMeta } from './pty-dispatcher'

type BufferedPreHandlerPtyData = {
  data: string
  bytes: number
  meta?: PtyDataMeta
}

type BufferedPreHandlerPtyState = {
  chunks: BufferedPreHandlerPtyData[]
  head: number
  bytes: number
  /** Sequence of the newest chunk, used to fence state left by a prior incarnation of a reused id. */
  sequence: number
}

type BufferedPreHandlerPtyExit = {
  code: number
  sequence: number
  /** Which lifetime of `ptyId` died. Absent when the emitting host predates the field. */
  incarnationId?: string
}

const preHandlerPtyData = new Map<string, BufferedPreHandlerPtyState>()
// Why one record per lifetime and not one per id: a recycled id can have its previous lifetime's
// exit still in flight while the lifetime that just replaced it also dies pre-attach. With a single
// slot the late stranger overwrites the real exit, and the identity discard below then removes the
// only survivor — leaving a pane bound to a PTY that is dead and will never be reported dead.
const preHandlerPtyExit = new Map<string, BufferedPreHandlerPtyExit[]>()
const consumedPreHandlerPtyExits = new Map<string, true>()
const discardedPreHandlerPtyStates = new Map<string, ReturnType<typeof setTimeout>>()
const DISCARDED_PRE_HANDLER_PTY_STATE_TTL_MS = 60_000

// Why: Windows startup commands can emit output before pty:spawn resolves and
// the pane registers its handler. Hold that tiny race window instead of ACKing
// and dropping the first setup-script bytes.
const PRE_HANDLER_PTY_DATA_MAX_BYTES = 512 * 1024
const PRE_HANDLER_PTY_DATA_MAX_PTYS = 64
const PRE_HANDLER_PTY_EXIT_MAX_PTYS = 64
// Why small: only lifetimes racing the same pre-attach window can coexist, which in practice is the
// outgoing one and the incoming one.
const PRE_HANDLER_PTY_EXIT_MAX_INCARNATIONS_PER_PTY = 4
// Why: legit pre-attach windows drain within milliseconds and hold little
// data. Sustained accumulation means a pane lost its data handler (the
// frozen-pane detach/attach race) — leave a breadcrumb for trace capture.
const PRE_HANDLER_PTY_DATA_WARN_BYTES = 64 * 1024
const warnedLostHandlerPtyIds = new Set<string>()

// Why: pty ids are NOT unique over time — a redeployed SSH relay renumbers from pty-1, so a fresh
// spawn can be handed an id whose previous incarnation left buffered state here. A monotonic
// counter dates every record so a spawn can tell "arrived before I asked for this PTY" (someone
// else's) from "arrived while it was starting" (mine).
let preHandlerPtySequence = 0

function nextPreHandlerPtySequence(): number {
  preHandlerPtySequence += 1
  return preHandlerPtySequence
}

export function currentPreHandlerPtySequence(): number {
  return preHandlerPtySequence
}

/** Map preserves insertion order, so the first key is the least recently admitted id. */
function evictOldestPtyIfAtCap<V>(map: Map<string, V>, ptyId: string, cap: number): void {
  if (map.has(ptyId) || map.size < cap) {
    return
  }
  const oldestPtyId = map.keys().next().value
  if (typeof oldestPtyId === 'string') {
    map.delete(oldestPtyId)
  }
}

/** Drop a buffered exit proven to describe a different lifetime of `ptyId` than the one now
 *  attaching, whenever it arrived.
 *
 *  Why identity and not the sequence fence below: a fence is a clock, so it can only reject records
 *  dated before the spawn request left the renderer. An exit from the id's previous owner that
 *  arrives AFTER that — a relay that restarted mid-spawn and flushed it late — passes the fence and
 *  reports a brand-new shell as already dead. The incarnation says whose lifetime the exit
 *  describes, so it settles that case on evidence rather than timing.
 *
 *  Only a positive disagreement discards: both sides must name an incarnation. Absence is
 *  "unknown", never a mismatch, so an execution host that predates the field keeps the fence's
 *  behaviour exactly. Safe on a reattach and a cold restore too — those deliberately re-own an
 *  existing id, and re-owning incarnation X is still proof that W's exit was not theirs. */
export function discardPreHandlerPtyExitFromForeignIncarnation(
  ptyId: string,
  incarnationId: unknown
): void {
  // Why the shared guard and not a truthiness check: anything that is not a well-formed incarnation
  // is evidence of nothing, and must read as "unknown" rather than disagree with everything.
  if (!isPtyIncarnationId(incarnationId)) {
    return
  }
  retainPreHandlerPtyExits(
    ptyId,
    (exit) => exit.incarnationId === undefined || exit.incarnationId === incarnationId
  )
}

function retainPreHandlerPtyExits(
  ptyId: string,
  keep: (exit: BufferedPreHandlerPtyExit) => boolean
): void {
  const exits = preHandlerPtyExit.get(ptyId)
  if (!exits) {
    return
  }
  const kept = exits.filter(keep)
  if (kept.length === exits.length) {
    return
  }
  if (kept.length === 0) {
    preHandlerPtyExit.delete(ptyId)
    return
  }
  preHandlerPtyExit.set(ptyId, kept)
}

export function bufferPreHandlerPtyData(ptyId: string, data: string, meta?: PtyDataMeta): void {
  if (discardedPreHandlerPtyStates.has(ptyId)) {
    return
  }
  const chunk = clampUtf8Tail(data, PRE_HANDLER_PTY_DATA_MAX_BYTES)
  if (!chunk.data) {
    return
  }
  evictOldestPtyIfAtCap(preHandlerPtyData, ptyId, PRE_HANDLER_PTY_DATA_MAX_PTYS)
  const bufferedMeta =
    meta && chunk.data.length !== data.length && typeof meta.rawLength === 'number'
      ? { ...meta, rawLength: chunk.bytes }
      : meta
  let state = preHandlerPtyData.get(ptyId)
  if (!state) {
    state = { chunks: [], head: 0, bytes: 0, sequence: 0 }
    preHandlerPtyData.set(ptyId, state)
  }
  state.sequence = nextPreHandlerPtySequence()
  state.chunks.push({
    data: chunk.data,
    bytes: chunk.bytes,
    ...(bufferedMeta ? { meta: bufferedMeta } : {})
  })
  state.bytes += chunk.bytes
  // Why: a missing handler can accumulate many small chunks; a stored total
  // and head index keep that failure path linear instead of rescanning/shifting.
  while (state.bytes > PRE_HANDLER_PTY_DATA_MAX_BYTES && state.head < state.chunks.length - 1) {
    state.bytes -= state.chunks[state.head].bytes
    state.chunks[state.head] = { data: '', bytes: 0 }
    state.head += 1
  }
  if (state.head > 0 && state.head * 2 >= state.chunks.length) {
    state.chunks.splice(0, state.head)
    state.head = 0
  }
  if (state.bytes > PRE_HANDLER_PTY_DATA_WARN_BYTES && !warnedLostHandlerPtyIds.has(ptyId)) {
    warnedLostHandlerPtyIds.add(ptyId)
    console.warn(
      `[pty] ${ptyId}: ${state.bytes} bytes buffered with no registered data handler; ` +
        'the owning pane may have lost its handler to a detach/attach race'
    )
  }
}

export function drainPreHandlerPtyData(
  ptyId: string,
  handler: (data: string, meta?: PtyDataMeta) => void
): void {
  const state = preHandlerPtyData.get(ptyId)
  warnedLostHandlerPtyIds.delete(ptyId)
  if (!state) {
    return
  }
  preHandlerPtyData.delete(ptyId)
  for (let index = state.head; index < state.chunks.length; index += 1) {
    const chunk = state.chunks[index]
    handler(chunk.data, chunk.meta)
  }
}

/** Replay buffered startup bytes without taking them from the future primary handler. */
export function replayPreHandlerPtyData(ptyId: string, observer: (data: string) => void): void {
  const state = preHandlerPtyData.get(ptyId)
  if (!state) {
    return
  }
  for (let index = state.head; index < state.chunks.length; index += 1) {
    observer(state.chunks[index].data)
  }
}

export function bufferPreHandlerPtyExit(
  ptyId: string,
  code: number,
  incarnationId?: unknown
): void {
  if (consumedPreHandlerPtyExits.has(ptyId) || discardedPreHandlerPtyStates.has(ptyId)) {
    return
  }
  evictOldestPtyIfAtCap(preHandlerPtyExit, ptyId, PRE_HANDLER_PTY_EXIT_MAX_PTYS)
  const exit: BufferedPreHandlerPtyExit = {
    code,
    sequence: nextPreHandlerPtySequence(),
    // Record only a well-formed incarnation; a malformed one must not become evidence.
    ...(isPtyIncarnationId(incarnationId) ? { incarnationId } : {})
  }
  const exits = preHandlerPtyExit.get(ptyId)
  if (!exits) {
    preHandlerPtyExit.set(ptyId, [exit])
    return
  }
  // A duplicate exit for a lifetime replaces that lifetime's record rather than crowding out
  // another one's; unnamed records share the single `undefined` slot, as they did before.
  const sameLifetime = exits.findIndex((entry) => entry.incarnationId === exit.incarnationId)
  if (sameLifetime !== -1) {
    exits[sameLifetime] = exit
    return
  }
  exits.push(exit)
  if (exits.length > PRE_HANDLER_PTY_EXIT_MAX_INCARNATIONS_PER_PTY) {
    exits.shift()
  }
}

/** Drop pre-handler state a freshly spawned PTY inherited from an earlier owner of its id.
 *
 *  `fenceSequence` is read before the spawn request leaves the renderer, so anything at or below it
 *  was recorded when this PTY did not yet exist and cannot describe it. Bytes and exits recorded
 *  after the fence are kept: that is the real pre-attach race (a shell that dies instantly, or
 *  writes before the pane registers its handler) and losing it would blank a legitimate pane.
 *
 *  Still needed alongside `discardPreHandlerPtyExitFromForeignIncarnation`, which supersedes it
 *  wherever both sides name an incarnation. Two cases have none to compare and rest on the fence
 *  alone: buffered BYTES, because `pty:data` carries no incarnation at all; and exits from an
 *  execution host that predates the field or from a main-side path that synthesizes one without it
 *  (a relay dropping a stale PTY after a failed reattach sends `{ id, code: -1 }`). */
export function discardPreHandlerPtyStateFromPriorIncarnation(
  ptyId: string,
  fenceSequence: number
): void {
  retainPreHandlerPtyExits(ptyId, (exit) => exit.sequence > fenceSequence)
  const data = preHandlerPtyData.get(ptyId)
  if (data && data.sequence <= fenceSequence) {
    preHandlerPtyData.delete(ptyId)
    warnedLostHandlerPtyIds.delete(ptyId)
  }
  // Why: the id now names a different, live PTY, so a prior incarnation's consumed/discarded marks
  // must not suppress this one's own exit — the same admission boundary a same-id reattach gets.
  clearConsumedPreHandlerPtyExit(ptyId)
}

// Why: primary handlers and pane-less parked owners have fully handled this
// exit. Keep a bounded tombstone so duplicate IPC exits cannot be replayed to
// a future mount or accumulate in the pre-handler map.
export function consumePreHandlerPtyState(ptyId: string): void {
  clearPreHandlerPtyState(ptyId)
  consumedPreHandlerPtyExits.set(ptyId, true)
  if (consumedPreHandlerPtyExits.size > PRE_HANDLER_PTY_EXIT_MAX_PTYS) {
    const oldestPtyId = consumedPreHandlerPtyExits.keys().next().value
    if (typeof oldestPtyId === 'string') {
      consumedPreHandlerPtyExits.delete(oldestPtyId)
    }
  }
}

// Why: a deliberate reconnect can reuse a live session id after a prior
// incarnation's consumed-exit mark. Re-admit exits without discarding bytes
// already buffered for the still-live session.
export function clearConsumedPreHandlerPtyExit(ptyId: string): void {
  consumedPreHandlerPtyExits.delete(ptyId)
  const discardTimer = discardedPreHandlerPtyStates.get(ptyId)
  if (discardTimer) {
    clearTimeout(discardTimer)
  }
  discardedPreHandlerPtyStates.delete(ptyId)
}

export function isPreHandlerPtyStateDiscarded(ptyId: string): boolean {
  return discardedPreHandlerPtyStates.has(ptyId)
}

// Why: removed worktrees have no future pane consumer. Suppress both delayed
// kill data and exit until an explicit same-id reconnect establishes a new
// admission boundary.
export function discardPreHandlerPtyState(ptyId: string): void {
  consumePreHandlerPtyState(ptyId)
  const priorTimer = discardedPreHandlerPtyStates.get(ptyId)
  if (priorTimer) {
    clearTimeout(priorTimer)
  }
  // Why: a large worktree can remove more PTYs than the bounded data maps.
  // Time retention protects every delayed kill flush without permanent growth.
  const timer = setTimeout(
    () => discardedPreHandlerPtyStates.delete(ptyId),
    DISCARDED_PRE_HANDLER_PTY_STATE_TTL_MS
  )
  discardedPreHandlerPtyStates.set(ptyId, timer)
}

/** The records for `ptyId` that could describe `incarnationId`'s lifetime.
 *
 *  Every read of the exit buffer goes through here, so a record proven to belong to a different
 *  lifetime is unreachable BY CONSTRUCTION rather than because each caller remembered to discard
 *  first. A caller that cannot name an incarnation — a reattach that has not round-tripped yet —
 *  still sees everything, which is the honest answer: it holds no evidence to discriminate with. */
function admissiblePreHandlerPtyExits(
  ptyId: string,
  incarnationId: unknown
): BufferedPreHandlerPtyExit[] {
  const exits = preHandlerPtyExit.get(ptyId) ?? []
  if (!isPtyIncarnationId(incarnationId)) {
    return exits
  }
  return exits.filter(
    (exit) => exit.incarnationId === undefined || exit.incarnationId === incarnationId
  )
}

export function hasPreHandlerPtyExit(ptyId: string, incarnationId?: unknown): boolean {
  return admissiblePreHandlerPtyExits(ptyId, incarnationId).length > 0
}

export function drainPreHandlerPtyExit(
  ptyId: string,
  handler: (code: number) => void,
  incarnationId?: unknown
): void {
  // Newest admissible record: picking by sequence keeps the last-write-wins delivery a single-slot
  // buffer always had, now scoped to the lifetime actually asking.
  let exit: BufferedPreHandlerPtyExit | undefined
  for (const candidate of admissiblePreHandlerPtyExits(ptyId, incarnationId)) {
    if (!exit || candidate.sequence > exit.sequence) {
      exit = candidate
    }
  }
  if (exit === undefined) {
    return
  }
  preHandlerPtyExit.delete(ptyId)
  try {
    handler(exit.code)
  } finally {
    // Why: draining transfers ownership to this handler. Even when it throws,
    // a duplicate exit must not become a new pre-handler event.
    consumePreHandlerPtyState(ptyId)
  }
}

export function clearPreHandlerPtyState(ptyId: string): void {
  preHandlerPtyData.delete(ptyId)
  preHandlerPtyExit.delete(ptyId)
  consumedPreHandlerPtyExits.delete(ptyId)
  const discardTimer = discardedPreHandlerPtyStates.get(ptyId)
  if (discardTimer) {
    clearTimeout(discardTimer)
  }
  discardedPreHandlerPtyStates.delete(ptyId)
  warnedLostHandlerPtyIds.delete(ptyId)
}
