import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { getSidebarProjectColorAccentsEntry } from './appearance-sidebar-search'

/** Opt-in project color rail and header tint for the project-grouped sidebar. */
export function SidebarProjectColorAccentsSetting(): React.JSX.Element {
  const t = useTranslate()
  const updateSettings = useAppStore((state) => state.updateSettings)
  // Why: reads the store directly so the crowded sidebar section only has to place it.
  const enabled = useAppStore((state) => state.settings?.sidebarProjectColorAccents === true)
  const entry = getSidebarProjectColorAccentsEntry()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <SettingsSwitchRow
        label={t(
          'auto.components.settings.AppearancePane.sidebarProjectColorAccents.title',
          'Project color accents'
        )}
        description={t(
          'auto.components.settings.AppearancePane.sidebarProjectColorAccents.description',
          'When grouped by project, outline each project with its badge color.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ sidebarProjectColorAccents: !enabled })}
      />
    </SearchableSetting>
  )
}
