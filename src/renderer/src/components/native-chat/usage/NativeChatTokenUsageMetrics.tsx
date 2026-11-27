import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  formatContextTokenCount,
  type NativeChatContextUsageSummary
} from '../../../../../shared/native-chat/native-chat-context-usage-summary'
import {
  contextTokensFromUsage,
  type AgentSessionTokenUsage
} from '../../../../../shared/agent-session/conversation-context/agent-session-context-usage'

export function NativeChatTokenUsageMetrics({
  counts,
  context,
  className
}: {
  counts?: AgentSessionTokenUsage
  context?: NativeChatContextUsageSummary | null
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
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
      value: context
        ? `${context.estimated ? '≈' : ''}${context.percentage}% (${formatContextTokenCount(context.usedTokens)}/${formatContextTokenCount(context.windowTokens)})`
        : '—'
    }
  ]
  return (
    <dl className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums', className)}>
      {metrics.map(({ id, label, value }) => (
        <div key={id} className="flex gap-1 whitespace-nowrap">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
