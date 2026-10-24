import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import type { PluginListEntry } from './plugin-list-entries'

/** Dev, Bundled and Unverified facts beside a plugin's name. */
export function PluginChips({ entry }: { entry: PluginListEntry }): React.JSX.Element {
  const installed = entry.installed
  const unverified = !entry.official && !installed?.bundled
  return (
    <>
      {installed?.isDev ? (
        <Badge variant="hostContext">
          {translate('auto.components.settings.PluginSettingsRow.dev', 'Dev')}
        </Badge>
      ) : null}
      {installed?.bundled ? (
        <Badge variant="hostContext">
          {translate('auto.components.settings.PluginSettingsRow.bundled', 'Bundled')}
        </Badge>
      ) : null}
      {unverified ? (
        <Badge variant="hostContext">
          {translate('auto.components.settings.PluginManagerRows.unverified', 'Unverified')}
        </Badge>
      ) : null}
    </>
  )
}
