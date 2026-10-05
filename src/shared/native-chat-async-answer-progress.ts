// Where a sent async answer stands, read from the transport record that carries it (a terminal
// echo, an outbox entry, a journal submission), so every client derives the card's hold the
// same way and never stores it.

/** Answers a transport already holds durably, by question key: still on their way
 *  (`sendingKeys`) or back after a delivery that didn't happen. Re-derived each render from
 *  that transport's own records, so the card neither stores nor latches them. */
export type NativeChatAsyncAnswerProgress = {
  answers: Readonly<Record<string, string>>
  sendingKeys: ReadonlySet<string>
}

/** One transport record of a sent answer: the answers it carries, and whether it still holds
 *  them (on its way) or gives them back (its delivery failed). */
export type NativeChatAsyncAnswerRecord = {
  answers: Readonly<Record<string, string>>
  holding: boolean
}

/** Oldest first, so the newest answer to a question decides it. */
export function nativeChatAsyncAnswerProgress(
  records: Iterable<NativeChatAsyncAnswerRecord>
): NativeChatAsyncAnswerProgress {
  const answers: Record<string, string> = {}
  const sendingKeys = new Set<string>()
  for (const record of records) {
    for (const [key, answer] of Object.entries(record.answers)) {
      answers[key] = answer
      if (record.holding) {
        sendingKeys.add(key)
      } else {
        sendingKeys.delete(key)
      }
    }
  }
  return { answers, sendingKeys }
}

/**
 * Whether a terminal answer echo still holds its answers, given the user rows the agent recorded
 * after the send (normalized like `text`, harness machinery left out). Its own row and the rows of
 * sends queued ahead of it are expected; any other row means the agent consumed input past this
 * send without recording its text (Codex filed the paste as one question's reply, or dropped it),
 * so no row will ever release it and its answers go back to the card.
 */
export function nativeChatAsyncAnswerEchoHolding(
  echo: { text: string; queuedAhead?: readonly string[] },
  rowsAfterSend: readonly string[]
): boolean {
  const unclaimed = [...(echo.queuedAhead ?? [])]
  return rowsAfterSend.every((row) => {
    if (row === echo.text) {
      return true
    }
    const ahead = unclaimed.indexOf(row)
    if (ahead === -1) {
      return false
    }
    unclaimed.splice(ahead, 1)
    return true
  })
}
