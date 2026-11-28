import type { BotToolProblem } from '../../../../../shared/bot-tools'

/**
 * What a check found that a Connectors row says over its sign-in, which stays as it is: signing in
 * can't fix a tool that won't start, or say whether one the check couldn't finish works. Null: the
 * sign-in (or the app's own line) speaks; a sign-in under way always does.
 */
export function botToolAppCheckFace(
  problem: BotToolProblem | undefined,
  signInStarted: boolean
): 'nameTaken' | 'wontStart' | 'unconfirmed' | null {
  if (signInStarted) {
    return null
  }
  if (problem?.kind === 'failed') {
    // Renaming the bot's tool fixes it, so the row offers that rather than another check.
    return problem.reason === 'nameTaken' ? 'nameTaken' : 'wontStart'
  }
  return problem?.kind === 'unconfirmed' && problem.detail ? 'unconfirmed' : null
}
