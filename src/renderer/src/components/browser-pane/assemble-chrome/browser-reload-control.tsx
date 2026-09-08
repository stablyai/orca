import type { Dispatch, SetStateAction } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/**
 * Reload as browsers do it: left-click reloads, right-click offers the harder variant. Shared so
 * both guest surfaces get the same gesture — what "hard" means is the caller's to define.
 */
export function BrowserReloadControl({
  menuOpen,
  onMenuOpenChange,
  label,
  loading,
  showShortcutHint,
  reloadShortcut,
  hardReloadShortcut,
  onPrimary,
  onReload,
  onHardReload
}: {
  menuOpen: boolean
  onMenuOpenChange: Dispatch<SetStateAction<boolean>>
  label: string
  loading: boolean
  /** The chord maps to plain reload, which is not what Stop or Retry do — hint only when they match. */
  showShortcutHint: boolean
  reloadShortcut: string
  hardReloadShortcut: string
  onPrimary: () => void
  onReload: () => void
  onHardReload: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu modal={false} open={menuOpen} onOpenChange={onMenuOpenChange}>
      {/* Why: suppress the tooltip while the menu is open — both anchor below the button and would overlap. */}
      <Tooltip open={menuOpen ? false : undefined}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={label}
              // Why: preventDefault suppresses Radix's open-on-left-click (composeEventHandlers skips its
              // handler once defaultPrevented), keeping left-click on the primary action and the menu on right-click.
              onPointerDown={(e) => {
                if (e.button === 0) {
                  e.preventDefault()
                }
              }}
              // Why: same trick for Radix's open-on-Enter/Space, which would otherwise preventDefault the
              // synthesized click and strand keyboard users. ArrowDown still falls through to open the menu.
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onPrimary()
                }
              }}
              onClick={onPrimary}
              onContextMenu={(e) => {
                e.preventDefault()
                onMenuOpenChange(true)
              }}
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
          {reloadShortcut && showShortcutHint ? ` · ${reloadShortcut}` : ''}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" alignOffset={-4}>
        <DropdownMenuItem onClick={onReload}>
          {translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
          <DropdownMenuShortcut>{reloadShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onHardReload}>
          {translate('auto.components.browser.pane.BrowserPane.a1f3c2e4b5', 'Hard Reload')}
          <DropdownMenuShortcut>{hardReloadShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
