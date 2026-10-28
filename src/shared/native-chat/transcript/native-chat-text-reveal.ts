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
}

/** The surface's frame clock; the reveal steps once a frame. */
export type NativeChatTextRevealFrames = {
  now: () => number
  request: (step: () => void) => number
  cancel: (frame: number) => void
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

export function arriveNativeChatText(
  previous: NativeChatTextReveal,
  source: string,
  at: number
): NativeChatTextReveal {
  if (source === previous.source) {
    return previous
  }
  if (!source.startsWith(previous.source)) {
    return { source, shown: source.length, arrivals: [] }
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
  now: number
): NativeChatTextReveal {
  let position = previous.arrivals[0]?.from ?? previous.shown
  let due = previous.shown
  for (const arrival of previous.arrivals) {
    const fraction = Math.min(1, Math.max(0, (now - arrival.at) / NATIVE_CHAT_TEXT_REVEAL_DELAY_MS))
    position += (arrival.to - arrival.from) * fraction
    if (fraction === 1) {
      due = Math.max(due, arrival.to)
    }
  }
  const shown = Math.max(due, pacedTextEnd(previous.source, position, due < previous.source.length))
  return {
    ...previous,
    shown: Math.max(previous.shown, shown),
    arrivals: previous.arrivals.filter(
      (arrival) => arrival.at + NATIVE_CHAT_TEXT_REVEAL_DELAY_MS > now
    )
  }
}

/** Resume remembered reveal position on remount; begun marks replies first seen while the reader watched. */
export function startNativeChatTextReveal(
  text: string,
  streaming: boolean,
  remembered: NativeChatTextReveal | undefined,
  begun: boolean,
  now: number
): NativeChatTextReveal {
  // Text received while unmounted has no arrival timestamp: show it without adding latency.
  if (remembered?.source === text && streaming) {
    return advanceNativeChatText(remembered, now)
  }
  const shown = streaming && !remembered && begun ? 0 : text.length
  return arriveNativeChatText({ source: text.slice(0, shown), shown, arrivals: [] }, text, now)
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
  now: number
): NativeChatTextReveal {
  const immediate =
    reducedMotion ||
    (!streaming &&
      !nativeChatTextAppended(previous, text) &&
      previous.shown === previous.source.length)
  return immediate
    ? { source: text, shown: text.length, arrivals: [] }
    : advanceNativeChatText(arriveNativeChatText(previous, text, now), now)
}

/** Step each frame until complete and return cancellation. Deadline timers keep hidden windows on time when animation frames stop. */
export function playNativeChatTextReveal(
  current: () => NativeChatTextReveal,
  step: (next: NativeChatTextReveal) => void,
  frames: NativeChatTextRevealFrames
): () => void {
  let frame = 0
  let deadline: ReturnType<typeof setTimeout> | undefined
  const tick = (): void => {
    frames.cancel(frame)
    clearTimeout(deadline)
    const now = frames.now()
    const next = advanceNativeChatText(current(), now)
    step(next)
    if (next.shown >= next.source.length) {
      return
    }
    frame = frames.request(tick)
    const earliest = Math.min(
      ...next.arrivals.map((arrival) => arrival.at + NATIVE_CHAT_TEXT_REVEAL_DELAY_MS)
    )
    deadline = setTimeout(tick, Math.max(0, earliest - now))
  }
  tick()
  return () => {
    frames.cancel(frame)
    clearTimeout(deadline)
  }
}
