import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

const settings = getDefaultSettings('/home/fixture')

export const off = defineFixture({
  width: 640,
  store: { settings, updateStatus: { state: 'not-available' } },
  render: () => <GeneralUpdateSettingsSection />
})

export const on = defineFixture({
  ...off,
  store: { ...off.store, settings: { ...settings, installUpdatesWhenAway: true } }
})
