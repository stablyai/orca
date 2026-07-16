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
}

const preHandlerPtyData = new Map<string, BufferedPreHandlerPtyState>()
const preHandlerPtyExit = new Map<string, number>()
const consumedPreHandlerPtyExits = new Map<string, true>()
const discardedPreHandlerPtyStates = new Map<string, ReturnType<typeof setTimeout>>()
const DISCARDED_PRE_HANDLER_PTY_STATE_TTL_MS = 60_000

// Why: Windows startup commands can emit output before pty:spawn resolves and
// the pane registers its handler. Hold that tiny race window instead of ACKing
// and dropping the first setup-script bytes.
const PRE_HANDLER_PTY_DATA_MAX_BYTES = 512 * 1024
const PRE_HANDLER_PTY_DATA_MAX_PTYS = 64
const PRE_HANDLER_PTY_EXIT_MAX_PTYS = 64
// Why: legit pre-attach windows drain within milliseconds and hold little
// data. Sustained accumulation means a pane lost its data handler (the
// frozen-pane detach/attach race) — leave a breadcrumb for trace capture.
const PRE_HANDLER_PTY_DATA_WARN_BYTES = 64 * 1024
const warnedLostHandlerPtyIds = new Set<string>()

export function bufferPreHandlerPtyData(ptyId: string, data: string, meta?: PtyDataMeta): void {
  if (discardedPreHandlerPtyStates.has(ptyId)) {
    return
  }
  const chunk = clampUtf8Tail(data, PRE_HANDLER_PTY_DATA_MAX_BYTES)
  if (!chunk.data) {
    return
  }
  if (!preHandlerPtyData.has(ptyId) && preHandlerPtyData.size >= PRE_HANDLER_PTY_DATA_MAX_PTYS) {
    const oldestPtyId = preHandlerPtyData.keys().next().value
    if (typeof oldestPtyId === 'string') {
      preHandlerPtyData.delete(oldestPtyId)
    }
  }
  const bufferedMeta =
    meta && chunk.data.length !== data.length && typeof meta.rawLength === 'number'
      ? { ...meta, rawLength: chunk.bytes }
      : meta
  let state = preHandlerPtyData.get(ptyId)
  if (!state) {
    state = { chunks: [], head: 0, bytes: 0 }
    preHandlerPtyData.set(ptyId, state)
  }
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

export function bufferPreHandlerPtyExit(ptyId: string, code: number): void {
  if (consumedPreHandlerPtyExits.has(ptyId) || discardedPreHandlerPtyStates.has(ptyId)) {
    return
  }
  if (!preHandlerPtyExit.has(ptyId) && preHandlerPtyExit.size >= PRE_HANDLER_PTY_EXIT_MAX_PTYS) {
    const oldestPtyId = preHandlerPtyExit.keys().next().value
    if (typeof oldestPtyId === 'string') {
      preHandlerPtyExit.delete(oldestPtyId)
    }
  }
  preHandlerPtyExit.set(ptyId, code)
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

export function hasPreHandlerPtyExit(ptyId: string): boolean {
  return preHandlerPtyExit.has(ptyId)
}

export function drainPreHandlerPtyExit(ptyId: string, handler: (code: number) => void): void {
  const code = preHandlerPtyExit.get(ptyId)
  if (code === undefined) {
    return
  }
  preHandlerPtyExit.delete(ptyId)
  try {
    handler(code)
  } finally {
    // Why: draining transfers ownership to this handler. Even when it throws,
    // a duplicate exit must not become a new pre-handler event.
    consumePreHandlerPtyState(ptyId)
  }
}

export function clearPreHandlerPtyData(ptyId: string): void {
  preHandlerPtyData.delete(ptyId)
  warnedLostHandlerPtyIds.delete(ptyId)
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
