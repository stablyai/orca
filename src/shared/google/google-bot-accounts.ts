// Which of the Google accounts signed in on its host a bot may use. Google on with no list is every
// account, now and later: bots saved before accounts could be chosen, and older clients' --on.
import type { Bot } from '../bot-types'

export type BotGoogleAccess =
  | { kind: 'off' }
  | { kind: 'all' }
  | { kind: 'some'; accounts: readonly string[] }

/** One account, however it was written: every comparison of Google emails goes through this. */
export function googleEmailKey(email: string): string {
  return email.trim().toLowerCase()
}

export function botGoogleAccess(bot: Pick<Bot, 'google' | 'googleAccounts'>): BotGoogleAccess {
  if (bot.google !== true) {
    return { kind: 'off' }
  }
  return bot.googleAccounts === undefined
    ? { kind: 'all' }
    : { kind: 'some', accounts: bot.googleAccounts.map(googleEmailKey) }
}

export function botMayUseGoogleAccount(access: BotGoogleAccess, email: string): boolean {
  return (
    access.kind === 'all' ||
    (access.kind === 'some' && access.accounts.includes(googleEmailKey(email)))
  )
}

/** Which host accounts a bot sees and checks: undefined (every one) for a bot with every account,
 *  else only its own (none while Google is off for it). */
export function botGoogleAccountFilter(
  access: BotGoogleAccess
): ((email: string) => boolean) | undefined {
  return access.kind === 'all' ? undefined : (email) => botMayUseGoogleAccount(access, email)
}

/** This computer's default as its host reads it: an account, none, or a saved pick it can't read. */
export type GoogleDefaultRead = { email: string | null } | { unreadable: string }

/**
 * The account a bot's calls and rules without --account use. The computer's default when the bot
 * may use it, else the first account chosen for it. An unreadable default leaves a bot with every
 * account, or several chosen, without one (as it does the owner); a bot with one chosen keeps it.
 */
export function botGoogleDefault(
  access: BotGoogleAccess,
  fallback: GoogleDefaultRead
): GoogleDefaultRead {
  if (access.kind === 'off') {
    return { email: null }
  }
  if (access.kind === 'all') {
    return 'unreadable' in fallback
      ? fallback
      : { email: fallback.email ? googleEmailKey(fallback.email) : null }
  }
  if ('unreadable' in fallback) {
    return access.accounts.length > 1 ? fallback : { email: access.accounts[0] ?? null }
  }
  return {
    email:
      fallback.email && botMayUseGoogleAccount(access, fallback.email)
        ? googleEmailKey(fallback.email)
        : (access.accounts[0] ?? null)
  }
}

/** botGoogleDefault, from a default that was read: the account, or null. */
export function botDefaultGoogleAccount(
  access: BotGoogleAccess,
  computerDefault: string | null
): string | null {
  const read = botGoogleDefault(access, { email: computerDefault })
  return 'email' in read ? read.email : null
}

/** Refusal text for an account outside the bot's list. */
export function googleAccountNotAllowed(
  botName: string,
  email: string,
  access: Extract<BotGoogleAccess, { kind: 'some' }>
): string {
  return access.accounts.length > 0
    ? `${botName} can't use ${email}. Its Google accounts: ${access.accounts.join(', ')}. Ask your owner to add it in Orca.`
    : `${botName} can't use ${email}: no Google accounts are chosen for ${botName}. Ask your owner to choose one in Orca.`
}
