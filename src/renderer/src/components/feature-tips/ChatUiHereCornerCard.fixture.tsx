import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ChatUiHereCornerCard } from './ChatUiHereCornerCard'

export const open = defineFixture({
  width: 360,
  store: {
    settings: createGlobalSettingsFixture({ agentDefaultSurface: 'terminal' })
  },
  render: () => <ChatUiHereCornerCard onClose={() => {}} />
})
