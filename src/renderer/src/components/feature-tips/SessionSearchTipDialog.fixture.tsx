import { FEATURE_TIPS } from '../../../../shared/feature-education/feature-tips'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { SessionSearchTipDialog } from './SessionSearchTipDialog'

const tip = FEATURE_TIPS.find((item) => item.id === 'agent-session-search')
if (!tip) {
  throw new Error('agent-session-search feature tip is missing')
}

export const open = defineFixture({
  render: () => (
    <SessionSearchTipDialog
      open
      tip={tip}
      primaryBusy={false}
      onOpenChange={() => {}}
      onPrimaryAction={() => {}}
      onSettingsClick={() => {}}
      stage="offer"
      status={null}
    />
  )
})
