/** Whitespace-free script ranges used as character-sized reveal units. */
export const SPACELESS_SCRIPT_RANGES = String.raw`\u2e80-\ud7ff\uf900-\uffef`
const SPACELESS_SCRIPT_CHAR = new RegExp(`[${SPACELESS_SCRIPT_RANGES}]`, 'u')

/** Shared with whatever splits the drawn text into words, so both end words alike. */
export function isSpacelessScriptChar(char: string): boolean {
  return SPACELESS_SCRIPT_CHAR.test(char)
}

export const NATIVE_CHAT_TEXT_REVEAL_DELAY_MS = 350

type TextArrival = { from: number; to: number; at: number }

export type NativeChatTextReveal = {
  source: string
  shown: number
  arrivals: TextArrival[]
  /** The reply redraws whole each step, so for the rest of it, it shows only its saves, as main does. */
  drawsWhole?: true
}

/** The surface's frame clock; the reveal steps once a frame. */
export type NativeChatTextRevealFrames = {
  now: () => number
  request: (step: () => void) => number
  cancel: (frame: number) => void
  /** How long the last step took to render, timed by the surface around that render alone. */
  stepCost?: (ms: number) => void
  /** Whether this reply's steps have been slow enough to show it redrawn whole each step. */
  redrawsWhole?: () => boolean
}

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

/** A reveal frame clock that steps every `stepMs` on the first display frame at or after that
 *  time, and slower when a step is slow to render: the surface reports each
 *  step's own render time, and the median of the last few is kept to at most `busyShare` of the
 *  time between steps. Restarting a request keeps the spacing. */
export function nativeChatRevealStepFrames(
  stepMs: number,
  busyShare = 1
): NativeChatTextRevealFrames {
  let steppedAt = -Infinity
  let spacing = stepMs
  const stepCosts: number[] = []
  let redrawsWhole = false
  let lastFrame: number | undefined
  const gaps: number[] = []
  let period = FRAME_MS
  let nextId = 0
  const pending = new Map<
    number,
    { frame: number; park?: ReturnType<typeof setTimeout>; timer: ReturnType<typeof setTimeout> }
  >()
  const cancel = (id: number): void => {
    const waiting = pending.get(id)
    if (waiting) {
      cancelAnimationFrame(waiting.frame)
      clearTimeout(waiting.park)
      clearTimeout(waiting.timer)
      pending.delete(id)
    }
  }
  // Set as each step's cost arrives, so the very next step already waits for it.
  const respace = (): void => {
    // No ceiling: a reply that renders slowly takes no more than its share of the thread.
    spacing = Math.max(stepMs, medianStepCost(stepCosts) / busyShare)
  }
  return {
    now: () => performance.now(),
    stepCost: (ms) => {
      stepCosts.push(Math.max(0, ms))
      if (stepCosts.length > STEP_COST_SAMPLES) {
        stepCosts.shift()
      }
      // Once over the line the reply stays there, so it doesn't switch back and forth.
      redrawsWhole ||=
        stepCosts.length === STEP_COST_SAMPLES &&
        medianStepCost(stepCosts) > NATIVE_CHAT_WHOLE_REDRAW_STEP_MS
      respace()
    },
    redrawsWhole: () => redrawsWhole,
    request: (step) => {
      const id = ++nextId
      const fire = (at: number): void => {
        cancel(id)
        // Callbacks ahead of this one in the frame may have run long; spacing counts from now.
        steppedAt = Math.max(at, performance.now())
        step()
      }
      // Frames between steps are only waited through: a long wait sleeps until a frame before the step.
      const awaitFrame = (from: number): void => {
        const waiting = pending.get(id)!
        const due = steppedAt + spacing
        // Waking two frames early leaves a gap between frames to keep reading the display's rate.
        if (due - from > (PARK_FRAMES + 1) * period) {
          lastFrame = undefined
          waiting.park = setTimeout(
            () => {
              waiting.frame = requestAnimationFrame(onFrame)
            },
            due - from - PARK_FRAMES * period
          )
          return
        }
        waiting.frame = requestAnimationFrame(onFrame)
      }
      const onFrame = (frameStart: number): void => {
        // A gap past two of the slowest frames is a restart after idling, not the display's rate.
        if (lastFrame !== undefined && frameStart - lastFrame <= 2 * MAX_FRAME_MS) {
          gaps.push(frameStart - lastFrame)
          if (gaps.length > FRAME_GAP_SAMPLES) {
            gaps.shift()
          }
          period = displayFramePeriod(gaps)
        }
        lastFrame = frameStart
        // The first frame at or after the step's time, so no step comes sooner than its spacing.
        if (frameStart < steppedAt + spacing) {
          awaitFrame(frameStart)
          return
        }
        fire(frameStart)
      }
      const now = performance.now()
      pending.set(id, {
        frame: -1,
        timer: setTimeout(
          () => fire(performance.now()),
          Math.max(0, steppedAt + spacing - now) + HIDDEN_STEP_MS
        )
      })
      awaitFrame(now)
      return id
    },
    cancel
  }
}

function endsWord(char: string): boolean {
  return /\s/.test(char) || isSpacelessScriptChar(char)
}

export function pacedTextEnd(text: string, position: number, holdPartialWord: boolean): number {
  const from = Math.floor(position)
  if (from >= text.length) {
    return text.length
  }
  let end = from
  while (end < text.length && !endsWord(text[end])) {
    end += 1
  }
  if (end < text.length || !holdPartialWord) {
    return end
  }
  let start = from
  while (start > 0 && !endsWord(text[start - 1])) {
    start -= 1
  }
  return start
}

/** A reply redrawn whole stays so when its text is replaced. */
function keptMode(previous: NativeChatTextReveal): Pick<NativeChatTextReveal, 'drawsWhole'> {
  return previous.drawsWhole ? { drawsWhole: true } : {}
}

export function arriveNativeChatText(
  previous: NativeChatTextReveal,
  source: string,
  at: number
): NativeChatTextReveal {
  if (source === previous.source) {
    return previous
  }
  if (!source.startsWith(previous.source)) {
    return { ...keptMode(previous), source, shown: source.length, arrivals: [] }
  }
  return {
    ...previous,
    source,
    arrivals: [...previous.arrivals, { from: previous.source.length, to: source.length, at }]
  }
}

/** Each arrival has its own deadline; later arrivals can only bring earlier text forward. */
export function advanceNativeChatText(
  previous: NativeChatTextReveal,
  now: number,
  revealMs = NATIVE_CHAT_TEXT_REVEAL_DELAY_MS
): NativeChatTextReveal {
  let position = previous.arrivals[0]?.from ?? previous.shown
  let due = previous.shown
  for (const arrival of previous.arrivals) {
    const fraction = Math.min(1, Math.max(0, (now - arrival.at) / revealMs))
    position += (arrival.to - arrival.from) * fraction
    if (fraction === 1) {
      due = Math.max(due, arrival.to)
    }
  }
  const shown = Math.max(due, pacedTextEnd(previous.source, position, due < previous.source.length))
  return {
    ...previous,
    shown: Math.max(previous.shown, shown),
    arrivals: previous.arrivals.filter((arrival) => arrival.at + revealMs > now)
  }
}

/** Resume remembered reveal position on remount; begun marks replies first seen while the reader watched. */
export function startNativeChatTextReveal(
  text: string,
  streaming: boolean,
  remembered: NativeChatTextReveal | undefined,
  begun: boolean,
  now: number,
  revealMs = NATIVE_CHAT_TEXT_REVEAL_DELAY_MS
): NativeChatTextReveal {
  // Text received while unmounted has no arrival timestamp: show it without adding latency.
  if (remembered?.source === text && streaming) {
    return advanceNativeChatText(remembered, now, revealMs)
  }
  const shown = streaming && !remembered && begun ? 0 : text.length
  return arriveNativeChatText(
    {
      ...(remembered ? keptMode(remembered) : {}),
      source: text.slice(0, shown),
      shown,
      arrivals: []
    },
    text,
    now
  )
}

export function nativeChatTextAppended(previous: NativeChatTextReveal, text: string): boolean {
  return text.startsWith(previous.source) && text.length > previous.source.length
}

/** The reveal once the row's text or streaming state changes. */
export function receiveNativeChatText(
  previous: NativeChatTextReveal,
  text: string,
  streaming: boolean,
  reducedMotion: boolean,
  now: number,
  revealMs = NATIVE_CHAT_TEXT_REVEAL_DELAY_MS
): NativeChatTextReveal {
  const immediate =
    reducedMotion ||
    (!streaming &&
      !nativeChatTextAppended(previous, text) &&
      previous.shown === previous.source.length)
  return immediate
    ? { ...keptMode(previous), source: text, shown: text.length, arrivals: [] }
    : advanceNativeChatText(arriveNativeChatText(previous, text, now), now, revealMs)
}

/** Step each frame until complete and return cancellation. Deadline timers keep hidden windows on time when animation frames stop. */
export function playNativeChatTextReveal(
  current: () => NativeChatTextReveal,
  step: (next: NativeChatTextReveal) => void,
  frames: NativeChatTextRevealFrames,
  revealMs = NATIVE_CHAT_TEXT_REVEAL_DELAY_MS
): () => void {
  let frame = 0
  let deadline: ReturnType<typeof setTimeout> | undefined
  const tick = (): void => {
    frames.cancel(frame)
    clearTimeout(deadline)
    const now = frames.now()
    const next = advanceNativeChatText(current(), now, revealMs)
    step(next)
    if (next.shown >= next.source.length) {
      return
    }
    frame = frames.request(tick)
    const earliest = Math.min(...next.arrivals.map((arrival) => arrival.at + revealMs))
    deadline = setTimeout(tick, Math.max(0, earliest - now))
  }
  tick()
  return () => {
    frames.cancel(frame)
    clearTimeout(deadline)
  }
}

/** Steps only when a clock that spaces its own steps fires (see `nativeChatRevealStepFrames`). */
export function playNativeChatTextRevealOnClock(
  current: () => NativeChatTextReveal,
  step: (next: NativeChatTextReveal) => void,
  frames: NativeChatTextRevealFrames,
  revealMs = NATIVE_CHAT_TEXT_REVEAL_DELAY_MS
): () => void {
  const tick = (): void => {
    const next = advanceNativeChatText(current(), frames.now(), revealMs)
    step(next)
    if (next.shown < next.source.length) {
      frame = frames.request(tick)
    }
  }
  let frame = frames.request(tick)
  return () => frames.cancel(frame)
}
