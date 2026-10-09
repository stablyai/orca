export const CLAUDE_SIGN_IN_FAILED_MESSAGE = 'Claude sign-in failed. Please try again.'
const CLAUDE_AUTHORIZE_HOSTS = new Set(['claude.com', 'claude.ai'])
const LOCAL_CALLBACK_HOSTS = new Set(['localhost', '127.0.0.1'])

/** Whether Orca can catch the sign-in link: Claude's own host runs a POSIX shell for BROWSER. */
export function canCopyClaudeSignInLink(
  hostIsWindows: boolean,
  runtime: 'host' | 'wsl' | undefined
): boolean {
  // Why: Claude spawns BROWSER without a shell, and Windows has no sh script to point it at.
  return runtime === 'wsl' || !hostIsWindows
}

/** A Claude sign-in link that finishes on this computer: claude.com's authorize page calling
 *  back to localhost, never the pasted-code link Claude prints. */
export function isClaudeLocalSignInLink(link: string): boolean {
  let url: URL
  let redirect: URL
  try {
    url = new URL(link)
    redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    CLAUDE_AUTHORIZE_HOSTS.has(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.pathname.endsWith('/oauth/authorize') &&
    redirect.protocol === 'http:' &&
    LOCAL_CALLBACK_HOSTS.has(redirect.hostname) &&
    redirect.pathname === '/callback'
  )
}
