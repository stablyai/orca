import type { ReactNode } from 'react'
import { cn } from '@/lib/class-names'

/** A card Orca draws into a transcript (a worker's message, a saved automation): avatar, heading row, body.
 *  No avatar when the turn it sits in already shows who it is from. */
export function NativeChatCardFrame({
  avatar,
  heading,
  trailing,
  children
}: {
  avatar?: ReactNode
  /** Absent, the card starts with its body. */
  heading?: ReactNode
  trailing?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="group flex w-full gap-3 rounded-xl border border-border bg-card p-3 text-sm text-card-foreground">
      {avatar}
      <div className="min-w-0 flex-1">
        {heading || trailing ? (
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{heading}</span>
            <div className="flex items-center gap-1">{trailing}</div>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  )
}

export function NativeChatCardAvatar({
  children,
  compact = false
}: {
  children: ReactNode
  compact?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full border border-border bg-muted',
        compact ? 'size-6' : 'mt-0.5 size-8'
      )}
    >
      {children}
    </div>
  )
}
