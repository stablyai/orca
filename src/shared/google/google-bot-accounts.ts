// Which of the Google accounts signed in on its host a bot may use. Google on with no list is every
// account, now and later: bots saved before accounts could be chosen, and older clients' --on.
import type { Bot } from '../bot-types'

export type BotGoogleAccess =
  | { kind: 'off' }
  | { kind: 'all' }
  | { kind: 'some'; accounts: readonly string[] }

export function botGoogleAccess(bot: Pick<Bot, 'google' | 'googleAccounts'>): BotGoogleAccess {
  if (bot.google !== true) {
    return { kind: 'off' }
  }
  return bot.googleAccounts === undefined
    ? { kind: 'all' }
    : { kind: 'some', accounts: bot.googleAccounts.map((email) => email.toLowerCase()) }
}

export function botMayUseGoogleAccount(access: BotGoogleAccess, email: string): boolean {
  return (
    access.kind === 'all' ||
    (access.kind === 'some' && access.accounts.includes(email.toLowerCase()))
  )
}

/** The account a call without --account uses: the computer's default if the bot may use it, else
 *  the first account chosen for it. */
export function botDefaultGoogleAccount(
  access: BotGoogleAccess,
  computerDefault: string | null
): string | null {
  if (access.kind === 'off') {
    return null
  }
  if (
    access.kind === 'all' ||
    (computerDefault && botMayUseGoogleAccount(access, computerDefault))
  ) {
    return computerDefault?.toLowerCase() ?? null
  }
  return access.accounts[0] ?? null
}

/** Refusal text for an account outside the bot's list. */
export function googleAccountNotAllowed(
  botName: string,
  email: string,
  access: Extract<BotGoogleAccess, { kind: 'some' }>
): string {
  return `${botName} can't use ${email}. Its Google accounts: ${access.accounts.join(', ')}. Ask your owner to add it in Orca.`
}
