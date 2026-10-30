import { TriangleAlert, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'

/** Dismissible Alpha notice at the top of Settings > Plugins; dismissal persists in UI state. */
export function PluginsAlphaNotice(): React.JSX.Element | null {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const dismissed = useAppStore((s) => s.pluginsAlphaNoticeDismissed)
  const dismiss = useAppStore((s) => s.dismissPluginsAlphaNotice)
  // Why: wait for hydration so a dismissed notice never flashes on open.
  if (!persistedUIReady || dismissed) {
    return null
  }
  return (
    <div
      role="note"
      className="flex items-center gap-3 rounded-xl border border-status-warning-border bg-status-warning-background py-1.5 pr-1.5 pl-4"
    >
      <TriangleAlert className="size-4 shrink-0 text-status-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-foreground">
        <span className="font-semibold text-status-warning-text">
          {translate('auto.components.settings.PluginsAlphaNotice.label', 'Alpha:')}
        </span>{' '}
        {translate(
          'auto.components.settings.PluginsAlphaNotice.body',
          'The plugin interface may change. Expect nuances.'
        )}
      </p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={translate(
          'auto.components.settings.PluginsAlphaNotice.dismiss',
          'Dismiss Alpha notice'
        )}
        onClick={dismiss}
      >
        <X />
      </Button>
    </div>
  )
}
