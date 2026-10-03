/**
 * A Claude account row whose sign-in never finished: it holds no login yet. Orca records the
 * email only once Claude does, so this is the one test every surface uses.
 */
export function isUnfinishedClaudeSignIn(account: { email: string }): boolean {
  return !account.email
}
