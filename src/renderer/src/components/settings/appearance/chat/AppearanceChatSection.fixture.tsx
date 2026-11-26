import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../../store/index'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { AppearanceChatSection } from './AppearanceChatSection'

export const appearance = defineFixture({
  width: 800,
  render: () => (
    <div className="settings-view-shell p-8">
      <SettingsGroup>
        <AppearanceChatSection
          settings={useAppStore.getState().settings!}
          updateSettings={() => {}}
          fontSuggestions={[]}
          forceVisiblePrimary
        />
      </SettingsGroup>
    </div>
  )
})
