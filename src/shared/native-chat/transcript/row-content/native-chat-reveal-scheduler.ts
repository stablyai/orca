// Pace streaming replies' reveal steps on the display's frames, within one share of the thread.

import type { NativeChatTextRevealFrames } from './native-chat-text-reveal'

/** Until the display's own frames are measured, assume 60 Hz. */
const FRAME_MS = 1000 / 60
const MIN_FRAME_MS = 1000 / 240
const MAX_FRAME_MS = 1000 / 30
/** Recent frame gaps the display period is read from. */
const FRAME_GAP_SAMPLES = 15

/** The display's frame period: the lower quartile of recent gaps, so steps and long frames don't
 *  raise it and a lone fast double-frame doesn't lower it. */
function displayFramePeriod(gaps: readonly number[]): number {
  if (gaps.length < 3) {
    return FRAME_MS
  }
  const sorted = [...gaps].sort((a, b) => a - b)
  const quartile = sorted[Math.floor(sorted.length / 4)]!
  return Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, quartile))
}

/** Recent steps whose render cost sets the spacing; their median, so one slow step doesn't. */
const STEP_COST_SAMPLES = 3

function medianStepCost(costs: readonly number[]): number {
  const sorted = [...costs].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}
/** A step this slow redraws the whole reply (footnotes, reference links, raw HTML re-parse it all),
 *  so it costs more than the update a save would make, and stepping it only lengthens each wait. */
export const NATIVE_CHAT_WHOLE_REDRAW_STEP_MS = 100
/** A wait longer than this many frames sleeps on a timer instead of asking for every frame. */
const PARK_FRAMES = 2
/** Hidden windows get no animation frames, so a timer steps them a little after each step is due. */
const HIDDEN_STEP_MS = 100

type RevealRow = {
  stepCosts: number[]
  redrawsWhole: boolean
  steppedAt: number
  waiting?: { id: number; step: () => void }
}

/** One clock for every revealing reply in a window, the standard way to pace many animations: one
 *  frame loop steps at most one reply a frame, so steps never pile into one long frame, and each
 *  reply's spacing splits the busy share across all replies waiting to step. Returns each reply's
 *  frames. */
export function createNativeChatRevealScheduler(
  stepMs: number,
  busyShare = 1,
  /** Input is waiting to be handled: a frame with input waiting steps no reply, so typing goes first. */
  inputPending: () => boolean = () => false
): () => NativeChatTextRevealFrames {
  // Replies with a step waiting; a reply between reveals costs the others nothing.
  const waiting = new Set<RevealRow>()
  let lastFrame: number | undefined
  const gaps: number[] = []
  let period = FRAME_MS
  let nextId = 0
  let frame: number | undefined
  let park: ReturnType<typeof setTimeout> | undefined
  let hidden: ReturnType<typeof setTimeout> | undefined
  // No ceiling: replies that render slowly together take no more than one share of the thread.
  const spacing = (): number => {
    let cost = 0
    for (const row of waiting) {
      cost += medianStepCost(row.stepCosts)
    }
    return Math.max(stepMs, cost / busyShare)
  }
  const nextRow = (): RevealRow | undefined => {
    let next: RevealRow | undefined
    for (const row of waiting) {
      if (!next || row.steppedAt < next.steppedAt) {
        next = row
      }
    }
    return next
  }
  const fire = (row: RevealRow, at: number): void => {
    const step = row.waiting!.step
    row.waiting = undefined
    waiting.delete(row)
    // Callbacks ahead of this one in the frame may have run long; spacing counts from now.
    row.steppedAt = Math.max(at, performance.now())
    step()
  }
  const schedule = (from: number): void => {
    clearTimeout(park)
    clearTimeout(hidden)
    park = undefined
    hidden = undefined
    const row = nextRow()
    if (!row) {
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
        frame = undefined
      }
      lastFrame = undefined
      return
    }
    const due = row.steppedAt + spacing()
    // A hidden window has no frames; its replies still step, a little later.
    hidden = setTimeout(
      () => {
        hidden = undefined
        const next = nextRow()
        if (next) {
          fire(next, performance.now())
        }
        schedule(performance.now())
      },
      Math.max(0, due - from) + HIDDEN_STEP_MS
    )
    if (frame !== undefined) {
      return
    }
    // Frames between steps are only waited through: a long wait sleeps until a frame before the step.
    // Waking two frames early leaves a gap between frames to keep reading the display's rate.
    if (due - from > (PARK_FRAMES + 1) * period) {
      lastFrame = undefined
      park = setTimeout(
        () => {
          park = undefined
          frame = requestAnimationFrame(onFrame)
        },
        due - from - PARK_FRAMES * period
      )
      return
    }
    frame = requestAnimationFrame(onFrame)
  }
  const onFrame = (frameStart: number): void => {
    frame = undefined
    // A gap past two of the slowest frames is a restart after idling, not the display's rate.
    if (lastFrame !== undefined && frameStart - lastFrame <= 2 * MAX_FRAME_MS) {
      gaps.push(frameStart - lastFrame)
      if (gaps.length > FRAME_GAP_SAMPLES) {
        gaps.shift()
      }
      period = displayFramePeriod(gaps)
    }
    lastFrame = frameStart
    // The first frame at or after a step's time, so no step comes sooner than its spacing.
    const row = nextRow()
    if (row && frameStart >= row.steppedAt + spacing() && !inputPending()) {
      fire(row, frameStart)
    }
    schedule(performance.now())
  }
  return () => {
    const row: RevealRow = { stepCosts: [], redrawsWhole: false, steppedAt: -Infinity }
    return {
      now: () => performance.now(),
      stepCost: (ms) => {
        row.stepCosts.push(Math.max(0, ms))
        if (row.stepCosts.length > STEP_COST_SAMPLES) {
          row.stepCosts.shift()
        }
        // Once over the line the reply stays there, so it doesn't switch back and forth.
        row.redrawsWhole ||=
          row.stepCosts.length === STEP_COST_SAMPLES &&
          medianStepCost(row.stepCosts) > NATIVE_CHAT_WHOLE_REDRAW_STEP_MS
      },
      redrawsWhole: () => row.redrawsWhole,
      request: (step) => {
        const id = ++nextId
        row.waiting = { id, step }
        waiting.add(row)
        schedule(performance.now())
        return id
      },
      cancel: (id) => {
        if (row.waiting?.id === id) {
          row.waiting = undefined
          waiting.delete(row)
          schedule(performance.now())
        }
      }
    }
  }
}

/** One reply's frames on a clock of its own. */
export function nativeChatRevealStepFrames(
  stepMs: number,
  busyShare = 1
): NativeChatTextRevealFrames {
  return createNativeChatRevealScheduler(stepMs, busyShare)()
}
