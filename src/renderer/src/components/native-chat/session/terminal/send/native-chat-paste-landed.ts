import { sanitizeBracketedPasteText } from '../../../../../../../shared/terminal/input/terminal-bracketed-paste-text'

/** How often Enter re-reads the input line while the paste is still arriving. */
export const NATIVE_CHAT_PASTE_LANDED_POLL_MS = 100
/** After this, Enter goes anyway, as it did before the check existed. */
export const NATIVE_CHAT_PASTE_LANDED_MAX_WAIT_MS = 5000

/** Read the agent's input line; '' when empty, null when unreadable or the reader throws. */
export function readNativeChatInputLine(
  readInputLine: (() => string | null | undefined) | undefined
): string | null {
  try {
    return readInputLine?.() ?? null
  } catch {
    return null
  }
}

// Placeholders agents draw for pasted text and images instead of the content.
const IMAGE_CHIP = /\[Image #\d+\]/g
const TEXT_PASTE_CHIP =
  /\[(?:Pasted text #\d+(?: \+\d+ lines)?|Pasted Content \d+ chars)\](?: #\d+)?/g

// Rows wrap long tokens with a line break, so compare without any whitespace.
const squash = (text: string): string => text.replace(/\s+/g, '')

/** Whether the line shows the whole message, given `expected` from nativeChatExpectedLine: its
 *  text, or a text-paste chip; image chips alone prove only an image-only send. */
export function nativeChatLineShowsMessage(line: string, expected: string): boolean {
  // An empty line counts only for an image-only send, at the old timing, for agents that draw no chip.
  if (!squash(line)) {
    return expected === ''
  }
  const withoutImages = line.replace(IMAGE_CHIP, '')
  const rest = squash(withoutImages.replace(TEXT_PASTE_CHIP, ''))
  if (rest !== squash(withoutImages)) {
    return rest === ''
  }
  // Claude draws a leading `!` as its bash-mode marker rather than as text.
  return rest === expected || (expected.startsWith('!') && rest === expected.slice(1))
}

/** The message as the line can show it, computed once per send. */
export function nativeChatExpectedLine(text: string): string {
  return squash(sanitizeBracketedPasteText(text))
}

/** Enter during a paste the agent is still reading joins it as a newline. The line was empty before
 *  the paste, so once it shows the whole message, unchanged across one re-read, the paste has landed. */
export function afterNativeChatPasteLands(args: {
  readInputLine: (() => string | null | undefined) | undefined
  lineWasEmpty: boolean
  /** The message text pasted after any image paths; '' for an image-only send. */
  text: string
  delay: (ms: number, fn: () => void) => void
  submit: () => void
}): void {
  const { readInputLine, lineWasEmpty, text, delay, submit } = args
  if (!readInputLine || !lineWasEmpty) {
    submit()
    return
  }
  const expected = nativeChatExpectedLine(text)
  // Wall clock, not poll count: a hidden window runs timers about once a second.
  const deadline = Date.now() + NATIVE_CHAT_PASTE_LANDED_MAX_WAIT_MS
  let previous: string | null = null
  const check = (): void => {
    const line = readNativeChatInputLine(readInputLine)
    if (
      line === null ||
      (line === previous && nativeChatLineShowsMessage(line, expected)) ||
      Date.now() >= deadline
    ) {
      submit()
      return
    }
    previous = line
    delay(NATIVE_CHAT_PASTE_LANDED_POLL_MS, check)
  }
  check()
}
