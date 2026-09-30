import { Crosshair, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { GrabIntent } from '../describe-page/browser-page-types'

/** The in-guest element picker, driving both Grab (copy) and Annotate (comment). */
export type BrowserChromeElementTools = {
  /** The intent the picker is armed for right now, or null when it is idle. */
  activeIntent: GrabIntent | null
  onStartIntent: (intent: GrabIntent) => void
  disabled: boolean
  grabShortcutLabel: string
  annotationCount: number
}

export function BrowserChromeElementToolButtons({
  tools,
  showGrab,
  showAnnotate,
  showTourAnchors
}: {
  tools: BrowserChromeElementTools
  showGrab: boolean
  showAnnotate: boolean
  showTourAnchors: boolean
}): React.JSX.Element {
  return (
    <>
      {showGrab ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                size="icon"
                variant={tools.activeIntent === 'copy' ? 'default' : 'ghost'}
                className={cn(
                  'h-8 w-8',
                  tools.activeIntent === 'copy' &&
                    'bg-foreground/80 text-background hover:bg-foreground/90'
                )}
                onClick={() => tools.onStartIntent('copy')}
                disabled={tools.disabled}
                aria-label={translate(
                  'auto.components.browser.pane.BrowserPane.fdfc7fe0ef',
                  'Grab page element'
                )}
                {...(showTourAnchors
                  ? { 'data-contextual-tour-target': 'browser-grab-control' }
                  : {})}
              >
                <Crosshair className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate(
              'auto.components.browser.pane.BrowserPane.acbe79fd01',
              'Grab page element ({{value0}})',
              { value0: tools.grabShortcutLabel }
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}

      {showAnnotate ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Why: disabled buttons drop hover events, so the tooltip needs an enabled wrapper. */}
            <span className="inline-flex">
              <Button
                size="icon"
                variant={tools.activeIntent === 'annotate' ? 'default' : 'ghost'}
                className={cn(
                  'relative h-8 w-8',
                  tools.activeIntent === 'annotate' &&
                    'bg-foreground/80 text-background hover:bg-foreground/90'
                )}
                onClick={() => tools.onStartIntent('annotate')}
                disabled={tools.disabled}
                aria-label={translate(
                  'auto.components.browser.pane.BrowserPane.fc9be38f6f',
                  'Annotate page element'
                )}
                {...(showTourAnchors
                  ? { 'data-contextual-tour-target': 'browser-annotation-control' }
                  : {})}
              >
                <MessageSquarePlus className="size-4" />
                {tools.annotationCount > 0 ? (
                  <span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
                    {tools.annotationCount}
                  </span>
                ) : null}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate(
              'auto.components.browser.pane.BrowserPane.fc9be38f6f',
              'Annotate page element'
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}
