import type React from 'react'
import { useAppStore } from '@/store'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { getGeneralSidebarSearchEntries } from './general-sidebar-search'

type SidebarStyle = 'full' | 'rail'

export function SidebarStyleSetting(): React.JSX.Element {
  const t = useTranslate()
  const sidebarRail = useAppStore((s) => s.sidebarRail)
  const setSidebarRail = useAppStore((s) => s.setSidebarRail)
  const styleTitle = t('auto.components.settings.GeneralPane.sidebarStyle', 'Sidebar style')
  const styleDescription = t(
    'auto.components.settings.GeneralPane.sidebarStyleDescription',
    'Rail shows icons only.'
  )

  return (
    <SearchableSetting
      title={styleTitle}
      description={styleDescription}
      keywords={getGeneralSidebarSearchEntries()[0]?.keywords}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{styleTitle}</Label>
        <p className="text-xs text-muted-foreground">{styleDescription}</p>
      </div>
      <SettingsSegmentedControl<SidebarStyle>
        ariaLabel={styleTitle}
        value={sidebarRail ? 'rail' : 'full'}
        onChange={(style) => setSidebarRail(style === 'rail')}
        options={[
          {
            value: 'full',
            label: t('auto.components.settings.GeneralPane.sidebarStyleFull', 'Full')
          },
          {
            value: 'rail',
            label: t('auto.components.settings.GeneralPane.sidebarStyleRail', 'Rail')
          }
        ]}
      />
    </SearchableSetting>
  )
}
