import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { ProviderReceivedStore } from '../../../../../../shared/agent-session/view/live-read/agent-session-provider-received'
import { useTranslate } from '@/i18n/use-translate'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'

export const NativeChatProviderReceived = createContext<ProviderReceivedStore | undefined>(
  undefined
)

export function NativeChatSendingLabel({ itemId }: { itemId: string }) {
  const store = useContext(NativeChatProviderReceived)
  const subscribe = useCallback(
    (changed: () => void) => store?.subscribe(itemId, changed) ?? (() => {}),
    [store, itemId]
  )
  const received = useSyncExternalStore(subscribe, () => store?.provider(itemId))
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
