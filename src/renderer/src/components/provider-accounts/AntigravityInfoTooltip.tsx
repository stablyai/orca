import { Info } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function AntigravityInfoTooltip({ info }: { info: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={info}>
          <Info className="size-3.5 text-muted-foreground" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-xs">
        {info}
      </TooltipContent>
    </Tooltip>
  )
}
