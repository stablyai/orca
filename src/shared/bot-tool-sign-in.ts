// Orca's own sign-in to a bot's app, as a client sees it: state only, never a token or a URL query.

/** A tool row's sign-in. Present only on tools Orca signs in to; any other tool has none. */
export type BotToolSignInStatus =
  /** `limited`: the app gave no refresh token, so it works until its token expires. */
  | { state: 'signed-in'; limited: boolean }
  | { state: 'signed-out'; problem?: BotToolSignInProblem }
  /** The app refused the stored sign-in: "Sign in again". */
  | { state: 'lost'; problem?: BotToolSignInProblem }

/** Why the last sign-in couldn't start, kept until the next one: "This app isn't supported yet" or "Can't reach". */
export type BotToolSignInProblem = 'unsupported' | 'unreachable'

/** What an address needs, from discovery (Add by URL). */
export type BotToolAuthKind =
  /** It answered MCP without a sign-in and names no authorization server. */
  | 'none'
  /** Orca signs in to it. */
  | 'oauth'
  /** It needs a sign-in Orca can't make yet (no dynamic registration). */
  | 'unsupported'
  /** No answer to decide on; try again. */
  | 'unavailable'

export type BotToolSignInFailure =
  | 'no-tool'
  | 'unsupported'
  | 'unavailable'
  | 'expired'
  | 'cancelled'
  | 'denied'
  | 'issuer-mismatch'
  | 'refused'
  | 'superseded'
  /** Started from a phone or the web: v1 signs in only from Orca on the bot's computer. */
  | 'desktop-only'

/** A Connect in progress, as `bots.tools.signInStatus` reports it. */
export type BotToolSignInProgress =
  | { state: 'idle' }
  /** The browser is open at `authorizationOrigin`; `expiresAt` is epoch ms. */
  | { state: 'waiting'; attemptId: string; authorizationOrigin: string; expiresAt: number }
  | { state: 'done' }
  | { state: 'failed'; code: BotToolSignInFailure }

/**
 * A sign-in the bot's host runs for another device (`bots.tools.signIn.*`), as only that device sees
 * it: the device opens `authorizationUrl` itself and sends back the query its browser returned to
 * `redirectUri`. `revision` grows with each change, for `wait`.
 */
export type BotToolSignInAttemptView = {
  flowId: string
  revision: number
  expiresAt: number
} & (
  | { state: 'waiting'; authorizationUrl: string; redirectUri: string }
  /** The returned code is being exchanged and stored. */
  | { state: 'finishing' }
  | { state: 'done' }
  | { state: 'failed'; code: BotToolSignInFailure }
)

/** A failure in the host's words; `host` names the computer running the bot. */
export function botToolSignInFailureWords(code: BotToolSignInFailure, host: string): string {
  switch (code) {
    case 'unsupported':
      return 'This app isn’t supported yet.'
    case 'unavailable':
      return 'Can’t reach this app. Check the address, then try again.'
    case 'no-tool':
      return 'This bot no longer has that tool.'
    case 'desktop-only':
      return `Sign in from Orca on ${host}.`
    case 'denied':
      return 'Access wasn’t allowed.'
    case 'expired':
      return 'The sign-in expired. Try again.'
    case 'cancelled':
    case 'issuer-mismatch':
    case 'refused':
    case 'superseded':
      return 'Couldn’t sign in. Try again.'
  }
}

/**
 * Checks an address pasted after a host-run sign-in against the attempt before it is sent: the
 * attempt's return address and state, no userinfo, fragment or repeated parameter. Answers the query
 * to send, or null. The host checks again; this only catches a wrong paste early.
 */
export function botToolSignInPastedQuery(
  pasted: string,
  attempt: { authorizationUrl: string; redirectUri: string }
): string | null {
  let address: URL
  let expected: URL
  let state: string | null
  try {
    address = new URL(pasted.trim())
    expected = new URL(attempt.redirectUri)
    state = new URL(attempt.authorizationUrl).searchParams.get('state')
  } catch {
    return null
  }
  const names = [...address.searchParams.keys()]
  const ok =
    address.protocol === expected.protocol &&
    address.host === expected.host &&
    address.pathname === expected.pathname &&
    !address.username &&
    !address.password &&
    !address.hash &&
    new Set(names).size === names.length &&
    state !== null &&
    address.searchParams.get('state') === state
  return ok ? address.search.slice(1) : null
}
