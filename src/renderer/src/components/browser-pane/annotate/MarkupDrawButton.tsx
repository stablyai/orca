import React from 'react'
import { PenTool } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { MarkupDrawHintPopover, useMarkupDrawHintState } from './markup-draw-hint-popover'

export type MarkupDrawButtonProps = {
  onClick: () => void
  disabled?: boolean
  active?: boolean
  /** Explicitly gate on pane activity: a hidden trigger anchors portaled content at the viewport origin. */
  surfaceActive: boolean
  className?: string
}

/** Standalone Draw for surfaces without the element picker (remote and client-hosted pages). */
export function MarkupDrawButton({
  onClick,
  disabled,
  active,
  surfaceActive,
  className
}: MarkupDrawButtonProps): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.browser-pane.markup.drawButton', 'Draw on screenshot')
  const { showHint, dismissHint } = useMarkupDrawHintState(surfaceActive, !disabled && !active)

  const startMarkup = (): void => {
    dismissHint()
    onClick()
  }

  return (
    <MarkupDrawHintPopover open={showHint} onDismiss={dismissHint} onStart={startMarkup}>
      <span className="inline-flex">
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Why: wrap in a span so the tooltip still fires when disabled. */}
            <span className="inline-flex">
              <Button
                size="icon"
                variant={active ? 'default' : 'ghost'}
                className={cn(
                  className ?? 'h-7 w-7',
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
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {label}
          </TooltipContent>
        </Tooltip>
      </span>
    </MarkupDrawHintPopover>
  )
}
