import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/class-names'
import { NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS } from './appearance/native-chat-appearance-style'

/** Every transcript draws its rows here: composer-wide, and the region Find in chat searches. */
export function NativeChatTranscriptColumn({
  ref,
  className,
  children
}: {
  ref?: Ref<HTMLDivElement>
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      ref={ref}
      data-native-chat-transcript-column
      // Shares the composer's maximum width; rail clearance and the 5px inner inset narrow constrained panes.
      className={cn(NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS, className)}
    >
      {children}
    </div>
  )
}
