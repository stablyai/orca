import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function MetaIconBadge({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/70 hover:text-foreground [&>svg]:size-3.5">
      {children}
      <span className="sr-only">{label}</span>
    </span>
  )
}

export function DetailHeader({
  icon,
  label,
  actions
}: {
  icon: React.ReactNode
  label: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </div>
  )
}

export function MetadataActionIcon({
  label,
  href,
  onClick,
  children
}: {
  label: string
  href?: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}): React.JSX.Element {
  const trigger = href ? (
    <Button asChild variant="ghost" size="icon-xs" className="size-6">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </a>
    </Button>
  ) : (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-6"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.(event)
      }}
    >
      {children}
    </Button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
