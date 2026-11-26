// The Claude account a bot's chats launch under, from the accounts saved on the bot's host.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useBotHostLabel } from '@/components/bots/use-bot-host-label'
import { resolveClaudeStatusAccountState } from '@/components/status-bar/accounts/status-bar-claude-accounts'
import {
  getClaudeAccountRosterSyncKey,
  getClaudeAccountSettings
} from '@/components/status-bar/accounts/provider-account-sync-key'
import { useProviderAccountList } from '@/components/status-bar/accounts/use-provider-account-list'
import { useTranslate } from '@/i18n/use-translate'
import { botHostTarget } from '@/lib/bot-hosts'
import { emptyClaudeAccountsState } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import {
  botClaudeAccountChoices,
  FOLLOW_HOST_ACCOUNT,
  UNKNOWN_BOT_ACCOUNT,
  type BotClaudeAccountChoices
} from './bot-claude-account-choices'

const EMPTY_CLAUDE_ACCOUNTS = emptyClaudeAccountsState()

export function BotClaudeAccountSelect({
  options: { choices, selected, unknown },
  known,
  hostLabel,
  onChange
}: {
  options: BotClaudeAccountChoices
  /** Whether the host listed its accounts; until then an unmatched account isn't called unavailable. */
  known: boolean
  /** The paired server's name; null is this computer. */
  hostLabel: string | null
  onChange: (value: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Select value={selected} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        className="w-full"
        aria-label={t('settings.bots.claudeAccount', 'Claude account')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FOLLOW_HOST_ACCOUNT}>
          {hostLabel
            ? t('settings.bots.claudeAccountFollowServer', 'Use {{host}}’s selected account', {
                host: hostLabel
              })
            : t('settings.bots.claudeAccountFollowHost', 'Use this computer’s selected account')}
        </SelectItem>
        {choices.map((choice) => (
          <SelectItem
            key={choice.value}
            value={choice.value}
            disabled={choice.disabled}
            description={choice.detail}
          >
            {choice.label}
          </SelectItem>
        ))}
        {unknown !== null ? (
          <SelectItem
            value={UNKNOWN_BOT_ACCOUNT}
            description={
              known
                ? t(
                    'settings.bots.claudeAccountUnavailableDetail',
                    'No saved account matches it, so chats use the selected account'
                  )
                : undefined
            }
          >
            {known
              ? t('settings.bots.claudeAccountUnavailable', '{{account}} (unavailable)', {
                  account: unknown
                })
              : unknown}
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}

/** Lists the bot's host's own accounts: this computer's, or the paired server's over its runtime. */
export function BotClaudeAccountPicker({
  bot,
  update
}: {
  bot: Bot
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
}): React.JSX.Element {
  const target = botHostTarget(bot.hostId)
  const environmentId = runtimeTargetEnvironmentId(target)
  const hostLabel = useBotHostLabel(bot.hostId)
  // This computer's settings carry its fresh roster and names; a server's own snapshot is the truth there.
  const accountSettings = useAppStore((s) =>
    environmentId ? null : getClaudeAccountSettings(s.settings)
  )
  const syncKey = useAppStore((s) =>
    environmentId ? '' : getClaudeAccountRosterSyncKey(s.settings)
  )
  const { accounts, accountsLoaded } = useProviderAccountList(
    'claude',
    target,
    syncKey,
    EMPTY_CLAUDE_ACCOUNTS
  )
  const state = resolveClaudeStatusAccountState(accountSettings, accounts, environmentId)
  const options = botClaudeAccountChoices(state, bot.account)
  return (
    <BotClaudeAccountSelect
      options={options}
      known={accountsLoaded || accountSettings !== null}
      hostLabel={hostLabel}
      onChange={(value) => {
        if (value !== options.selected && value !== UNKNOWN_BOT_ACCOUNT) {
          void update({ account: value === FOLLOW_HOST_ACCOUNT ? '' : value })
        }
      }}
    />
  )
}
