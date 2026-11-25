import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Hidden until the row is hovered, holds keyboard focus, or (touch only) was tapped; hidden tools never take a tap. */
export const QUEUED_ROW_REVEAL =
  'pointer-events-none opacity-0 group-hover/queued:pointer-events-auto group-hover/queued:opacity-100 group-has-[:focus-visible]/queued:pointer-events-auto group-has-[:focus-visible]/queued:opacity-100 [@media(hover:none)]:group-focus-within/queued:pointer-events-auto [@media(hover:none)]:group-focus-within/queued:opacity-100'

/** At the smallest chat text size `--spacing` shrinks a size-6 button to about 20.6px. The row's targets sit
 * flush, so each keeps a 24px floor: an undersized target would touch its neighbor. Buttons spell it out,
 * since their classes must be static strings. */
export const QUEUED_ROW_TARGET = 'min-h-[24px] min-w-[24px]'

/** The space an icon button leaves beside its size-3.5 glyph (5px at the default size). Set on the tool row
 * so the image count and Steer pad their glyphs by it too, keeping every gap alike at any text size. */
export const QUEUED_ROW_INSET_VAR =
  '[--queued-row-inset:calc((max(24px,var(--spacing)*6)-var(--spacing)*3.5)/2)]'

/** The text fades out under the revealed tools, one 24px button each, so the row reserves no space for them at rest. */
export function queuedRowToolsMask(toolCount: number): string {
  return `linear-gradient(to left, transparent ${toolCount * 24}px, #000 ${toolCount * 24 + 16}px)`
}

export function QueuedMessageRowTool({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  onClick: (() => void) | undefined
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="min-h-[24px] min-w-[24px]"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
