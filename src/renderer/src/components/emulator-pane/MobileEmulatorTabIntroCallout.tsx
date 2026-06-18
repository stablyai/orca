import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useMobileEmulatorTabIntroActions } from './use-mobile-emulator-tab-intro-actions'

type MobileEmulatorTabIntroCalloutProps = {
  onAction?: () => void
}

export function MobileEmulatorTabIntroCallout({
  onAction
}: MobileEmulatorTabIntroCalloutProps): React.JSX.Element {
  const { keepIntro, hideIntro, dismissIntro } = useMobileEmulatorTabIntroActions()

  const runAndNotify = (action: () => void): void => {
    action()
    onAction?.()
  }

  return (
    <div
      className="mobile-emulator-tab-intro-callout--menu mt-1 flex items-center gap-2 rounded-lg border-x border-b border-border/70 bg-muted px-2 py-1.5 dark:bg-accent/80"
      // Why: Radix dropdown treats pointer-down inside custom panels as an
      // outside-select; keep the menu open while the user reads or clicks Keep/Hide.
      onPointerDown={(event) => event.preventDefault()}
    >
      <p className="min-w-0 flex-1 text-[11px] leading-4 text-foreground/85">
        {translate(
          'auto.components.emulator.pane.MobileEmulatorTabIntroCallout.5789936d9a',
          'Preview iOS simulators while agents drive the screen.'
        )}
      </p>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          onClick={() => runAndNotify(keepIntro)}
        >
          {translate(
            'auto.components.emulator.pane.MobileEmulatorTabIntroCallout.8014b4b80b',
            'Keep'
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px] text-muted-foreground"
          onClick={() => runAndNotify(hideIntro)}
        >
          {translate(
            'auto.components.emulator.pane.MobileEmulatorTabIntroCallout.6e051a40b7',
            'Hide'
          )}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.emulator.pane.MobileEmulatorTabIntroCallout.1924982130',
                'Dismiss'
              )}
              className="size-6 text-muted-foreground"
              onClick={() => runAndNotify(dismissIntro)}
            >
              <X className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.emulator.pane.MobileEmulatorTabIntroCallout.1924982130',
              'Dismiss'
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
