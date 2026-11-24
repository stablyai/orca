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
  /** The save revision such a reply's text is from, so a remount takes any save made since. */
  savedAt?: number
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
function keptMode(
  previous: NativeChatTextReveal
): Pick<NativeChatTextReveal, 'drawsWhole' | 'savedAt'> {
  return previous.drawsWhole ? { drawsWhole: true, savedAt: previous.savedAt } : {}
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

/** A reply shown only at its saves spreads each save over the gap since the one before, up to this,
 *  so its text keeps moving between saves rather than jumping and then waiting for the next. */
const MAX_SAVE_REVEAL_MS = 8000
/** Such a reply redraws whole, so each save is drawn in this many steps, as many as a save's reveal
 *  on every frame takes on a slow machine, spaced across the gap instead of back to back. */
const SAVE_REVEAL_STEPS = 2

export function nativeChatSaveRevealMs(gap: number | undefined): number | undefined {
  return gap === undefined
    ? undefined
    : Math.min(MAX_SAVE_REVEAL_MS, Math.max(NATIVE_CHAT_TEXT_REVEAL_DELAY_MS, gap))
}

/** The least time between drawn steps of a reply shown at its saves. */
export function nativeChatSaveStepMs(gap: number | undefined): number {
  return (nativeChatSaveRevealMs(gap) ?? 0) / SAVE_REVEAL_STEPS
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
  // A reply shown only at its saves resumes its save's reveal; newer live text waits for a save.
  if (remembered?.drawsWhole && streaming && text.startsWith(remembered.source)) {
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
  /** False when the step was not taken. */
  step: (next: NativeChatTextReveal) => boolean | void,
  frames: NativeChatTextRevealFrames,
  revealMs = NATIVE_CHAT_TEXT_REVEAL_DELAY_MS
): () => void {
  const tick = (): void => {
    const next = advanceNativeChatText(current(), frames.now(), revealMs)
    // A step not taken leaves the reveal where it was, so it is asked again.
    if (step(next) === false || next.shown < next.source.length) {
      frame = frames.request(tick)
    }
  }
  let frame = frames.request(tick)
  return () => frames.cancel(frame)
}
