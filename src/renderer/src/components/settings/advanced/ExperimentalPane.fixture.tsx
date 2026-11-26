import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { ExperimentalPane } from './ExperimentalPane'

const settings = {
  ...getDefaultSettings('/home/test'),
  experimentalOrchestrationPanel: true
}

export const orchestrationPanelSuspended = defineFixture({
  width: 760,
  store: { settings },
  render: () => <ExperimentalPane settings={settings} updateSettings={() => {}} />
})

const newUserSettings = getDefaultSettings('/home/test')

/** A new user: Agent Dashboard and Terminal attention are not offered. */
export const newUserHidesOptInOnlyExperiments = defineFixture({
  width: 760,
  store: { settings: newUserSettings },
  render: () => <ExperimentalPane settings={newUserSettings} updateSettings={() => {}} />
})

const optedInSettings = {
  ...getDefaultSettings('/home/test'),
  experimentalAgentDashboardPopout: true,
  experimentalTerminalAttention: true
}

/** A user who already turned both on keeps both rows. */
export const optedInKeepsOptInOnlyExperiments = defineFixture({
  width: 760,
  store: { settings: optedInSettings },
  render: () => <ExperimentalPane settings={optedInSettings} updateSettings={() => {}} />
})
