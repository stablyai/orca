import { translate } from '@/i18n/i18n'
import { botTarget, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import { GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY } from '../../../../../shared/google/google-connect-types'
import { botConnectorRowKey, forgetBotConnectorPage } from '../bot-connector-page'
import { refreshGoogle } from './google-connect-client'

/** With `on`: only `accounts` (absent is every account), and the askers the owner was shown. */
type GoogleBotSet = { accounts?: readonly string[]; confirmedAskers?: readonly string[] }

/** An older host drops a list and grants every account, so a list is never sent to one. */
export class GoogleAccountsNeedHostUpdate extends Error {}

/** The bot toggle lives with the bot, on its host. */
export async function setBotGoogle(
  bot: BotRef,
  on: boolean,
  set: GoogleBotSet = {}
): Promise<void> {
  const target = botTarget(bot)
  if (
    on &&
    set.accounts &&
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY
    ))
  ) {
    const host = selectExecutionHostDisplayLabel(useAppStore.getState(), bot.hostId, {
      t: translate
    })
    throw new GoogleAccountsNeedHostUpdate(
      translate(
        'bots.google.updateToChooseAccounts',
        'Update Orca on {{host}} to choose accounts.',
        {
          host
        }
      )
    )
  }
  // A plain on means every account: say so, or a host keeps the list the bot already has.
  const params = on ? (set.accounts ? set : { ...set, allAccounts: true }) : {}
  await callBotRpc(bot, 'google.bot.set', { botId: bot.id, on, ...params })
  if (!on) {
    forgetBotConnectorPage(botConnectorRowKey(bot, 'google'))
  }
  await refreshGoogle(target)
}
