// A tool's sign-in as one face, for every surface on the desktop and the phone: the row's line and
// action come from this, each in the platform's own words.
import type { BotToolProblem } from '../bot-tools'
import type { BotToolSignInProblem, BotToolSignInStatus } from '../bot-tool-sign-in'

export type BotToolSignInFace =
  | 'signed-in'
  | 'needs-sign-in'
  | 'sign-in-again'
  | 'waiting'
  /** The returned code is being exchanged and stored on the bot's host. */
  | 'finishing'
  | 'unreachable'
  | 'unsupported'
  | 'interrupted'
  /** The bot's host runs an Orca that can't sign in for this device. */
  | 'update-needed'

/** The face of a tool's sign-in; null when it has none to show (a command, a public server). */
export function botToolSignInFace(
  tool: { signIn?: { state: BotToolSignInStatus['state']; problem?: BotToolSignInProblem } },
  problem: BotToolProblem | undefined,
  started: boolean,
  failure: string | undefined,
  finishing = false
): BotToolSignInFace | null {
  const signIn = tool.signIn
  if (!signIn) {
    // The agent's CLI signs in; its check reports a missing sign-in.
    return problem?.kind === 'sign-in' ? 'needs-sign-in' : null
  }
  if (started) {
    return finishing ? 'finishing' : 'waiting'
  }
  if (signIn.state === 'signed-in') {
    return 'signed-in'
  }
  if (failure === 'needs-update') {
    return 'update-needed'
  }
  if (failure === 'interrupted') {
    return 'interrupted'
  }
  // The host keeps why the last sign-in couldn't start; this device may know it a moment sooner.
  const stored =
    signIn.problem ??
    (failure === 'unsupported' ? 'unsupported' : failure === 'unavailable' ? 'unreachable' : null)
  return stored === 'unsupported'
    ? 'unsupported'
    : stored === 'unreachable'
      ? 'unreachable'
      : signIn.state === 'lost'
        ? 'sign-in-again'
        : 'needs-sign-in'
}
