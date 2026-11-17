import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../store/index'
import { SettingsSwitchRow } from '../settings/form-controls/SettingsFormControls'
import { describeZotzVersion } from '../../../../shared/zotz/zotz-release-version'

/** "Zotz 1.4.21427 (Orca 1.4.214, build 27)"; development builds show only the version. */
export function ZotzVersionLabel({ version }: { version: string | null }): React.JSX.Element {
  const t = useTranslate()
  const parts = version ? describeZotzVersion(version) : null
  return (
    <span className="text-sm">
      {parts
        ? t('zotz.updater.versionWithBase', 'Zotz {{version}} (Orca {{base}}, build {{build}})', {
            version,
            base: parts.orcaBase,
            build: parts.build
          })
        : t('settings.general.about.version', 'Zotz {{version}}', { version: version ?? '…' })}
    </span>
  )
}

/** Settings → About: the switch for the fork's own updates (docs/zotz/UPDATES-SPEC.md §5.3). */
export function ZotzUpdatesSetting(): React.JSX.Element {
  const t = useTranslate()
  const enabled = useAppStore((s) => s.settings?.zotzUpdatesEnabled !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  return (
    <SettingsSwitchRow
      label={t('zotz.updater.toggleLabel', 'Check for and download new Zotz versions')}
      description={t(
        'zotz.updater.toggleDescription',
        'From the Zotz releases on GitHub, every 6 hours. Never restarts on its own; on a server it installs when no agent is working. Applies after restarting Zotz.'
      )}
      checked={enabled}
      onChange={() => void updateSettings({ zotzUpdatesEnabled: !enabled })}
    />
  )
}
