import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AgentWorkspaceTrustSetting } from './behavior/AgentWorkspaceTrustSetting'

export const on = defineFixture({
  width: 640,
  render: () => (
    <AgentWorkspaceTrustSetting
      settings={getDefaultSettings('/home/fixture')}
      updateSettings={() => {}}
    />
  )
})
