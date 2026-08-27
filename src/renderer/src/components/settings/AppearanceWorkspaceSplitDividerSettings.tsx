import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK,
  DEFAULT_TAB_GROUP_SPLIT_DIVIDER_LIGHT
} from '../../../../shared/tab-group-split-divider'
import { ColorField } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getWorkspaceSplitDividerEntries } from './appearance-search'

export function AppearanceWorkspaceSplitDividerSettings({
  settings,
  updateSettings,
  forceVisiblePrimary = false
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisiblePrimary?: boolean
}): React.JSX.Element {
  const [darkEntry, lightEntry] = getWorkspaceSplitDividerEntries()

  return (
    <>
      <SearchableSetting
        title={darkEntry.title}
        description={darkEntry.description}
        keywords={darkEntry.keywords}
        forceVisible={forceVisiblePrimary}
      >
        <ColorField
          label={darkEntry.title}
          description={darkEntry.description ?? ''}
          value={settings.tabGroupSplitDividerColorDark}
          fallback={DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK}
          onChange={(value) => updateSettings({ tabGroupSplitDividerColorDark: value })}
        />
      </SearchableSetting>
      <SearchableSetting
        title={lightEntry.title}
        description={lightEntry.description}
        keywords={lightEntry.keywords}
        forceVisible={forceVisiblePrimary}
      >
        <ColorField
          label={lightEntry.title}
          description={lightEntry.description ?? ''}
          value={settings.tabGroupSplitDividerColorLight}
          fallback={DEFAULT_TAB_GROUP_SPLIT_DIVIDER_LIGHT}
          onChange={(value) => updateSettings({ tabGroupSplitDividerColorLight: value })}
        />
      </SearchableSetting>
    </>
  )
}
