import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../store/index'
import { NotificationCardStack } from '../../notifications/NotificationCardStack'
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

const awayUpdate = { state: 'downloaded', version: '1.4.246', unattended: true } as const
const awayUpdateStore = { ...available.store, dismissedUpdateVersion: awayUpdate.version }

export const autoRestartCountdown = defineFixture({
  ...available,
  store: awayUpdateStore,
  setup: () => {
    useAppStore.setState({ updateStatus: { ...awayUpdate, autoRestartAt: Date.now() + 10_000 } })
  }
})

export const autoRestartReady = defineFixture({
  ...available,
  store: { ...awayUpdateStore, updateStatus: awayUpdate }
})
