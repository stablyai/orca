import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Plus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'

function AddReferenceAction({
  onClick
}: {
  onClick?: (event: React.MouseEvent) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!onClick) {
    return null
  }
  return (
    <MetadataActionIcon
      label={t('workspace.links.addReference', 'Add reference')}
      onClick={onClick}
    >
      <Plus className="size-3" />
    </MetadataActionIcon>
  )
}

export function MetaIconBadge({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/70 [&>svg]:size-3.5">
      {children}
      <span className="sr-only">{label}</span>
    </span>
  )
}

export function DetailHeader({
  icon,
  label,
  actions,
  onAddReference
}: {
  icon: React.ReactNode
  label: string
  actions?: React.ReactNode
  onAddReference?: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      {actions || onAddReference ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {actions}
          <AddReferenceAction onClick={onAddReference} />
        </div>
      ) : null}
    </div>
  )
}

export function MetadataActionIcon({
  label,
  href,
  workspaceId,
  onClick,
  onPointerDown,
  children
}: {
  label: string
  href?: string
  /** The card's workspace hosts the link, not whichever one is selected. */
  workspaceId?: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
  children: React.ReactNode
}): React.JSX.Element {
  const trigger = href ? (
    <Button asChild variant="ghost" size="icon-xs" className="size-6">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation()
          openAppHttpLinkFromAnchor(event, workspaceId)
        }}
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
      onPointerDown={onPointerDown}
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
