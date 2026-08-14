import React, { useState } from 'react'
import { CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'

export default function WorktreeVisibilityHelpPopover(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const title = translate(
    'auto.components.sidebar.WorktreeVisibilityHelpPopover.c41f2d7e90',
    'Which worktrees are hidden by default?'
  )

  return (
    <div
      className="inline-flex"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
            aria-label={title}
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <CircleHelp className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label={title}
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-80 p-3"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="text-sm font-medium">{title}</div>
          <ul className="mt-2 grid list-disc gap-2 pl-4 text-xs leading-5 text-muted-foreground text-pretty">
            <li>
              {translate(
                'auto.components.sidebar.WorktreeVisibilityHelpPopover.8db4e19a26',
                'This setting never hides worktrees created through Orca.'
              )}
            </li>
            <li>
              {translate(
                'auto.components.sidebar.WorktreeVisibilityHelpPopover.ec1e6a10fb',
                'Other worktrees start hidden to avoid unexpected sidebar clutter.'
              )}
            </li>
            <li>
              {translate(
                'auto.components.sidebar.WorktreeVisibilityHelpPopover.1c68c9cf77',
                'Enable a source for all current and future worktrees, or show individual worktrees below.'
              )}
            </li>
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  )
}
