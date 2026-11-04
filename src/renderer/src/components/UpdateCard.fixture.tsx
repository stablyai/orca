import { defineFixture } from '../component-fixtures/component-fixture'
import { NotificationCardStack } from './NotificationCardStack'
import { UpdateCard } from './UpdateCard'

export const available = defineFixture({
  width: 1280,
  store: {
    updateStatus: { state: 'available', version: '1.4.246', changelog: null },
    updateChangelog: null,
    updateCardCollapsed: false,
    dismissedUpdateVersion: null,
    updateReassuranceSeen: true
  },
  render: () => (
    <div className="h-[868px]">
      <NotificationCardStack>
        <UpdateCard />
      </NotificationCardStack>
    </div>
  )
})
