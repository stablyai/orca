import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { selectStructuredAgentContextUsage } from '../../../../../shared/agent-session/conversation-context/structured-agent-session-context-usage'
import { summarizeContextUsage } from '../../../../../shared/native-chat/native-chat-context-usage-summary'
import { NativeChatTokenUsageMetrics } from './NativeChatTokenUsageMetrics'

export function NativeChatMessageTokenUsage({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element {
  const context = message.usageContext
    ? selectStructuredAgentContextUsage([], message.usageContext)
    : null
  return (
    <div
      data-native-chat-message-token-usage={message.id}
      className="mt-2 text-2xs text-chat-foreground-faint"
    >
      <NativeChatTokenUsageMetrics
        counts={message.usage}
        context={context ? summarizeContextUsage(context) : null}
      />
    </div>
  )
}
