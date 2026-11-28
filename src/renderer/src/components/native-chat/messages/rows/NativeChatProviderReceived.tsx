import { isAgentSessionReceiptProvider } from '../../../../../../shared/agent-session/journal/agent-session-dispatch-limits'
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { ProviderReceivedLabels } from '../../../../../../shared/agent-session/view/live-read/agent-session-provider-received'
import { useTranslate } from '@/i18n/use-translate'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'

export const NativeChatProviderReceived = createContext<
  { labels: ProviderReceivedLabels; agent: string } | undefined
>(undefined)

export function NativeChatSendingLabel({ itemId }: { itemId: string }) {
  const context = useContext(NativeChatProviderReceived)
  const subscribe = useCallback(
    (changed: () => void) =>
      context && isAgentSessionReceiptProvider(context.agent)
        ? context.labels.subscribe(itemId, changed, context.agent)
        : () => {},
    [context, itemId]
  )
  const received = useSyncExternalStore(subscribe, () => context?.labels.provider(itemId))
  const t = useTranslate()
  return (
    <span className="text-xs whitespace-nowrap text-chat-foreground-faint">
      {received
        ? t('components.native-chat.messageReceivedBy', 'Received by {{agent}}', {
            agent: structuredAgentLabel(received)
          })
        : t('components.native-chat.messageSending', 'Sending…')}
    </span>
  )
}
