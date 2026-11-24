import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

function fixtureWith(overrides: Partial<GlobalSettings>) {
  return {
    width: 640,
    store: {
      settings: { ...getDefaultSettings('/home/fixture'), ...overrides },
      updateStatus: { state: 'not-available' as const }
    },
    render: () => <GeneralUpdateSettingsSection />
  }
}

export const enabled = defineFixture(fixtureWith({ automaticUpdates: true }))

export const waitingUntilAway = defineFixture(
  fixtureWith({ automaticUpdates: true, automaticUpdatesWaitUntilAway: true })
)
