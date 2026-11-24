import React, { useEffect } from 'react'
import { PenTool } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { useMarkupDrawHint } from './use-markup-draw-hint'

/** Once-per-install Draw discovery, anchored to whichever control starts Draw on this surface. */
export function useMarkupDrawHintState(
  surfaceActive: boolean,
  eligible: boolean
): { showHint: boolean; dismissHint: () => void } {
  // Offer discovery only while visible and usable, so a hidden pane cannot consume the one-time hint.
  const { hintOpen, dismissHint } = useMarkupDrawHint(surfaceActive && eligible)
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

  return { showHint, dismissHint }
}

export function MarkupDrawHintPopover({
  open,
  onDismiss,
  onStart,
  children
}: {
  open: boolean
  onDismiss: () => void
  onStart: () => void
  /** The anchor; kept mounted so portaled content never anchors at the viewport origin. */
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.browser-pane.markup.drawButton', 'Draw on screenshot')
  return (
    <Popover
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onDismiss()
        }
      }}
    >
      <PopoverAnchor asChild>{children}</PopoverAnchor>
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
                {t('auto.components.browser-pane.markup.drawHintBadge', 'New')}
              </Badge>
              <div className="text-sm font-medium text-foreground">{label}</div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t(
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
              onClick={onStart}
            >
              <PenTool className="size-3.5" />
              {t('auto.components.browser-pane.markup.drawHintTry', 'Try it')}
            </Button>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('auto.components.browser-pane.markup.drawHintDismiss', 'Got it')}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
