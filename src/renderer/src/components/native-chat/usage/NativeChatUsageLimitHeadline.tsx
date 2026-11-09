import { useTranslate } from '@/i18n/use-translate'
import type { AgentSessionUsageLimit } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'
import { formatUsageLimitResetClock } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'
import { USAGE_LIMIT_WINDOW_COPY } from '../../../../../shared/agent-session/failures/agent-session-usage-limit-words'
import { sayAgentSessionFailureTranslated } from '../messages/notices/agent-session-failure-words-text'

/** A usage-limit row's first line: which limit stopped the agent, then when it resets. */
export function NativeChatUsageLimitHeadline({
  agentName,
  usageLimit
}: {
  agentName?: string
  usageLimit: AgentSessionUsageLimit | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const headline = !agentName
    ? t('components.native-chat.usageLimitHeadline.unnamed', 'Usage limit reached')
    : usageLimit?.window
      ? t(
          'components.native-chat.usageLimitHeadline.window',
          '{{agent}} {{window}} limit reached',
          {
            agent: agentName,
            window: sayAgentSessionFailureTranslated(USAGE_LIMIT_WINDOW_COPY[usageLimit.window])
          }
        )
      : t('components.native-chat.usageLimitHeadline.agent', '{{agent}} usage limit reached', {
          agent: agentName
        })
  return (
    <p className="min-w-0 flex-1 break-words">
      <span className="font-medium">{headline}</span>
      {usageLimit?.resetsAt !== undefined ? (
        <span className="ml-2 text-xs text-chat-foreground-faint">
          {t('components.native-chat.usageLimitHeadline.resetsAt', 'Resets at {{time}}', {
            time: formatUsageLimitResetClock(usageLimit.resetsAt)
          })}
        </span>
      ) : null}
    </p>
  )
}
