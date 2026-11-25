import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
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

// Interaction checks drive this card through main's status sequence and count the updater requests it sends.
export const liveFlow = defineFixture({
  ...available,
  setup: () => {
    const requests: string[] = []
    Reflect.set(window, '__updateCardRequests', requests)
    Reflect.set(window, '__setFixtureUpdateStatus', (updateStatus: UpdateStatus) =>
      useAppStore.setState({ updateStatus })
    )
    Object.assign(window.api, {
      updater: {
        ...window.api.updater,
        download: async () => {
          requests.push('download')
        },
        quitAndInstall: async () => {
          requests.push('quitAndInstall')
        }
      }
    })
  }
})
