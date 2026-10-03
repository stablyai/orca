// Host-published English copy; the renderer matches it to explain a refused launch (#9194).
export const CLAUDE_ACCOUNT_SIGN_IN_REQUIRED = 'Sign in again to use this account.'
/** The sign-in refusal with its next step, for surfaces that show host text as is. */
export const CLAUDE_ACCOUNT_SIGN_IN_REQUIRED_NEXT_STEP =
  'The selected Claude account needs you to sign in again. Open Settings > Accounts to sign in again, or choose System default.'
/** An identity refusal without its emails, for surfaces that only carry a typed reason. */
export const CLAUDE_ACCOUNT_LOGIN_CHANGED_NEXT_STEP =
  'The selected Claude account is now signed in to a different login. Open Settings > Accounts to sign in again, or choose System default.'
/** Ends every identity refusal, so the renderer explains it like the sign-in one. */
const CLAUDE_ACCOUNT_IDENTITY_REFUSAL_END = 'or remove this account.'

/** Why a row whose profile holds another login is refused; names both logins when they differ. */
export function describeClaudeAccountIdentityRefusal(
  issue: 'mismatch' | 'duplicate',
  account: { addedAs: string; signedInAs: string }
): string {
  const { addedAs, signedInAs } = account
  const sameEmail = !addedAs || addedAs.toLowerCase() === signedInAs.toLowerCase()
  if (issue === 'duplicate') {
    return sameEmail
      ? `${signedInAs} is already added as another account. Sign in again with a different account, ${CLAUDE_ACCOUNT_IDENTITY_REFUSAL_END}`
      : `This account was added as ${addedAs} but is now signed in as ${signedInAs}, which is already added as another account. Sign in again as ${addedAs}, ${CLAUDE_ACCOUNT_IDENTITY_REFUSAL_END}`
  }
  return sameEmail
    ? `This account is now signed in to a different organization. Sign in again to choose which one it uses, ${CLAUDE_ACCOUNT_IDENTITY_REFUSAL_END}`
    : `This account was added as ${addedAs} but is now signed in as ${signedInAs}. Sign in again to choose which account it uses, ${CLAUDE_ACCOUNT_IDENTITY_REFUSAL_END}`
}

/** The refusal a user can act on, or null for an unexplained failure. */
export function describeClaudeAccountLaunchRefusal(message: string): string | null {
  return message.includes(CLAUDE_ACCOUNT_SIGN_IN_REQUIRED)
    ? CLAUDE_ACCOUNT_SIGN_IN_REQUIRED_NEXT_STEP
    : isClaudeAccountLaunchRefusal(message)
      ? message
      : null
}

/** A Claude launch the host refused for the selected account, with its next step. */
export function isClaudeAccountLaunchRefusal(message: string): boolean {
  return (
    message.includes(CLAUDE_ACCOUNT_SIGN_IN_REQUIRED) ||
    message.includes(CLAUDE_ACCOUNT_IDENTITY_REFUSAL_END)
  )
}
