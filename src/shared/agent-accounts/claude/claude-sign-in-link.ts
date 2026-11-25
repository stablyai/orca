export const CLAUDE_SIGN_IN_FAILED_MESSAGE = 'Claude sign-in failed. Please try again.'

/** Whether Orca can catch the sign-in link: Claude's own host runs a POSIX shell for BROWSER. */
export function canCopyClaudeSignInLink(
  hostIsWindows: boolean,
  runtime: 'host' | 'wsl' | undefined
): boolean {
  // Why: Claude spawns BROWSER without a shell, and Windows has no sh script to point it at.
  return runtime === 'wsl' || !hostIsWindows
}
