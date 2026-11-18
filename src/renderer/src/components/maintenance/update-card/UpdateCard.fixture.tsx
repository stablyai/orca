import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
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

const pairedServers = [
  { id: 'home-2', name: 'Mac - Home 2' },
  { id: 'office', name: 'Mac - Office' },
  { id: 'windows-office', name: 'Windows - Office' }
].map(({ id, name }): PublicKnownRuntimeEnvironment => ({
  id,
  name,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: `${id}-runtime`,
  source: 'manual',
  endpoints: [
    { id: 'direct', kind: 'websocket', label: 'Direct', endpoint: `wss://${id}.example.test` }
  ],
  preferredEndpointId: 'direct'
}))

export const availableWithPairedServers = defineFixture({
  ...available,
  store: { ...available.store, runtimeEnvironments: pairedServers }
})

export const readyToInstallWithPairedServers = defineFixture({
  ...availableWithPairedServers,
  store: {
    ...availableWithPairedServers.store,
    updateStatus: { state: 'downloaded', version: '1.4.264' }
  }
})
