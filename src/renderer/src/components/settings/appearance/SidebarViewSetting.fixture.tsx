import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { BuiltInUiLanguage } from '../../../../../shared/i18n/ui-language'
import { useTranslate } from '@/i18n/use-translate'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { LeftSidebarAppearanceSetting } from './LeftSidebarAppearanceSetting'
import { SidebarViewSetting } from './SidebarViewSetting'

const settings = getDefaultSettings('/home/fixture')

// The first rows of Appearance's Window & sidebar group.
function WindowSidebarGroupTop(): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup
      title={t('auto.components.settings.AppearancePane.e90c5d745a', 'Window & sidebar')}
    >
      <SidebarViewSetting />
      <LeftSidebarAppearanceSetting settings={settings} updateSettings={() => {}} />
    </SettingsGroup>
  )
}

function windowSidebarGroup(language: BuiltInUiLanguage) {
  return defineFixture({
    width: 800,
    store: {
      settings: { ...settings, uiLanguage: language },
      sidebarView: 'conversations',
      sidebarBody: 'conversations'
    },
    render: () => <WindowSidebarGroupTop />
  })
}

export const sessionsPicked = windowSidebarGroup('en')
export const sessionsPickedRussian = windowSidebarGroup('ru')
