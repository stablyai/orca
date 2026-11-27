import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatContextUsageSummary } from '../../../../../shared/native-chat/native-chat-context-usage-summary'
import { NativeChatTokenUsageMetrics } from './NativeChatTokenUsageMetrics'

export function NativeChatTokenUsageFooter({
  usage
}: {
  usage: NativeChatContextUsageSummary | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      data-native-chat-token-usage=""
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-2 pt-2 text-2xs text-chat-foreground-faint"
    >
      <span>
        {usage?.tokenUsage?.scope === 'session'
          ? t('components.native-chat.tokenUsage.session', 'Session tokens')
          : usage?.tokenUsage?.scope === 'response'
            ? t('components.native-chat.tokenUsage.response', 'Last response tokens')
            : t('components.native-chat.tokenUsage.title', 'Tokens')}
      </span>
      <NativeChatTokenUsageMetrics counts={usage?.tokenUsage?.counts} context={usage} />
    </div>
  )
}
