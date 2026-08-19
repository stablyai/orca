import React, { useEffect } from 'react'
import { PenTool } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useMarkupDrawHint } from './use-markup-draw-hint'

export type MarkupDrawButtonProps = {
  onClick: () => void
  disabled?: boolean
  active?: boolean
  /**
   * The browser pane's isActive. Required (no default) so every caller must
   * decide explicitly — inactive/hidden tabs cannot force-open a portaled
   * layer against a zero-size trigger (which lands at the viewport origin).
   */
  surfaceActive: boolean
  className?: string
}

// Toolbar toggle that enters screenshot-markup mode. Shared by the local and
// remote browser panes so both expose the same affordance.
export function MarkupDrawButton({
  onClick,
  disabled,
  active,
  surfaceActive,
  className
}: MarkupDrawButtonProps): React.JSX.Element {
  const label = translate('auto.components.browser-pane.markup.drawButton', 'Draw on screenshot')
  // Why: nudge the button the first time it's usable on a visible surface so
  // users discover the tool without pinning a tooltip to a hidden pane.
  const { hintOpen, dismissHint } = useMarkupDrawHint(surfaceActive && !disabled && !active)
  // Why: close synchronously off the same `surfaceActive` render instead of
  // waiting on the hook's effect — BrowserPane sets inert/hidden on the pane
  // in the same commit isActive flips, so a one-tick delay would let the
  // popover anchor briefly against an already-hidden trigger.
  const showHint = hintOpen && surfaceActive

  // Why: Electron <webview> clicks never reach the renderer document, so
  // Radix outside-click dismiss misses them. Window blur covers focus leaving
  // the renderer into the guest (same pattern as BrowserImportHintButton).
  useEffect(() => {
    if (!showHint) {
      return
    }
    window.addEventListener('blur', dismissHint)
    return () => window.removeEventListener('blur', dismissHint)
  }, [dismissHint, showHint])

  const startMarkup = (): void => {
    dismissHint()
    onClick()
  }

  const button = (
    <Button
      size="icon"
      variant={active ? 'default' : 'ghost'}
      className={cn(
        className ?? 'h-8 w-8',
        active && 'bg-foreground/80 text-background hover:bg-foreground/90',
        // Why: soft ring while the discovery callout is open — points at the
        // control without the harsh solid highlight of a force-open tooltip.
        showHint && 'ring-2 ring-ring/45 ring-offset-1 ring-offset-background'
      )}
      onClick={startMarkup}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
    >
      <PenTool className="size-4" />
    </Button>
  )

  // Discovery uses a dismissable popover (outside click / Escape / blur / act)
  // instead of a force-open tooltip — tooltips stay stuck when controlled open
  // and mis-position against hidden triggers. Styled like BrowserImportHint
  // (surface + title + body + actions), not an inverted tooltip chip.
  //
  // Why: Popover and Tooltip stay mounted as one persistent tree (matching
  // WorkspaceStatusAppearancePopover's Tooltip-wrapping-Popover pattern)
  // instead of switching root element types on `hintOpen` — swapping roots
  // would unmount/remount the trigger button at the exact moments the hint
  // is meant to draw the user's attention to it.
  return (
    <Popover
      modal={false}
      open={showHint}
      onOpenChange={(open) => {
        if (!open) {
          dismissHint()
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {/* Why: wrap in a span so the trigger still fires when disabled. */}
            <span className="inline-flex">{button}</span>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={6}
        className="w-72 p-3"
        onOpenAutoFocus={(event) => {
          // Why: don't steal focus from the address bar / webview on first show.
          event.preventDefault()
        }}
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className="h-5 shrink-0 px-1.5 text-[10px] font-semibold tracking-wider uppercase"
              >
                {translate('auto.components.browser-pane.markup.drawHintBadge', 'New')}
              </Badge>
              <div className="text-sm font-medium text-foreground">{label}</div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {translate(
                'auto.components.browser-pane.markup.drawHint',
                'Draw on the page, then copy the markup to paste into your agent.'
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={startMarkup}
            >
              <PenTool className="size-3.5" />
              {translate('auto.components.browser-pane.markup.drawHintTry', 'Try it')}
            </Button>
            <button
              type="button"
              onClick={dismissHint}
              className="rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            >
              {translate('auto.components.browser-pane.markup.drawHintDismiss', 'Got it')}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
