// Which step "Add to GitHub" shows, from the cloud's state and the connect trip.
import type { BotGitHubView } from '@/lib/bot-github-state'
import type { ConnectorConnectView } from '@/lib/connector-connect-state'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'

/** Each step follows from the cloud's state and the connect trip. */
export type BotGitHubSetupStep =
  | { kind: 'checking' }
  | { kind: 'failed'; code: string }
  | { kind: 'connect'; error: string | null }
  | { kind: 'waiting' }
  /** Signed in, no installation yet: `requested` when an organization owner must approve it. */
  | { kind: 'install'; login: string; installUrl: string; requested: boolean }
  | {
      kind: 'turn-on'
      login: string
      installations: ConnectorGitHubInstallation[]
      installUrl: string
    }
  | {
      kind: 'done'
      login: string
      installations: ConnectorGitHubInstallation[]
      installUrl: string
      /** Adding another login didn't finish. */
      error: string | null
    }

/** `on`: the bot is already turned on for GitHub, so setup ends once the account is linked and installed. */
export function botGitHubSetupStep(
  view: BotGitHubView,
  connect: ConnectorConnectView,
  on: boolean
): BotGitHubSetupStep {
  if (connect.status === 'waiting') {
    return { kind: 'waiting' }
  }
  if (view.status === 'loading') {
    return { kind: 'checking' }
  }
  if (view.status !== 'ready') {
    return { kind: 'failed', code: view.status === 'off' ? 'github_off' : view.error }
  }
  const { account, installations, installUrl } = view.github
  if (!account) {
    return { kind: 'connect', error: connect.status === 'failed' ? connect.error : null }
  }
  if (installations.length === 0) {
    const requested = connect.status === 'linked' && connect.link.install === 'requested'
    return { kind: 'install', login: account.login, installUrl, requested }
  }
  return on
    ? {
        kind: 'done',
        login: account.login,
        installations,
        installUrl,
        error: connect.status === 'failed' ? connect.error : null
      }
    : { kind: 'turn-on', login: account.login, installations, installUrl }
}
