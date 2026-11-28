import type { ReactNode } from 'react'
import { NativeChatWorkerChipSlot } from './worker-chip-slot'

/** With no message list to carry it (history loading, empty, or unreadable), the worker chip sits at
 *  the end of the transcript area all the same: a column like the message list's, its view over the
 *  chip's slot, so the chip keeps its own room, scope and rise. */
export function NativeChatWorkerChipColumn({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-[var(--native-chat-worker-chip-room,0px)] flex-1 flex-col">
        {children}
      </div>
      <NativeChatWorkerChipSlot />
    </div>
  )
}
