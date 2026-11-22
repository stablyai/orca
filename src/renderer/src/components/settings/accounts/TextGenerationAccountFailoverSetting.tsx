import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { matchesSettingsSearch } from '../search/settings-search'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import {
  getHostSettingUnsupportedNote,
  getHostSettingUpdateFailedMessage,
  useHostSetting,
  useSettingsHostLabel
} from '../host-scope/use-host-setting'
import { getAccountsTextFailoverSearchEntries } from './accounts-text-failover-search'

/** The host runs the text helpers and owns the saved accounts, so the switch reads and writes that host. */
export function TextGenerationAccountFailoverSetting({
  hostScope
}: {
  hostScope: SettingsHostScope
}): React.JSX.Element | null {
  const t = useTranslate()
  const entries = getAccountsTextFailoverSearchEntries()
  const [search] = entries
  const settings = useAppStore((state) => state.settings)
  const updateSettingsOrThrow = useAppStore((state) => state.updateSettingsOrThrow)
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  const hostLabel = useSettingsHostLabel(hostScope.target)
  const { setting, update } = useHostSetting({
    owner: hostScope.target,
    settingKey: 'textGenerationSubscriptionFailoverEnabled',
    localSettings: settings ?? {},
    updateLocalSettings: updateSettingsOrThrow,
    updateFailedMessage: getHostSettingUpdateFailedMessage(hostLabel, t)
  })
  if (!matchesSettingsSearch(query, entries)) {
    return null
  }
  const enabled = setting.state === 'ready' && setting.value
  return (
    <SettingsGroup>
      <SearchableSetting {...search}>
        <SettingsSwitchRow
          label={search.title}
          description={
            setting.state === 'unsupported'
              ? getHostSettingUnsupportedNote(hostLabel, t)
              : search.description
          }
          checked={enabled}
          disabled={setting.state !== 'ready' || !hostScope.available}
          onChange={() => void update(!enabled)}
          ariaLabel={search.title}
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
