// Everything drawn over the native-chat transcript: the pinned prompt, the message rail and the
// new-rows announcement. Kept out of NativeChatMessageList, which is at its line budget.

import type { RefObject } from 'react'
import { NativeChatNewRowsAnnouncement } from './new-rows/NativeChatNewRowsMarker'
import { NativeChatMessageRail } from './rail/NativeChatMessageRail'
import { NativeChatPinnedPrompt } from './rail/NativeChatPinnedPrompt'
import type { NativeChatRailItem } from './rail/native-chat-message-rail-items'
import type { NativeChatMessageRailState } from './rail/use-native-chat-message-rail'

export function NativeChatTranscriptOverlays({
  rail,
  railRef,
  scrollRef,
  onSelect,
  onReaderScroll,
  pendingId,
  listEnabled,
  transcriptKey,
  newRowsMarked,
  pinnedVisible,
  readerAtEnd
}: {
  rail: NativeChatMessageRailState
  railRef: RefObject<HTMLDivElement | null>
  scrollRef: RefObject<HTMLDivElement | null>
  onSelect: (item: NativeChatRailItem) => void
  onReaderScroll?: (deltaY: number) => void
  pendingId?: string | null
  listEnabled: boolean
  /** Remounts the overlays when the visible conversation changes. */
  transcriptKey: string
  newRowsMarked: boolean
  /** A subagent's view has no prompts of its own to pin. */
  pinnedVisible: boolean
  readerAtEnd: boolean
}): React.JSX.Element {
  return (
    <>
      {pinnedVisible ? (
        <NativeChatPinnedPrompt
          key={transcriptKey}
          activeId={rail.activeId}
          items={rail.items}
          readerAtEnd={readerAtEnd}
          onJump={onSelect}
          scrollRef={scrollRef}
          onReaderScroll={onReaderScroll}
        />
      ) : null}
      <NativeChatMessageRail
        key={transcriptKey}
        rail={rail}
        railRef={railRef}
        scrollRef={scrollRef}
        onSelect={onSelect}
        onReaderScroll={onReaderScroll}
        pendingId={pendingId}
        listEnabled={listEnabled}
      />
      <NativeChatNewRowsAnnouncement marked={newRowsMarked} />
    </>
  )
}
