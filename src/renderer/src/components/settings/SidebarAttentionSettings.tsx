import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getHighlightWorkspacesNeedingAttentionEntry,
  getShowNeedsAttentionSectionEntry
} from './appearance-sidebar-attention-search'

type SidebarAttentionSettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function SidebarAttentionSettings({
  settings,
  updateSettings
}: SidebarAttentionSettingsProps): React.JSX.Element {
  const sectionEntry = getShowNeedsAttentionSectionEntry()
  const highlightEntry = getHighlightWorkspacesNeedingAttentionEntry()
  return (
    <>
      <SearchableSetting
        title={sectionEntry.title}
        description={sectionEntry.description}
        keywords={sectionEntry.keywords}
      >
        <SettingsSwitchRow
          label={sectionEntry.title}
          description={sectionEntry.description}
          checked={settings.showNeedsAttentionSection === true}
          onChange={() =>
            updateSettings({
              showNeedsAttentionSection: !(settings.showNeedsAttentionSection === true)
            })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={highlightEntry.title}
        description={highlightEntry.description}
        keywords={highlightEntry.keywords}
      >
        <SettingsSwitchRow
          label={highlightEntry.title}
          description={highlightEntry.description}
          checked={settings.highlightWorkspacesNeedingAttention === true}
          onChange={() =>
            updateSettings({
              highlightWorkspacesNeedingAttention: !(
                settings.highlightWorkspacesNeedingAttention === true
              )
            })
          }
        />
      </SearchableSetting>
    </>
  )
}
