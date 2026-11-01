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
// Keep exits per lifetime: a late prior-owner exit cannot overwrite a newborn death before attach.
const preHandlerPtyExit = new Map<string, BufferedPreHandlerPtyExit[]>()
const consumedPreHandlerPtyExits = new Map<string, true>()
const discardedPreHandlerPtyStates = new Map<string, ReturnType<typeof setTimeout>>()
const DISCARDED_PRE_HANDLER_PTY_STATE_TTL_MS = 60_000

// Windows startup output can precede spawn reply/handler registration; buffer it rather than ACK and lose setup bytes.
const PRE_HANDLER_PTY_DATA_MAX_BYTES = 512 * 1024
const PRE_HANDLER_PTY_DATA_MAX_PTYS = 64
const PRE_HANDLER_PTY_EXIT_MAX_PTYS = 64
// Only outgoing/incoming lifetimes normally overlap before attach, keeping the exit bound small.
const PRE_HANDLER_PTY_EXIT_MAX_INCARNATIONS_PER_PTY = 4
// Pre-attach buffering should drain in milliseconds; sustained growth signals a lost handler and needs a trace breadcrumb.
const PRE_HANDLER_PTY_DATA_WARN_BYTES = 64 * 1024
const warnedLostHandlerPtyIds = new Set<string>()

// Sequence records around spawn requests because relay IDs are reused; pre-request state belongs to an earlier lifetime.
let preHandlerPtySequence = 0

function nextPreHandlerPtySequence(): number {
  preHandlerPtySequence += 1
  return preHandlerPtySequence
}

export function currentPreHandlerPtySequence(): number {
  return preHandlerPtySequence
}

/** Insertion order evicts the oldest admitted ID; return it so parallel keyed state can be released too. */
function evictOldestPtyIfAtCap<V>(map: Map<string, V>, ptyId: string, cap: number): string | null {
  if (map.has(ptyId) || map.size < cap) {
    return null
  }
  const oldestPtyId = map.keys().next().value
  if (typeof oldestPtyId === 'string') {
    map.delete(oldestPtyId)
    return oldestPtyId
  }
  return null
}

/** Reject positively foreign exit incarnations regardless of arrival time; sequence fences cannot catch late old-owner exits. Missing incarnation remains unknown for older hosts and reattach. */
export function discardPreHandlerPtyExitFromForeignIncarnation(
  ptyId: string,
  incarnationId: unknown
): void {
  // Only well-formed incarnation IDs supply evidence; malformed IDs remain unknown.
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
  const evictedPtyId = evictOldestPtyIfAtCap(
    preHandlerPtyData,
    ptyId,
    PRE_HANDLER_PTY_DATA_MAX_PTYS
  )
  if (evictedPtyId !== null) {
    // The warn breadcrumb describes buffered bytes that no longer exist.
    warnedLostHandlerPtyIds.delete(evictedPtyId)
  }
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
  // Maintain total bytes and a head index so many small lost-handler chunks cannot cause quadratic scans/shifts.
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
  // Replace duplicates within their lifetime; unnamed exits keep the single legacy slot.
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

/** Drop pre-request state inherited from recycled IDs; retain post-request startup races. Sequence remains necessary for bytes and legacy/synthetic exits lacking incarnation evidence. */
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
  // New lifetime admission clears old consumed-exit marks so they cannot suppress this shell’s own death.
  clearConsumedPreHandlerPtyExit(ptyId)
}

// Retain bounded exit tombstones so duplicate IPC exits cannot replay to future mounts or grow pre-handler state.
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

// Same-ID live reconnect re-admits exits without discarding its still-valid buffered output.
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

// Removed worktrees have no consumers; suppress delayed kill data/exits until explicit same-ID reconnection.
export function discardPreHandlerPtyState(ptyId: string): void {
  consumePreHandlerPtyState(ptyId)
  const priorTimer = discardedPreHandlerPtyStates.get(ptyId)
  if (priorTimer) {
    clearTimeout(priorTimer)
  }
  // Time retention covers delayed kills from worktrees larger than the bounded maps without permanent growth.
  const timer = setTimeout(
    () => discardedPreHandlerPtyStates.delete(ptyId),
    DISCARDED_PRE_HANDLER_PTY_STATE_TTL_MS
  )
  discardedPreHandlerPtyStates.set(ptyId, timer)
}

/** Filter every exit read by positive incarnation disagreement; callers without lifetime evidence retain unknown records. */
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
  // Select the newest admissible lifetime record to preserve last-write-wins behavior.
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
    // Draining transfers exit ownership despite handler throws; duplicates cannot become new pre-handler events.
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
