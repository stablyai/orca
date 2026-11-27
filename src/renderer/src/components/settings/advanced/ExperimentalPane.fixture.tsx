import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { ExperimentalPane } from './ExperimentalPane'
import { getOptInOnlyExperimentVisibility } from './experimental-search'

function Pane({ settings }: { settings: GlobalSettings }): React.JSX.Element {
  return (
    <ExperimentalPane
      settings={settings}
      updateSettings={() => {}}
      optInOnlyExperimentRows={getOptInOnlyExperimentVisibility(settings)}
    />
  )
}

const settings = {
  ...getDefaultSettings('/home/test'),
  experimentalOrchestrationPanel: true
}

export const orchestrationPanelSuspended = defineFixture({
  width: 760,
  store: { settings },
  render: () => <Pane settings={settings} />
})

const newUserSettings = getDefaultSettings('/home/test')

/** A new user: Agent Dashboard and Terminal attention are not offered. */
export const newUserHidesOptInOnlyExperiments = defineFixture({
  width: 760,
  store: { settings: newUserSettings },
  render: () => <Pane settings={newUserSettings} />
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
  render: () => <Pane settings={optedInSettings} />
})
