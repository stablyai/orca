import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { SettingsTransferSection } from './SettingsTransferSection'

export const idle = defineFixture({
  width: 760,
  render: () => (
    <SettingsGroup title="Settings File">
      <SettingsTransferSection updateSettings={() => {}} />
    </SettingsGroup>
  )
})
