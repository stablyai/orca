import { cn } from '@/lib/utils'
import { NativeChatMessageList } from '../native-chat/NativeChatMessageList'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from '../native-chat/native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from '../native-chat/use-native-chat-store-appearance-style'
import type { NativeChatLiveSession } from '../native-chat/native-chat-live-session-contract'

/**
 * Renders a transcript the board read off disk through the real chat renderer, so a
 * read-only conversation looks exactly like a live one — message rows, tool steps,
 * diffs, markdown and windowing included.
 */
export function SessionsConversationTranscript({
  session
}: {
  session: NativeChatLiveSession
}): React.JSX.Element {
  // Why null: the column has no measured width of its own here, so the appearance
  // root falls back to the store's configured size, as the chat does before layout.
  const appearanceStyle = useNativeChatStoreAppearanceStyle(null)

  return (
    <div
      className={cn(
        NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
        'flex h-full min-h-0 w-full flex-col focus:outline-none'
      )}
      style={appearanceStyle}
      data-native-chat-scheme={appearanceStyle.colorScheme}
    >
      {/* No pane owns this read, so nothing is working and no toolbar drives expansion. */}
      <NativeChatMessageList session={session} isWorking={false} expandSignal={false} />
    </div>
  )
}
