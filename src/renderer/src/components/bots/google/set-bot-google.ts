import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { translate } from '@/i18n/i18n'
import { botTarget, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY,
  type GoogleStatusView
} from '../../../../../shared/google/google-connect-types'
import { googleEmailKey } from '../../../../../shared/google/google-bot-accounts'
import type { Bot } from '../../../../../shared/bot-types'
import { botConnectorRowKey, forgetBotConnectorPage } from '../bot-connector-page'
import { refreshGoogle } from './google-connect-client'

/** The bot's Google as a caller read it; the host refuses a save when it has changed since. */
export type GoogleBotRead = { on: boolean; accounts?: string[] }

export function googleBotRead(bot: Pick<Bot, 'google' | 'googleAccounts'>): GoogleBotRead {
  return {
    on: bot.google === true,
    ...(bot.google === true && bot.googleAccounts ? { accounts: [...bot.googleAccounts] } : {})
  }
}

/** With `on`: only `accounts` (absent is every account), the askers the owner was shown, the bot's
 *  Google it started from, and the host accounts it showed (an older host's "every account" must
 *  cover those too, not just the ones still signed in at save). */
type GoogleBotSet = {
  accounts?: readonly string[]
  confirmedAskers?: readonly string[]
  basedOn?: GoogleBotRead
  shownAccounts?: readonly string[]
}

/** A strict subset of accounts chosen on a host too old to keep a list. */
export class GoogleAccountsNeedHostUpdate extends Error {}

function hostLabel(bot: BotRef, target: RuntimeClientTarget): string {
  return target.kind === 'local'
    ? translate('bots.google.thisServer', 'this server')
    : selectExecutionHostDisplayLabel(useAppStore.getState(), bot.hostId, { t: translate })
}

async function hostKeepsAccountLists(target: RuntimeClientTarget): Promise<boolean> {
  if (target.kind === 'environment') {
    return runtimeEnvironmentSupportsCapability(
      target.environmentId,
      GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY
    )
  }
  // Desktop's own host is this build; a web window's is its paired server, updated on its own.
  if (!isPairedWebClientWindow()) {
    return true
  }
  const status = await callRuntimeRpc<RuntimeStatus>(target, 'status.get')
  return status.capabilities?.includes(GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY) === true
}

/** Whether `accounts` are every account signed in on the host, which plain on grants anyway. */
async function coversEveryHostAccount(
  target: RuntimeClientTarget,
  accounts: readonly string[],
  shown: readonly string[]
): Promise<boolean> {
  const status = await callRuntimeRpc<GoogleStatusView>(target, 'google.status', {})
  const chosen = new Set(accounts.map(googleEmailKey))
  return [...status.accounts.map((account) => account.email), ...shown].every((email) =>
    chosen.has(googleEmailKey(email))
  )
}

/** The bot toggle lives with the bot, on its host. */
export async function setBotGoogle(
  bot: BotRef,
  on: boolean,
  set: GoogleBotSet = {}
): Promise<void> {
  const target = botTarget(bot)
  let { accounts } = set
  // An older host drops a list and grants every account: send it plain on only when that is the choice.
  if (on && accounts && !(await hostKeepsAccountLists(target))) {
    if (!(await coversEveryHostAccount(target, accounts, set.shownAccounts ?? []))) {
      throw new GoogleAccountsNeedHostUpdate(
        translate(
          'bots.google.updateToChooseAccounts',
          'Update Orca on {{host}} to choose accounts.',
          {
            host: hostLabel(bot, target)
          }
        )
      )
    }
    accounts = undefined
  }
  // A plain on means every account: say so, or a host keeps the list the bot already has.
  const { confirmedAskers, basedOn } = set
  const params = on
    ? {
        ...(accounts ? { accounts } : { allAccounts: true }),
        ...(confirmedAskers ? { confirmedAskers } : {}),
        ...(basedOn ? { basedOn } : {})
      }
    : {}
  await callBotRpc(bot, 'google.bot.set', { botId: bot.id, on, ...params })
  if (!on) {
    forgetBotConnectorPage(botConnectorRowKey(bot, 'google'))
  }
  await refreshGoogle(target)
}
