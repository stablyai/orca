import { getDefaultSettings } from '../../../../../shared/constants'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { AppearanceInterfaceSection } from './AppearanceInterfaceSection'

const settings = getDefaultSettings('/home/fixture')

export const languageMenu = defineFixture({
  width: 800,
  render: () => (
    <SettingsGroup>
      <AppearanceInterfaceSection
        settings={settings}
        updateSettings={() => {}}
        applyTheme={() => {}}
        fontSuggestions={[]}
        isDesktopMac={false}
        isDesktopWindows={false}
      />
    </SettingsGroup>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Language"]')?.click()
  }
})
