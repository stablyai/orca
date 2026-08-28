import type { JSX } from 'react'
import { Moon } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

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
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem onSelect={onSleep} disabled={sleepDisabled}>
            <Moon className="size-3.5" />
            {sleepLabel}
          </DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="max-w-[200px] text-pretty">
          {isMultiContext
            ? translate(
                'auto.components.sidebar.WorktreeContextMenu.7d190f7d2b',
                'Close all active panels in the selected workspaces to free up memory and CPU.'
              )
            : translate(
                'auto.components.sidebar.WorktreeContextMenu.0918b35e4f',
                'Close all active panels in this workspace to free up memory and CPU.'
              )}
        </TooltipContent>
      </Tooltip>
      {!isMultiContext && descendantCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem onSelect={onSleepSubtree} disabled={subtreeSleepDisabled}>
              <Moon className="size-3.5" />
              {translate(
                'auto.components.sidebar.WorktreeContextMenu.sleepWithDescendants',
                'Sleep with Descendants ({{value0}})',
                { value0: descendantCount }
              )}
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="max-w-[220px] text-pretty">
            {translate(
              'auto.components.sidebar.WorktreeContextMenu.sleepWithDescendantsDescription',
              'Close active panels in this workspace and every nested descendant to free up memory and CPU.'
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}
