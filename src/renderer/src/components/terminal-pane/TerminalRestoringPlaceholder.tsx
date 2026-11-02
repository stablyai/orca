import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/** Fills a terminal tab's slot while startup restoration holds its pane unmounted. */
export function TerminalRestoringPlaceholder(): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
      data-terminal-restoring-placeholder=""
    >
      <Loader2 className="size-4 animate-spin" />
      {translate(
        'auto.components.terminal.pane.TerminalRestoringPlaceholder.restoring',
        'Restoring terminal…'
      )}
    </div>
  )
}
