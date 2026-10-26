// One transport-neutral layout.subscribe client for local/paired main. Caller owns read-only cache; this client stores no layout.

import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import {
  isKnownWorkspaceLayoutFrameType,
  readWorkspaceLayoutFramePosition,
  readWorkspaceLayoutStreamFrame,
  type WorkspaceLayoutChangeFrame,
  type WorkspaceLayoutStreamFrame
} from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'
import { exposeLocalLayoutStreamE2EEnd } from './local-layout-stream-e2e-end'

/** `lost`: the stream ended without a refusal and the client stopped. `refused`: the host answered
 *  that it will never serve this stream, so the client stopped. */
export type RuntimeLayoutStreamStatus =
  | { state: 'connecting' | 'live' | 'lost' | 'closed' }
  | { state: 'refused'; code: string }

// An older host without the method, or a caller scope denied it: a retry gets the same answer.
const REFUSAL_CODES = ['method_not_found', 'forbidden'] as const

/** First wait before a lost stream reopens; it doubles to the cap until a snapshot comes. */
const REOPEN_DELAY_MS = 1_000
const REOPEN_DELAY_CAP_MS = 30_000
/** Immediate resubscribes allowed before a frame applies cleanly; then the loss path's backoff. */
const RESYNC_BUDGET = 3

/**
 * Opens the stream; `onFrame` gets a snapshot first, then that stream's changes. A lost stream
 * reports `lost`, then reopens after a backoff, and its snapshot replaces what the caller holds.
 *
 * A live stream that misses a frame resubscribes at once for a fresh snapshot: a records frame of
 * another epoch or out of sequence, an unreadable frame, or one `onFrame` cannot apply.
 */
export function subscribeRuntimeLayout(
  target: RuntimeClientTarget,
  params: { workspaces?: 'all' | string[] },
  onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
  onStatus: (status: RuntimeLayoutStreamStatus) => void,
  /** Each frame's stream position, a skipped frame's too: a reply may name any frame. A frame
   *  that sends the stream back for a snapshot reports none; the snapshot's position covers it. */
  onPosition?: (seq: number) => void
): { close: () => void } {
  // Bumped whenever a stream is given up, so its late callbacks change nothing.
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let state: RuntimeLayoutStreamStatus['state'] = 'connecting'
  let reopenTimer: ReturnType<typeof setTimeout> | null = null
  let reopenDelay = REOPEN_DELAY_MS
  /** The snapshot's epoch and the last position this stream applied, once a host sends epochs. */
  let epoch: string | undefined
  let lastSeq: number | undefined
  /** Resubscribes since a records frame last applied cleanly. */
  let resyncs = 0
  /** The budget ran out: until a records frame applies cleanly, snapshots keep the backoff. */
  let storm = false

  const setStatus = (status: RuntimeLayoutStreamStatus): void => {
    state = status.state
    onStatus(status)
  }

  const release = (): void => {
    generation += 1
    handle?.unsubscribe()
    handle = null
  }

  const stop = (status: RuntimeLayoutStreamStatus): void => {
    release()
    setStatus(status)
  }

  const lose = (streamGeneration: number, error?: unknown): void => {
    if (streamGeneration !== generation) {
      return
    }
    if (error !== undefined) {
      console.warn('[workspace-layout] layout stream lost:', error)
    }
    const refusal = REFUSAL_CODES.find((code) => hasRuntimeRpcErrorCode(error, code))
    stop(refusal ? { state: 'refused', code: refusal } : { state: 'lost' })
    // Main still accepts layout.apply during stream loss; resubscribe or local changes stay invisible until relaunch (paired changes until reconnect).
    if (!refusal) {
      reopenTimer = setTimeout(() => {
        reopenTimer = null
        void open()
      }, reopenDelay)
      reopenDelay = Math.min(reopenDelay * 2, REOPEN_DELAY_CAP_MS)
    }
  }

  // Before the snapshot the host itself is suspect, so the loss path's backoff applies.
  const resync = (streamGeneration: number, reason: unknown): void => {
    if (streamGeneration !== generation) {
      return
    }
    // A frame that fails every time must not resubscribe without limit.
    if (state !== 'live' || resyncs >= RESYNC_BUDGET) {
      storm ||= resyncs >= RESYNC_BUDGET
      lose(streamGeneration, reason)
      return
    }
    resyncs += 1
    console.warn('[workspace-layout] layout stream resubscribes:', reason)
    release()
    void open()
  }

  const receive = (streamGeneration: number, value: unknown): void => {
    if (streamGeneration !== generation) {
      return
    }
    if (import.meta.env.MODE === 'e2e' && target.kind === 'local') {
      exposeLocalLayoutStreamE2EEnd(value)
    }
    const seq = readWorkspaceLayoutFramePosition(value)
    try {
      const frame = readWorkspaceLayoutStreamFrame(value)
      // A newer host's frame type is skipped; a malformed frame of a known type lost a change.
      if (frame || isKnownWorkspaceLayoutFrameType(value)) {
        deliver(streamGeneration, frame)
      } else if (
        state === 'live' &&
        seq !== undefined &&
        lastSeq !== undefined &&
        seq === lastSeq + 1
      ) {
        // A skipped frame still holds its position, so the next one is no gap.
        lastSeq = seq
      }
    } finally {
      if (seq !== undefined && streamGeneration === generation) {
        onPosition?.(seq)
      }
    }
  }

  const deliver = (streamGeneration: number, frame: WorkspaceLayoutStreamFrame | null): void => {
    if (!frame) {
      resync(streamGeneration, new Error('unreadable layout frame'))
      return
    }
    if (frame.type === 'end') {
      lose(streamGeneration)
      return
    }
    if (frame.type === 'snapshot') {
      // During a resync storm the backoff keeps growing; a snapshot alone proves nothing.
      if (!storm) {
        reopenDelay = REOPEN_DELAY_MS
      }
      epoch = frame.epoch
      lastSeq = frame.seq
      setStatus({ state: 'live' })
    } else if (state !== 'live') {
      // The host sends the snapshot first; a change before it has nothing to replace.
      return
    } else if (frame.type === 'records') {
      if (frame.epoch !== epoch || lastSeq === undefined || frame.seq !== lastSeq + 1) {
        resync(streamGeneration, new Error(`layout frame ${frame.seq} after ${lastSeq ?? 'none'}`))
        return
      }
      lastSeq = frame.seq
      try {
        onFrame(frame)
      } catch (error) {
        resync(streamGeneration, error)
        return
      }
      resyncs = 0
      if (storm) {
        storm = false
        reopenDelay = REOPEN_DELAY_MS
      }
      return
    }
    onFrame(frame)
  }

  const open = async (): Promise<void> => {
    const streamGeneration = ++generation
    setStatus({ state: 'connecting' })
    try {
      const opened = await subscribeRuntimeRpc(target, 'layout.subscribe', params, {
        onEvent: (result) => receive(streamGeneration, result),
        onError: (error) => lose(streamGeneration, error),
        onClose: () => lose(streamGeneration)
      })
      if (streamGeneration !== generation) {
        opened.unsubscribe()
        return
      }
      handle = opened
    } catch (error) {
      lose(streamGeneration, error)
    }
  }

  void open()
  return {
    close: () => {
      if (reopenTimer) {
        clearTimeout(reopenTimer)
        reopenTimer = null
        stop({ state: 'closed' })
      } else if (state === 'connecting' || state === 'live') {
        stop({ state: 'closed' })
      }
    }
  }
}
