// The "GitHub" row under the signed-in Orca account: whether the person connected their own GitHub,
// so commits and pushes in cloud workspaces carry their name. A pure reducer; the hook drives it.
import type { HostedGithubUser } from '../../../../../../shared/hosted-sandbox/hosted-github-wire'

/** Re-check every few seconds while the browser OAuth is open, for at most five minutes. */
export const GITHUB_IDENTITY_POLL_MS = 3_000
export const GITHUB_IDENTITY_PENDING_MAX_MS = 5 * 60_000

export type GitHubIdentityState =
  /** Not read yet, or every read so far failed: the row stays hidden rather than guessing. */
  | { kind: 'unknown' }
  | { kind: 'disconnected' }
  /** Connect opened the browser; the row waits for status to say connected. */
  | { kind: 'pending' }
  | { kind: 'connected'; login: string; githubUserId: number }
  | { kind: 'error' }

export type GitHubIdentityEvent =
  | { type: 'status'; user: HostedGithubUser }
  | { type: 'connectStarted' }
  | { type: 'connectFailed' }
  /** The person chose Cancel while the browser was open. */
  | { type: 'cancel' }
  /** Five minutes in the browser without a connection. */
  | { type: 'pendingExpired' }
  | { type: 'disconnected' }

export const initialGitHubIdentityState: GitHubIdentityState = { kind: 'unknown' }

export function gitHubIdentityReducer(
  state: GitHubIdentityState,
  event: GitHubIdentityEvent
): GitHubIdentityState {
  switch (event.type) {
    case 'status':
      if (event.user.connected) {
        return { kind: 'connected', login: event.user.login, githubUserId: event.user.githubUserId }
      }
      // "Not connected yet" says nothing while the browser is still open, and doesn't clear an
      // error the person hasn't acted on.
      return state.kind === 'pending' || state.kind === 'error' ? state : { kind: 'disconnected' }
    case 'connectStarted':
      return { kind: 'pending' }
    case 'connectFailed':
    case 'pendingExpired':
      return state.kind === 'pending' ? { kind: 'error' } : state
    case 'cancel':
      return state.kind === 'pending' ? { kind: 'disconnected' } : state
    case 'disconnected':
      return { kind: 'disconnected' }
  }
}
