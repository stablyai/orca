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

/** Enter during a paste the agent is still reading joins it as a newline. The line was empty before
 *  the paste, so once it shows text that stopped changing, the paste has landed. */
export function afterNativeChatPasteLands(args: {
  readInputLine: (() => string | null | undefined) | undefined
  lineWasEmpty: boolean
  delay: (ms: number, fn: () => void) => void
  submit: () => void
}): void {
  const { readInputLine, lineWasEmpty, delay, submit } = args
  if (!readInputLine || !lineWasEmpty) {
    submit()
    return
  }
  let previous: string | null = null
  let waitedMs = 0
  const check = (): void => {
    const line = readNativeChatInputLine(readInputLine)
    if (
      line === null ||
      (line !== '' && line === previous) ||
      waitedMs >= NATIVE_CHAT_PASTE_LANDED_MAX_WAIT_MS
    ) {
      submit()
      return
    }
    previous = line
    waitedMs += NATIVE_CHAT_PASTE_LANDED_POLL_MS
    delay(NATIVE_CHAT_PASTE_LANDED_POLL_MS, check)
  }
  check()
}
