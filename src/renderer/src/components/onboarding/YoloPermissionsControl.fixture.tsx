import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import { YoloPermissionsControl } from './YoloPermissionsControl'

const store = {
  settings: {
    ...getDefaultSettings('/fixture'),
    agentPermissionDefault: 'own' as const,
    agentPermissionOverrides: { codex: 'full-access' as const, claude: 'ask' as const }
  }
}

export const fullAccessOverride = defineFixture({
  width: 560,
  store,
  render: () => <YoloPermissionsControl yoloPermissions={false} />
})

export const narrowOverride = defineFixture({
  width: 320,
  store,
  render: () => <YoloPermissionsControl yoloPermissions={false} />
})
