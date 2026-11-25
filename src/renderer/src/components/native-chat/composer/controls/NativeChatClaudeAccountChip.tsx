import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { ClaudeIcon } from '@/components/status-bar/accounts/provider-icons'
import {
  claudeAccountName,
  hostClaudeAccounts
} from '@/components/settings/repository/claude-account/claude-account-binding-options'

/** The Claude account this chat runs on, always in view beside the workspace. Only for chats on
 *  this computer: a paired server's account ids name its own accounts, not these. */
export function NativeChatClaudeAccountChip({
  accountId,
  local,
  textClassName
}: {
  /** Undefined hides the chip; null is System default. */
  accountId: string | null | undefined
  local: boolean
  textClassName: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const settings = useAppStore((state) => state.settings)
  if (accountId === undefined || !local) {
    return null
  }
  const account = accountId ? hostClaudeAccounts(settings).find((a) => a.id === accountId) : null
  const label =
    accountId === null
      ? t('auto.components.status.bar.StatusBar.c676918adc', 'System default')
      : account
        ? claudeAccountName(account, settings?.managedAccountDisplayNames)
        : t(
            'auto.components.settings.RepositoryClaudeAccountSection.missingAccount',
            'Removed account'
          )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 items-center gap-1" data-native-chat-claude-account="">
          <ClaudeIcon size={12} className="shrink-0" />
          <span className={textClassName}>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {t(
          'components.native-chat.claudeAccountChip.tooltip',
          'Claude account this chat runs on: {{account}}',
          {
            account: account?.email ?? label
          }
        )}
      </TooltipContent>
    </Tooltip>
  )
}
