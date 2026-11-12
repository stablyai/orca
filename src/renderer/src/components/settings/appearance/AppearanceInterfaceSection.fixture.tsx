import { getDefaultSettings } from '../../../../../shared/constants'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AppearanceInterfaceSection } from './AppearanceInterfaceSection'

const settings = getDefaultSettings('/home/fixture')

export const languageMenu = defineFixture({
  width: 800,
  render: () => (
    <AppearanceInterfaceSection
      settings={settings}
      updateSettings={() => {}}
      applyTheme={() => {}}
      fontSuggestions={[]}
      isDesktopMac={false}
      isDesktopWindows={false}
    />
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Language"]')?.click()
  }
})
