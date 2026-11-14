import type { JSX } from 'react'
import { Moon, Network } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

type WorkspaceSleepMenuItemsProps = {
  isMultiContext: boolean
  sleepLabel: string
  sleepDisabled: boolean
  descendantCount: number
  subtreeSleepDisabled: boolean
  onSleep: () => void
  onSleepSubtree: () => void
}

export function WorkspaceSleepMenuItems({
  isMultiContext,
  sleepLabel,
  sleepDisabled,
  descendantCount,
  subtreeSleepDisabled,
  onSleep,
  onSleepSubtree
}: WorkspaceSleepMenuItemsProps): JSX.Element {
  const t = useTranslate()
  const sleepDescription = isMultiContext
    ? t(
        'auto.components.sidebar.WorktreeContextMenu.7d190f7d2b',
        'Close all active panels in the selected workspaces to free up memory and CPU.'
      )
    : t(
        'auto.components.sidebar.WorktreeContextMenu.0918b35e4f',
        'Close all active panels in this workspace to free up memory and CPU.'
      )
  if (isMultiContext || descendantCount === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem onSelect={onSleep} disabled={sleepDisabled}>
            <Moon className="size-3.5" />
            {sleepLabel}
          </DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="max-w-[200px] text-pretty">
          {sleepDescription}
        </TooltipContent>
      </Tooltip>
    )
  }
  // Parents choose scope in a submenu so the common one-workspace Sleep stays a single row.
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={sleepDisabled && subtreeSleepDisabled}>
        <Moon className="size-3.5" />
        {sleepLabel}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem onSelect={onSleep} disabled={sleepDisabled}>
              <Moon className="size-3.5" />
              {t(
                'auto.components.sidebar.WorktreeContextMenu.sleepThisWorkspace',
                'This Workspace'
              )}
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="max-w-[200px] text-pretty">
            {sleepDescription}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem onSelect={onSleepSubtree} disabled={subtreeSleepDisabled}>
              <Network className="size-3.5" />
              {t(
                'auto.components.sidebar.WorktreeContextMenu.sleepDescendantsOption',
                'With Descendants ({{value0}})',
                { value0: descendantCount }
              )}
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="max-w-[220px] text-pretty">
            {t(
              'auto.components.sidebar.WorktreeContextMenu.sleepWithDescendantsDescription',
              'Close active panels in this workspace and every nested descendant to free up memory and CPU.'
            )}
          </TooltipContent>
        </Tooltip>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
