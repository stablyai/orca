import { toast } from 'sonner'
import type { BotRef } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botGoogleAccess,
  botMayUseGoogleAccount
} from '../../../../../shared/google/google-bot-accounts'
import { botErrorMessage } from '../bot-presentation'
import { withGoogleAccount } from './google-account-choice'
import { setBotGoogle } from './set-bot-google'

/**
 * An account signed in for the bot becomes the bot's too: Google turns on with it (through
 * `turnOn`, which confirms first), or it joins the bot's list. False when that didn't happen.
 */
export async function giveBotGoogleAccount<
  T extends BotRef & Pick<Bot, 'google' | 'googleAccounts'>
>(
  bot: T,
  email: string,
  turnOn: (bot: T, accounts: readonly string[]) => Promise<boolean>
): Promise<boolean> {
  const access = botGoogleAccess(bot)
  if (access.kind === 'off') {
    return turnOn(bot, [email])
  }
  if (access.kind === 'all' || botMayUseGoogleAccount(access, email)) {
    return true
  }
  return setBotGoogle(bot, true, { accounts: withGoogleAccount(access.accounts, email) }).then(
    () => true,
    (error: unknown) => {
      toast.error(botErrorMessage(error))
      return false
    }
  )
}
