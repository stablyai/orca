import { classifyTerminalProcessInspectionFailure } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

// Why: the host ends a flow nobody asked about for 90s, so retrying a lost answer longer is moot.
export const HOST_SIGN_IN_RETRY_WINDOW_MS = 80_000
const RETRY_DELAY_MS = 2_000

/** Only a lost answer is worth asking again; a refusal or a re-paired server is final. */
export function isLostHostAnswer(error: unknown): boolean {
  const reason = classifyTerminalProcessInspectionFailure(error)
  return reason === 'timeout' || reason === 'transport_loss'
}

/** Runs `request`, asking again after lost answers until the retry window closes. */
export async function retryLostAnswers<T>(
  request: () => Promise<T>,
  windowMs = HOST_SIGN_IN_RETRY_WINDOW_MS
): Promise<T> {
  const giveUpAt = Date.now() + windowMs
  for (;;) {
    try {
      return await request()
    } catch (error) {
      if (!isLostHostAnswer(error) || Date.now() >= giveUpAt) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}
