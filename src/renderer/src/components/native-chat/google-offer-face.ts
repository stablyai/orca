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
  const fallback = google.accounts.find((account) => account.email === defaultAccount)
  // A signed-out default still takes calls without --account, so even on for the bot it reconnects.
  if (allowed && host === 'connected' && fallback?.status !== 'reconnect') {
    return {
      kind: 'connected',
      defaultAccount: defaultAccount ?? null,
      canAdd: defaultAccount !== undefined
    }
  }
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

/**
 * How the card tells the chat about an account it just signed in: a first answer (`send`), a new
 * answer on a card that already named one (`again`; its one-time claim is spent), or nothing when the
 * account is the one the card already reads.
 */
export function googleOfferSignedInAnswer(
  email: string,
  card: { added: string | null; defaultAccount: string | null }
): 'send' | 'again' | null {
  if (card.added) {
    return email === card.added ? null : 'again'
  }
  return email === card.defaultAccount ? null : 'send'
}
