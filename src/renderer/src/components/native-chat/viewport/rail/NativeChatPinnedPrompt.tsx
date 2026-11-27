// A one-line header for the prompt the visible turn answers, once its own row has scrolled away.
// Unmounted while the reader is at the end: the composer below already shows that prompt.
// Stay out of flow, like the older-history row: adding or removing the header must not shift the transcript.

import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import { findNativeChatPinnedPrompt } from './native-chat-pinned-prompt'

/** Keeps focus where the reader was typing: a pointer press never moves it here. */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault()
}

export function NativeChatPinnedPrompt({
  activeId,
  items,
  readerAtEnd,
  onJump
}: {
  activeId: string | null
  items: readonly NativeChatRailItem[]
  readerAtEnd: boolean
  onJump: (item: NativeChatRailItem) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  useUiLanguageRevision()
  const pinned = findNativeChatPinnedPrompt({ activeId, items, readerAtEnd })
  if (pinned === null) {
    return null
  }
  return (
    // Opaque, so rows sliding under it stay hidden; its height matches the transcript's entry header.
    <div className="absolute inset-x-0 top-0 z-10 flex h-10 items-center bg-chat-pane px-3 sm:px-4">
      <div className="mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) items-center px-[5px]">
        <button
          type="button"
          data-native-chat-pinned-prompt
          onMouseDown={keepFocus}
          onClick={() => onJump(pinned)}
          aria-label={t('components.native-chat.pinnedPromptJump', 'Scroll to this prompt')}
          className="block min-w-0 max-w-full truncate text-left text-xs font-medium text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          {pinned.text.length > 0
            ? pinned.text
            : t('components.native-chat.pinnedPromptImage', 'Image prompt')}
        </button>
      </div>
    </div>
  )
}
