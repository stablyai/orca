// The accounts ticked in a bot's Google account picker: where a pick starts, and what saving it sends.
import type { Bot } from '../../../../../shared/bot-types'
import { botGoogleAccess } from '../../../../../shared/google/google-bot-accounts'
import type { GoogleAccountView } from '../../../../../shared/google/google-connect-types'

/**
 * Ticked when the picker opens: the bot's own accounts (every one, for a bot that has them all), or
 * for a bot without Google, this computer's default. `added`, an account just signed in, joins them.
 */
export function initialGoogleAccountChoice(
  bot: Pick<Bot, 'google' | 'googleAccounts'>,
  accounts: readonly Pick<GoogleAccountView, 'email'>[],
  defaultAccount: string | null,
  added?: string
): string[] {
  const access = botGoogleAccess(bot)
  const emails = accounts.map((account) => account.email.toLowerCase())
  const chosen =
    access.kind === 'all'
      ? emails
      : access.kind === 'some'
        ? emails.filter((email) => access.accounts.includes(email))
        : emails.filter((email) => email === googleDefaultOrFirst(emails, defaultAccount))
  return added ? withGoogleAccount(chosen, added) : chosen
}

/** The computer's default when it is still here, else the first account. */
function googleDefaultOrFirst(
  emails: readonly string[],
  defaultAccount: string | null
): string | undefined {
  const fallback = defaultAccount?.toLowerCase()
  return fallback && emails.includes(fallback) ? fallback : emails[0]
}

export function withGoogleAccount(chosen: readonly string[], email: string): string[] {
  const key = email.toLowerCase()
  return chosen.includes(key) ? [...chosen] : [...chosen, key]
}

export function toggleGoogleAccount(chosen: readonly string[], email: string): string[] {
  const key = email.toLowerCase()
  return chosen.includes(key) ? chosen.filter((entry) => entry !== key) : [...chosen, key]
}

/** What saving sends: nothing ticked takes Google off the bot. */
export function googleAccountChoiceSave(
  chosen: readonly string[]
): { on: false } | { on: true; accounts: string[] } {
  return chosen.length === 0 ? { on: false } : { on: true, accounts: [...chosen] }
}
