import type { MouseEventHandler, ReactNode } from 'react'
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

export function BotItemLinkRowStatus({
  children
}: {
  children: ReactNode
}): React.JSX.Element | null {
  return children ? (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {children}
    </span>
  ) : null
}
