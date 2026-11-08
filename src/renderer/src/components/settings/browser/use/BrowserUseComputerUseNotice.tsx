import { MousePointerClick } from 'lucide-react'
import { Button } from '../../../ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function BrowserUseComputerUseNotice({
  onOpenComputerUse
}: {
  onOpenComputerUse: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {t(
              'auto.components.settings.BrowserUseComputerUseNotice.333984cf90',
              'Use an existing browser session'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.BrowserUseComputerUseNotice.79209b37b9',
              'If cookie import is not the right fit, Computer Use can control local apps and may use existing logged-in browser sessions where applicable. Install the Orca Computer Use skill; macOS also requires privacy permissions.'
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenComputerUse}
          className="shrink-0 gap-1.5 self-start"
        >
          <MousePointerClick className="size-3.5" />
          {t(
            'auto.components.settings.BrowserUseComputerUseNotice.15b5e680ba',
            'Open Computer Use'
          )}
        </Button>
      </div>
    </div>
  )
}
