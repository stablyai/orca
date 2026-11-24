import type { MouseEventHandler, ReactNode } from 'react'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export const botItemLinkRowClassName =
  'flex h-[22px] w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-[13px] text-foreground outline-none enabled:hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:text-muted-foreground'

export function BotItemLinkRowButton({
  name,
  status,
  tip,
  disabled,
  onClick
}: {
  name: ReactNode
  status?: ReactNode
  tip?: string
  disabled?: boolean
  onClick?: MouseEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  const button = (
    <button type="button" disabled={disabled} onClick={onClick} className={botItemLinkRowClassName}>
      <BotItemLinkRowName>{name}</BotItemLinkRowName>
      <BotItemLinkRowStatus>{status}</BotItemLinkRowStatus>
    </button>
  )
  return tip ? (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-80 break-words">
        {tip}
      </TooltipContent>
    </Tooltip>
  ) : (
    button
  )
}

export function BotItemLinkRowName({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex min-w-0 flex-1 truncate">{children}</span>
}

/** A row's state, right: the app's own short words, which never shrink, so only the name truncates.
 *  While the Links block has a Stop button (`data-stop-slot`), the state leaves its width free, so it
 *  ends where the stoppable row's state does; that row's own state (`ownsStopSlot`) sits beside Stop. */
export function BotItemLinkRowStatus({
  ownsStopSlot = false,
  children
}: {
  ownsStopSlot?: boolean
  children: ReactNode
}): React.JSX.Element | null {
  return children ? (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground',
        // Stop's `ml-0.5 size-5`.
        !ownsStopSlot && 'group-data-[stop-slot]/links:mr-[22px]'
      )}
    >
      {typeof children === 'string' ? (
        <BotItemLinkRowStatusText>{children}</BotItemLinkRowStatusText>
      ) : (
        children
      )}
    </span>
  ) : null
}

/** A status's words: in their own box, so a long one ends in an ellipsis rather than being cut. */
export function BotItemLinkRowStatusText({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="min-w-0 truncate">{children}</span>
}

/** A long host and path loses its middle, so the last path segment stays readable. */
export function BotItemLinkRowMiddleTruncated({ text }: { text: string }): React.JSX.Element {
  const cut = text.lastIndexOf('/') + 1
  return (
    <span className="flex min-w-0">
      <span className="min-w-0 truncate">{text.slice(0, cut)}</span>
      <span className="max-w-[60%] shrink-0 truncate">{text.slice(cut)}</span>
    </span>
  )
}
