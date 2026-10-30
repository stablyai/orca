import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useIssueDraftPanelStore } from './issue-draft-panel-store'

export function TaskPageIssueDraftPanelToggle({
  disabled
}: {
  disabled: boolean
}): React.JSX.Element {
  const open = useIssueDraftPanelStore((s) => s.open)
  const setOpen = useIssueDraftPanelStore((s) => s.setOpen)
  const label = translate(
    'auto.components.TaskPage.issueDraftPanel.toggle',
    'Draft issues with an agent'
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={open ? 'secondary' : 'outline'}
          size="icon"
          onClick={() => setOpen(!open)}
          disabled={disabled}
          aria-label={label}
          aria-pressed={open}
          className="size-8"
        >
          <Sparkles className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
