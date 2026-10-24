import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** The X on a history row: shown when cmdk marks the row selected (hover or arrows), like Chrome's. */
export default function BrowserHistoryRowRemoveButton({
  onRemove
}: {
  onRemove: () => void
}): React.JSX.Element {
  const label = translate('browser.history.remove', 'Remove from history')
  return (
    <span className="shrink-0 text-muted-foreground opacity-0 [[data-selected=true]_&]:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            aria-label={label}
            // Why: keep focus in the text field, so its list keeps the keyboard after the row goes.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
          >
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
