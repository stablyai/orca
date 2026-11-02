import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'

/** Stands in for the transcript: renders each message's delivery notice or quiet "Sending…". */
export function DeliveryNoticesMock({
  notices
}: {
  notices?: ReadonlyMap<string, NativeChatDeliveryNotice>
}): React.JSX.Element {
  return (
    <div data-testid="message-list">
      {[...(notices ?? [])].map(([id, notice]) => (
        <div key={id} data-message-id={id}>
          <span>{notice.sending ? 'Sending…' : notice.text}</span>
        </div>
      ))}
    </div>
  )
}

export type StructuredSessionMessageListProps = {
  ref?: React.Ref<NativeChatMessageListHandle>
  allowFileUriLinks?: boolean
  isVisible?: boolean
  onLinkClick?: (...args: unknown[]) => void
  awaitingInput?: 'shown' | 'unshown' | null
  isWorking?: boolean
  stopping?: boolean
  runtimeContext?: unknown
  session?: { hasMore: boolean; loadingEarlier: boolean; loadEarlier: () => Promise<void> }
  deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
}
