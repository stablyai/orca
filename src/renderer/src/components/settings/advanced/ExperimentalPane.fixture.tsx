import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/constants'
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
