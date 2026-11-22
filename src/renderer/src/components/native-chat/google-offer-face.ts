// Which Google Connect card a bot's `--offer google` shows, from the host's Google and the bot's toggle.
import type { GoogleStatusView } from '../../../../shared/google/google-connect-types'
import { googleBotConnectState } from '../../../../shared/google/google-bot-connect-state'

export type GoogleOfferFace =
  /** No account here yet (or a host too old to keep a default): one Connect button. */
  | { kind: 'connect' }
  /** An account is here: use the default, or sign in to another; a signed-out default reconnects. */
  | { kind: 'choose'; defaultAccount: string; reconnect: boolean }
  /** On for the bot; `canAdd` once the host keeps a default. */
  | { kind: 'connected'; defaultAccount: string | null; canAdd: boolean }

export function googleOfferFace(
  google: Pick<GoogleStatusView, 'client' | 'accounts' | 'defaultAccount'>,
  allowed: boolean
): GoogleOfferFace {
  const { host } = googleBotConnectState({
    allowed,
    client: google.client,
    accounts: google.accounts
  })
  const defaultAccount = google.defaultAccount
  if (allowed && host === 'connected') {
    return {
      kind: 'connected',
      defaultAccount: defaultAccount ?? null,
      canAdd: defaultAccount !== undefined
    }
  }
  const fallback = google.accounts.find((account) => account.email === defaultAccount)
  // An old host keeps no default, so a second account there would break its calls: today's card.
  if (!fallback || (host !== 'connected' && host !== 'reconnect')) {
    return { kind: 'connect' }
  }
  return {
    kind: 'choose',
    defaultAccount: fallback.email,
    reconnect: fallback.status === 'reconnect'
  }
}
