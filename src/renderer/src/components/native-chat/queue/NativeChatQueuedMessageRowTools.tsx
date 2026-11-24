import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Hidden until the row is hovered, holds keyboard focus, or (touch only) was tapped; hidden tools never take a tap. */
export const QUEUED_ROW_REVEAL =
  'pointer-events-none opacity-0 group-hover/queued:pointer-events-auto group-hover/queued:opacity-100 group-has-[:focus-visible]/queued:pointer-events-auto group-has-[:focus-visible]/queued:opacity-100 [@media(hover:none)]:group-focus-within/queued:pointer-events-auto [@media(hover:none)]:group-focus-within/queued:opacity-100'

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
