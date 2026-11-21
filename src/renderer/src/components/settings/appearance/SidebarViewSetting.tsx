import type React from 'react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { useSidebarBodyTitles } from '@/components/sidebar/chrome/sidebar-view-titles'
import type { SidebarView } from '../../../../../shared/ui-chrome/sidebar-body'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getSidebarViewEntry } from './appearance-sidebar-search'

/** The sidebar's title menu picks the same view, so both read and write sidebarView. */
export function SidebarViewSetting({
  forceVisible = false
}: {
  forceVisible?: boolean
}): React.JSX.Element {
  const sidebarView = useAppStore((s) => s.sidebarView)
  const chooseSidebarView = useAppStore((s) => s.chooseSidebarView)
  const t = useTranslate()
  const titles = useSidebarBodyTitles()
  const entry = getSidebarViewEntry(t)
  return (
    <SearchableSetting {...entry} forceVisible={forceVisible}>
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <SettingsSegmentedControl<SidebarView>
            size="sm"
            value={sidebarView}
            onChange={chooseSidebarView}
            ariaLabel={entry.title}
            options={[
              { value: 'workspaces', label: titles.workspaces },
              { value: 'conversations', label: titles.conversations }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
