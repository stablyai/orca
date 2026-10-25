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
  /** Explicitly gate on pane activity: a hidden trigger anchors portaled content at the viewport origin. */
  surfaceActive: boolean
  className?: string
}

export function MarkupDrawButton({
  onClick,
  disabled,
  active,
  surfaceActive,
  className
}: MarkupDrawButtonProps): React.JSX.Element {
  const label = translate('auto.components.browser-pane.markup.drawButton', 'Draw on screenshot')
  // Offer discovery only while visible and usable, so a hidden pane cannot consume the one-time hint.
  const { hintOpen, dismissHint } = useMarkupDrawHint(surfaceActive && !disabled && !active)
  // Gate synchronously: BrowserPane becomes inert/hidden in this commit, before the hint hook’s effect.
  const showHint = hintOpen && surfaceActive

  // Guest clicks bypass renderer outside-click detection; window blur dismisses when focus enters the guest.
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

  // Keep Popover/Tooltip roots mounted to preserve the trigger; the popover provides dismissal that a forced-open tooltip lacks.
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
