import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { PluginWarningBanner } from '../review/PluginWarningBanner'

/** Dismissible Alpha notice at the top of Settings > Plugins; dismissal persists in UI state. */
export function PluginsAlphaNotice(): React.JSX.Element | null {
  const t = useTranslate()
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const dismissed = useAppStore((s) => s.pluginsAlphaNoticeDismissed)
  const dismiss = useAppStore((s) => s.dismissPluginsAlphaNotice)
  // Why: wait for hydration so a dismissed notice never flashes on open.
  if (!persistedUIReady || dismissed) {
    return null
  }
  return (
    <PluginWarningBanner
      label={t('auto.components.settings.PluginsAlphaNotice.label', 'Alpha:')}
      body={t(
        'auto.components.settings.PluginsAlphaNotice.body',
        'The plugin interface may change. Expect nuances.'
      )}
      dismissLabel={t(
        'auto.components.settings.PluginsAlphaNotice.dismiss',
        'Dismiss Alpha notice'
      )}
      onDismiss={dismiss}
    />
  )
}
