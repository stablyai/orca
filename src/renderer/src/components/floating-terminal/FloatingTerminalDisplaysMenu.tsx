import { Check, ExternalLink, Minimize2, Monitor, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkspaceDisplayInfo } from '../../../../shared/floating-workspace-display'
import { translate } from '@/i18n/i18n'

export type FloatingTerminalDisplaysMenuProps = {
  displays: readonly WorkspaceDisplayInfo[]
  currentDisplayId?: number | null
  isDetached: boolean
  controlButtonClassName: string
  onMoveToDisplay?: (displayId: number) => void
  onMoveToNextDisplay?: () => void
  onIdentifyDisplays?: () => void
  onRefreshDisplays?: () => void
  onToggleDetached?: () => void
}

export function FloatingTerminalDisplaysMenu({
  displays,
  currentDisplayId,
  isDetached,
  controlButtonClassName,
  onMoveToDisplay,
  onMoveToNextDisplay,
  onIdentifyDisplays,
  onRefreshDisplays,
  onToggleDetached
}: FloatingTerminalDisplaysMenuProps): React.JSX.Element | null {
  if (displays.length === 0 || (!onMoveToDisplay && !onMoveToNextDisplay)) {
    return null
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          onRefreshDisplays?.()
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className={controlButtonClassName}
              aria-label={translate(
                'auto.components.floating.terminal.FloatingTerminalWindowControls.displaysHeader',
                'Displays'
              )}
            >
              <Monitor className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate(
            'auto.components.floating.terminal.FloatingTerminalWindowControls.displaysHeader',
            'Displays'
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" className="w-56">
        <DropdownMenuLabel className="px-2 py-1 text-xs font-semibold text-muted-foreground">
          {translate(
            'auto.components.floating.terminal.FloatingTerminalWindowControls.displaysHeader',
            'Displays'
          )}
        </DropdownMenuLabel>
        {displays.map((display, index) => {
          const isCurrent = isDetached ? display.id === currentDisplayId : display.isPrimary
          return (
            <DropdownMenuItem
              key={`${display.id}:${display.bounds.x},${display.bounds.y}`}
              className="flex cursor-pointer items-center justify-between py-1.5 text-xs"
              onClick={() => {
                if (onMoveToDisplay) {
                  onMoveToDisplay(display.id)
                } else {
                  onMoveToNextDisplay?.()
                }
              }}
            >
              <div className="mr-2 flex min-w-0 flex-1 items-center gap-2">
                <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{display.label || `Monitor ${index + 1}`}</span>
                {display.isPrimary ? (
                  <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[9px] font-medium">
                    {translate(
                      'auto.components.floating.terminal.FloatingTerminalWindowControls.primaryDisplay',
                      'Primary'
                    )}
                  </Badge>
                ) : null}
              </div>
              {isCurrent ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
            </DropdownMenuItem>
          )
        })}
        {onIdentifyDisplays ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="flex cursor-pointer items-center gap-2 py-1.5 text-xs"
              onClick={onIdentifyDisplays}
            >
              <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
              <span>
                {translate(
                  'auto.components.floating.terminal.FloatingTerminalWindowControls.identifyDisplays',
                  'Identify Displays'
                )}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
        {onToggleDetached ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="flex cursor-pointer items-center gap-2 py-1.5 text-xs"
              onClick={onToggleDetached}
            >
              {isDetached ? (
                <>
                  <Minimize2 className="size-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    {translate(
                      'auto.components.floating.terminal.FloatingTerminalWindowControls.dock',
                      'Dock into main window'
                    )}
                  </span>
                </>
              ) : (
                <>
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    {translate(
                      'auto.components.floating.terminal.FloatingTerminalWindowControls.detach',
                      'Detach to separate window'
                    )}
                  </span>
                </>
              )}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
