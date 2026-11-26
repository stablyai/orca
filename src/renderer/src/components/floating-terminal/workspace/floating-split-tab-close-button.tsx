import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useFloatingSplitTabClose } from './use-floating-split-tab-close'

/** Close button for an editor-family tab in a floating split; renders nothing elsewhere. */
export function FloatingSplitTabCloseButton({
  worktreeId,
  tabId
}: {
  worktreeId: string
  tabId: string
}): React.JSX.Element | null {
  const closeTab = useFloatingSplitTabClose(worktreeId, (s) =>
    s.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  )
  if (!closeTab) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={closeTab.onSelect}
          aria-label={closeTab.label}
        >
          <X />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {closeTab.label}
      </TooltipContent>
    </Tooltip>
  )
}
