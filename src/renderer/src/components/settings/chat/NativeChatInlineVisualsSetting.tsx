import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { useAppStore } from '../../../store/index'
import { matchesSettingsSearch } from '../search/settings-search'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { getChatInlineVisualsSearchEntry } from './chat-inline-visuals-search'

type NativeChatInlineVisualsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}

export function NativeChatInlineVisualsSetting({
  settings,
  updateSettings,
  forceVisible = false
}: NativeChatInlineVisualsSettingProps): React.JSX.Element | null {
  const t = useTranslate()
  const enabled = settings.nativeChatInlineVisuals !== false
  const entry = getChatInlineVisualsSearchEntry()
  const query = useAppStore((state) => state.settingsSearchQuery)
  // Skip the whole group, not just its row, so a filtered-out row leaves no empty slot.
  if (!forceVisible && !matchesSettingsSearch(query, [entry])) {
    return null
  }
  return (
    <SettingsGroup>
      <SearchableSetting
        {...entry}
        id="chat-inline-visuals"
        forceVisible={forceVisible}
        className="max-w-none"
      >
        <SettingsSwitchRow
          label={entry.title}
          description={entry.description}
          checked={enabled}
          ariaLabel={t(
            'components.settings.nativeChat.inlineVisualsToggleLabel',
            'Toggle inline visuals'
          )}
          onChange={() => updateSettings({ nativeChatInlineVisuals: !enabled })}
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
