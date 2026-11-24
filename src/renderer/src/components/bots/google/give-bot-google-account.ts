import { toast } from 'sonner'
import { botHostTarget, type BotRef } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
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
 * `turnOn`, which confirms first), or it joins the bot's list. The grant is decided on the bot as
 * `readFresh` confirms it from its host now (a sign-in can take minutes); without that read nothing
 * is granted, since a list from before could undo changes made meanwhile. False when not granted.
 */
export async function giveBotGoogleAccount<
  T extends BotRef & Pick<Bot, 'google' | 'googleAccounts'>
>(
  stale: T,
  email: string,
  turnOn: (bot: T, accounts: readonly string[]) => Promise<boolean>,
  readFresh: (bot: T) => Promise<T>
): Promise<boolean> {
  const bot = await readFresh(stale).catch((error: unknown) => {
    toast.error(botErrorMessage(error))
    return null
  })
  if (!bot) {
    return false
  }
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

/** The bot as its host lists it right now: a read of its own, never the last list shown. */
export async function readFreshBot(bot: Bot): Promise<Bot> {
  const { bots } = await callRuntimeRpc<{ bots: Bot[] }>(botHostTarget(bot.hostId), 'bots.list')
  const fresh = bots.find((entry) => entry.id === bot.id)
  if (!fresh) {
    // Not shown as is: the card says its usual Try again.
    throw new Error('bot_not_listed')
  }
  return fresh
}
