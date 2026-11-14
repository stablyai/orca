import type { SettingsSearchEntry } from '../search/settings-search'
import { getHoldQuitEntries } from './general-hold-quit-search'
import { getGeneralConfirmationSearchEntries } from './general-confirmations-search'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { matchesSettingsSearch } from '../search/settings-search'

export function GeneralConfirmationsSection({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const entries = getGeneralConfirmationSearchEntries()
  const rows: (SettingsSearchEntry & { id?: string; checked: boolean; onChange: () => void })[] = [
    ...getHoldQuitEntries().map((entry) => ({
      ...entry,
      checked: settings.holdQuitWhileAgentsWork === true,
      onChange: () =>
        updateSettings({ holdQuitWhileAgentsWork: settings.holdQuitWhileAgentsWork !== true })
    })),
    {
      ...entries.pinned,
      checked: settings.confirmClosePinnedTab ?? true,
      onChange: () =>
        updateSettings({ confirmClosePinnedTab: !(settings.confirmClosePinnedTab ?? true) })
    },
    {
      ...entries.running,
      checked: !settings.skipCloseTerminalWithRunningProcessConfirm,
      onChange: () =>
        updateSettings({
          skipCloseTerminalWithRunningProcessConfirm:
            !settings.skipCloseTerminalWithRunningProcessConfirm
        })
    },
    {
      ...entries.workspace,
      checked: !settings.skipDeleteWorktreeConfirm,
      onChange: () =>
        updateSettings({ skipDeleteWorktreeConfirm: !settings.skipDeleteWorktreeConfirm })
    },
    {
      ...entries.automation,
      checked: !settings.skipDeleteAutomationConfirm,
      onChange: () =>
        updateSettings({ skipDeleteAutomationConfirm: !settings.skipDeleteAutomationConfirm })
    },
    {
      ...entries.artifact,
      checked: !settings.skipDeleteArtifactConfirm,
      onChange: () =>
        updateSettings({ skipDeleteArtifactConfirm: !settings.skipDeleteArtifactConfirm })
    }
  ].filter((row) => matchesSettingsSearch(query, row))
  if (rows.length === 0) {
    return null
  }
  return (
    <SettingsGroup title={t('settings.general.confirmations.title', 'Confirmations')}>
      {rows.map((row) => (
        <SearchableSetting
          key={row.id ?? row.title}
          id={row.id}
          title={row.title}
          description={row.description}
          keywords={row.keywords}
        >
          <SettingsSwitchRow
            label={row.title}
            description={row.description}
            checked={row.checked}
            onChange={row.onChange}
          />
        </SearchableSetting>
      ))}
    </SettingsGroup>
  )
}
