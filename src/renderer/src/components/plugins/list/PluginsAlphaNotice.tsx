import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { PluginWarningBanner } from '../review/PluginWarningBanner'

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
    <PluginWarningBanner
      label={translate('auto.components.settings.PluginsAlphaNotice.label', 'Alpha:')}
      body={translate(
        'auto.components.settings.PluginsAlphaNotice.body',
        'The plugin interface may change. Expect nuances.'
      )}
      dismissLabel={translate(
        'auto.components.settings.PluginsAlphaNotice.dismiss',
        'Dismiss Alpha notice'
      )}
      onDismiss={dismiss}
    />
  )
}
