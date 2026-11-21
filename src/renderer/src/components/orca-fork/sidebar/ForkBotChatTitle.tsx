import React from 'react'
import { cn } from '@/lib/class-names'
import { FORK_FEATURES } from '../../../../../shared/orca-fork/fork-features'

/** Whether a chat row draws two lines: its title, then its last message. */
export function forkChatRowHasPreview(preview: string | undefined): boolean {
  return FORK_FEATURES.sidebarChatPreviews && Boolean(preview?.trim())
}

/** A bot's chat row title, with the chat's last message under it when there is one. */
export function ForkBotChatTitle({
  title,
  preview,
  bold
}: {
  title: string
  preview: string | undefined
  bold: boolean
}): React.JSX.Element {
  const titleClass = cn('min-w-0 truncate text-foreground', bold && 'font-semibold')
  if (!forkChatRowHasPreview(preview)) {
    return <span className={cn(titleClass, 'flex-1')}>{title}</span>
  }
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className={titleClass}>{title}</span>
      <span className={cn('min-w-0 truncate text-muted-foreground', bold && 'text-foreground/80')}>
        {preview}
      </span>
    </span>
  )
}
