import { isSpacelessScriptChar } from '@/components/sidebar/comment-markdown-word-fade'

export const NATIVE_CHAT_TEXT_REVEAL_DELAY_MS = 350

type TextArrival = { from: number; to: number; at: number }

export type NativeChatTextReveal = {
  source: string
  shown: number
  arrivals: TextArrival[]
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
