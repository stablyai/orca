import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** A status row's open icon, named for what it opens ("Open Parser worker"). */
export function NativeChatEventOpenButton({
  name,
  onOpen
}: {
  name: string
  onOpen: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={name} onClick={onOpen}>
          <ArrowUpRight className="size-3" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {name}
      </TooltipContent>
    </Tooltip>
  )
}
