// How far this window has read a layout stream (design phase E): a `layout.apply` reply names
// the stream position holding its effect, and its outcome is shown once that frame is in, not
// after a timer. One position per stream: this window's own main's, and each paired server's
// (keyed by environment id), since a reply names a position in the stream of the main that sent it.

import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

type Waiter = { seq: number; run: () => void }

type StreamPosition = {
  /** Null while no sequenced stream is open: nothing is coming to wait for. */
  position: number | null
  /** 'none' before the stream opens; 'coming' from then, even before its first frame. */
  stream: 'none' | 'coming' | 'ended'
  /** The publishing process's stream identity: a restarted main counts its positions anew. */
  epoch?: string
  waiters: Waiter[]
}

/** This window's own main's stream. */
export const LOCAL_LAYOUT_STREAM = 'local'

/** Whose positions a target's stream feeds: this window's main's, or one server's. */
export function layoutFramePositionKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? LOCAL_LAYOUT_STREAM : target.environmentId
}

const streams = new Map<string, StreamPosition>()

function streamOf(key: string): StreamPosition {
  let entry = streams.get(key)
  if (!entry) {
    entry = { position: null, stream: 'none', waiters: [] }
    streams.set(key, entry)
  }
  return entry
}

function release(entry: StreamPosition, ready: (waiter: Waiter) => boolean): void {
  const due = entry.waiters.filter(ready)
  if (due.length === 0) {
    return
  }
  entry.waiters = entry.waiters.filter((waiter) => !ready(waiter))
  for (const waiter of due) {
    try {
      waiter.run()
    } catch (error) {
      console.warn('[layout-owner] frame waiter threw:', error)
    }
  }
}

/** A frame came in; `seq` is absent from a host older than frame positions. */
export function noteLayoutFramePosition(
  seq: number | undefined,
  key: string = LOCAL_LAYOUT_STREAM
): void {
  if (seq === undefined) {
    return
  }
  const entry = streamOf(key)
  entry.stream = 'coming'
  entry.position = entry.position === null ? seq : Math.max(entry.position, seq)
  const reached = entry.position
  release(entry, (waiter) => waiter.seq <= reached)
}

/** A frame's stream identity. A new one (the main restarted) starts its positions over, and a
 *  reply waiting on the old one shows now: its position will never come. */
export function noteLayoutFrameEpoch(
  epoch: string | undefined,
  key: string = LOCAL_LAYOUT_STREAM
): void {
  if (epoch === undefined) {
    return
  }
  const entry = streamOf(key)
  if (entry.epoch !== undefined && entry.epoch !== epoch) {
    entry.position = null
    release(entry, () => true)
  }
  entry.epoch = epoch
}

/** Whether main's frames will come: from when the window opens its stream until it ends. */
export function layoutFramesFlowing(key: string = LOCAL_LAYOUT_STREAM): boolean {
  return streams.get(key)?.stream === 'coming'
}

/** The window opened its stream: replies wait for its frames, even before the first. */
export function beginLayoutFramePositions(key: string = LOCAL_LAYOUT_STREAM): void {
  streamOf(key).stream = 'coming'
}

/** The stream ended: no frame will come, so every waiter runs now. */
export function endLayoutFramePositions(key: string = LOCAL_LAYOUT_STREAM): void {
  const entry = streamOf(key)
  entry.position = null
  entry.stream = 'ended'
  release(entry, () => true)
}

/**
 * Runs `run` once this window holds the frame at `seq`: at once when it already does, when the
 * reply names no position (an older host), or while no stream is coming. An opened stream is
 * coming before its first frame too, so the wait holds until that frame or its end.
 */
export function afterLayoutFrame(
  seq: number | undefined,
  run: () => void,
  key: string = LOCAL_LAYOUT_STREAM
): void {
  const entry = streams.get(key)
  if (
    seq === undefined ||
    entry?.stream !== 'coming' ||
    (entry.position !== null && entry.position >= seq)
  ) {
    run()
    return
  }
  entry.waiters.push({ seq, run })
}

export function _resetLayoutFramePositionForTests(): void {
  streams.clear()
}
