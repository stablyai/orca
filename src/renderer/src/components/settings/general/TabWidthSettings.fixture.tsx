import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { TabWidthSettings } from './TabWidthSettings'

const noop = (): void => {}

export const fitSelected = defineFixture({
  width: 680,
  render: () => (
    <div className="settings-view-shell bg-background p-4">
      <SettingsGroup title="Tabs">
        <TabWidthSettings
          settings={{
            ...getDefaultSettings('/home/fixture'),
            tabWidthMode: 'fit',
            tabMaxWidth: 240
          }}
          updateSettings={noop}
        />
      </SettingsGroup>
    </div>
  )
})
