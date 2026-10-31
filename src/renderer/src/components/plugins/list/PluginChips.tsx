import { translate } from '@/i18n/i18n'
import { Badge } from '../../ui/badge'
import type { PluginListEntry, PluginVerifiedSource } from './plugin-list-entries'

/** Where a plugin's trust comes from; null when the Official mark or Bundled chip already says it. */
export function pluginVerifiedSourceLabel(source: PluginVerifiedSource): string | null {
  switch (source.kind) {
    case 'official':
    case 'bundled':
      return null
    case 'dev':
      return translate('auto.components.settings.PluginChips.devUnverified', 'Dev · unverified')
    case 'unverified':
      return translate('auto.components.settings.PluginManagerRows.unverified', 'Unverified')
    case 'catalog':
      return (
        [source.catalog, source.owner].filter(Boolean).join(' · ') ||
        translate('auto.components.settings.PluginManagerRows.unverified', 'Unverified')
      )
  }
}

/** Source, Bundled and auto-update facts beside a plugin's name. */
export function PluginChips({ entry }: { entry: PluginListEntry }): React.JSX.Element {
  const installed = entry.installed
  const source = pluginVerifiedSourceLabel(entry.verifiedSource)
  return (
    <>
      {source ? (
        <Badge variant="hostContext" data-plugin-verified-source={entry.verifiedSource.kind}>
          {source}
        </Badge>
      ) : null}
      {installed?.bundled ? (
        <Badge variant="hostContext">
          {translate('auto.components.settings.PluginSettingsRow.bundled', 'Bundled')}
        </Badge>
      ) : null}
      {entry.autoUpdate.needsReview ? (
        <Badge variant="hostContext">
          {translate(
            'auto.components.settings.PluginChips.updateNeedsReview',
            'Update needs review'
          )}
        </Badge>
      ) : entry.autoUpdate.updatedTo ? (
        <Badge variant="hostContext">
          {translate('auto.components.settings.PluginChips.updatedTo', 'Updated to {{value0}}', {
            value0: entry.autoUpdate.updatedTo
          })}
        </Badge>
      ) : null}
    </>
  )
}
