import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

/** Fills a terminal tab's slot while startup restoration holds its pane unmounted. */
export function TerminalRestoringPlaceholder(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
      data-terminal-restoring-placeholder=""
    >
      <Loader2 className="size-4 animate-spin" />
      {t(
        'auto.components.terminal.pane.TerminalRestoringPlaceholder.restoring',
        'Restoring terminal…'
      )}
    </div>
  )
}
