import { toast } from 'sonner'
import { create } from 'zustand'
import { translate } from '@/i18n/i18n'
import { openPluginsSettings } from '@/components/settings/navigation/open-plugins-settings'

export const useRequiredPluginFailures = create<{ pluginKeys: readonly string[] }>(() => ({
  pluginKeys: []
}))

let watching = false

export function ensureRequiredPluginFailuresWatched(): void {
  const plugins = window.api?.plugins
  const take = plugins?.takeRequiredPluginFailures
  if (watching || !take) {
    return
  }
  watching = true
  const refresh = (): void => {
    void take()
      .then(({ pluginKeys, notify }) => {
        useRequiredPluginFailures.setState({ pluginKeys })
        if (notify) {
          toast.warning(
            translate('plugins.requiredFailures.toast', 'A required plugin could not be installed'),
            {
              action: {
                label: translate('plugins.requiredFailures.open', 'Open Plugins'),
                onClick: openPluginsSettings
              }
            }
          )
        }
      })
      // Older hosts have no required-plugin warnings.
      .catch(() => undefined)
  }
  plugins.onChanged((event) => {
    if (event.requiredPluginFailuresChanged) {
      refresh()
    }
  })
  refresh()
}
