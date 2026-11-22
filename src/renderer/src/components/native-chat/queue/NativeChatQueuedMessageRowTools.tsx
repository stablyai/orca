import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** Hidden until the row is hovered, holds keyboard focus, or (touch only) was tapped; hidden tools never take a tap. */
export const QUEUED_ROW_REVEAL =
  'pointer-events-none opacity-0 group-hover/queued:pointer-events-auto group-hover/queued:opacity-100 group-has-[:focus-visible]/queued:pointer-events-auto group-has-[:focus-visible]/queued:opacity-100 [@media(hover:none)]:group-focus-within/queued:pointer-events-auto [@media(hover:none)]:group-focus-within/queued:opacity-100'

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
          variant="chat-tool"
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

export function QueuedMessageExpandToggle({
  expanded,
  controls,
  onToggle
}: {
  expanded: boolean
  /** The opened text element; absent while folded, when no such element exists. */
  controls: string | undefined
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = expanded
    ? t('components.native-chat.queuedMessages.showLess', 'Show less')
    : t('components.native-chat.queuedMessages.showFullMessage', 'Show full message')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="chat-tool"
          size="icon-xs"
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={controls}
          onClick={onToggle}
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
