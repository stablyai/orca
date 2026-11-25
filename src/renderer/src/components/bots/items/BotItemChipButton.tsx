import { useId, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** One link chip: an icon and a short name, cut to fit; the whole name and what a row says is on hover. */
export function BotItemChipButton({
  icon,
  label,
  suffix,
  tip,
  disabled,
  onClick,
  tooltip = true
}: {
  icon: ReactNode
  label: string
  suffix?: string | null
  tip?: string
  disabled?: boolean
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  /** False when a hover card on the chip already shows what the tooltip would; screen readers still
   *  hear the tip as the chip's description. */
  tooltip?: boolean
}): React.JSX.Element {
  const descriptionId = useId()
  const described = !tooltip && Boolean(tip)
  const chip = (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={suffix ? `${label} ${suffix}` : undefined}
      aria-describedby={described ? descriptionId : undefined}
      className="flex h-6 min-w-0 max-w-60 items-center gap-1.5 rounded-md border border-border bg-background px-1.5 text-xs text-foreground outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:text-muted-foreground disabled:hover:bg-background"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      <span className={suffix ? 'min-w-0 truncate @max-[290px]:hidden' : 'min-w-0 truncate'}>
        {label}
      </span>
      {suffix ? (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{suffix}</span>
      ) : null}
    </button>
  )
  if (!tooltip) {
    return described ? (
      <>
        {chip}
        {/* Hidden: read once as the chip's description, never again as loose text. */}
        <span id={descriptionId} hidden>
          {tip}
        </span>
      </>
    ) : (
      chip
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-80">
        {tip ? `${label} · ${tip}` : label}
      </TooltipContent>
    </Tooltip>
  )
}
