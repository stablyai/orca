import { useTranslate } from '@/i18n/use-translate'
import {
  formatContextTokenCount,
  type NativeChatContextUsageSummary
} from '../../../../../shared/native-chat/native-chat-context-usage-summary'
import { contextTokensFromUsage } from '../../../../../shared/agent-session/conversation-context/agent-session-context-usage'

export function NativeChatTokenUsageFooter({
  usage
}: {
  usage: NativeChatContextUsageSummary | null
}): React.JSX.Element {
  const t = useTranslate()
  const counts = usage?.tokenUsage?.counts
  const input = counts ? contextTokensFromUsage(counts) : null
  const output = counts?.outputTokens ?? null
  const format = (value: number | null): string =>
    value === null ? '—' : formatContextTokenCount(value)
  const metrics = [
    {
      id: 'used',
      label: t('components.native-chat.tokenUsage.used', 'Used'),
      value: format(input === null || output === null ? null : input + output)
    },
    {
      id: 'input',
      label: t('components.native-chat.tokenUsage.input', 'In'),
      value: format(input)
    },
    {
      id: 'output',
      label: t('components.native-chat.tokenUsage.output', 'Out'),
      value: format(output)
    },
    {
      id: 'context',
      label: t('components.native-chat.contextUsage.title', 'Context'),
      value: usage
        ? `${usage.estimated ? '≈' : ''}${usage.percentage}% (${formatContextTokenCount(usage.usedTokens)}/${formatContextTokenCount(usage.windowTokens)})`
        : '—'
    }
  ]
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
      <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums">
        {metrics.map(({ id, label, value }) => (
          <div key={id} className="flex gap-1 whitespace-nowrap">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
