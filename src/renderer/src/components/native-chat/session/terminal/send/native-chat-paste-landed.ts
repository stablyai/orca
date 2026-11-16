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
const PASTE_CHIPS =
  /\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+|Pasted Content \d+ chars)\](?: #\d+)?/g

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Whether the line shows the whole message: its exact text, or only the chips an agent draws for
 *  a paste, so a fragment of a paste still arriving never counts. */
export function nativeChatLineShowsMessage(line: string, text: string): boolean {
  const rest = collapse(line.replace(PASTE_CHIPS, ' '))
  return (
    rest === collapse(sanitizeBracketedPasteText(text)) || (rest === '' && rest !== collapse(line))
  )
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
  // Wall clock, not poll count: a hidden window runs timers about once a second.
  const deadline = Date.now() + NATIVE_CHAT_PASTE_LANDED_MAX_WAIT_MS
  let previous: string | null = null
  const check = (): void => {
    const line = readNativeChatInputLine(readInputLine)
    if (
      line === null ||
      (line === previous && nativeChatLineShowsMessage(line, text)) ||
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
