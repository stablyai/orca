import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SettingsSection } from '../section-layout/SettingsSection'
import { RuntimeServersHeaderActions } from './runtime-servers-header-actions'
import { RuntimeServersPageProvider } from './runtime-servers-page-context'
import { RuntimeServerListHeader } from './server-rows/runtime-server-list-header'
import { RuntimeServerList } from './server-rows/runtime-server-list'
import { RuntimeShareComputerSection } from './pairing/runtime-share-computer-section'
import type { ManagedServerCatalog } from './managed-servers/use-managed-server-catalog'
import type { RuntimeHostDetails } from './catalog/runtime-environment-host-details'

const LONG_NAME = 'shared-build-server-for-the-integration-test-farm-west-rack-07'

function environment(id: string, name: string, address: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: `${id}-ws`, kind: 'websocket', label: 'WebSocket', endpoint: address }],
    preferredEndpointId: `${id}-ws`
  }
}

const servers = [
  environment('dev-box', 'dev-box', 'ws://10.0.0.12:6768'),
  environment('gpu-runner', 'gpu-runner', 'ws://10.0.0.13:6768'),
  environment('home-desktop', 'home-desktop', 'ws://10.0.0.14:6768')
]

function update(
  server: PublicKnownRuntimeEnvironment,
  phase: RemoteServerUpdateEntry['phase']
): RemoteServerUpdateEntry {
  return {
    environmentId: server.id,
    name: server.name,
    phase,
    currentVersion: '1.8.0',
    targetVersion: '1.9.0',
    progress: phase === 'downloading' ? 0.4 : null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: null
  }
}

function updates(
  list: PublicKnownRuntimeEnvironment[],
  phases: RemoteServerUpdateEntry['phase'][]
): Map<string, RemoteServerUpdateEntry> {
  return new Map(list.map((server, index) => [server.id, update(server, phases[index])]))
}

const managedCatalog: ManagedServerCatalog = {
  api: undefined,
  targets: [],
  emptyTargets: [],
  pending: [],
  loadFailed: false,
  resumingId: null,
  reload: async () => {},
  resume: async () => {}
}

const connected: RuntimeHostDetails = {
  status: 'ready',
  runtimeStatus: null,
  compatibility: { kind: 'ok', clientProtocolVersion: 1, serverProtocolVersion: 1 },
  error: null
}

function stubActiveLinks(count: number): () => void {
  return () => {
    window.api.mobile.listRuntimeAccessGrants = () =>
      Promise.resolve({
        grants: Array.from({ length: count }, (_, index) => ({
          deviceId: `device-${index}`,
          name: `Device ${index + 1}`,
          createdAt: 1,
          lastSeenAt: null
        }))
      })
  }
}

function Section({
  environments,
  remoteServerUpdates,
  running = false
}: {
  environments: PublicKnownRuntimeEnvironment[]
  remoteServerUpdates: Map<string, RemoteServerUpdateEntry>
  running?: boolean
}): React.JSX.Element {
  return (
    <RuntimeServersPageProvider>
      <SettingsSection
        id="servers"
        forceVisible
        title="Remote Orca servers"
        description="Work on another machine from here."
        headerAction={<RuntimeServersHeaderActions />}
      >
        <div className="space-y-6">
          <div className="space-y-2">
            <RuntimeServerListHeader />
            <RuntimeServerList
              environments={environments}
              detailsByEnvironmentId={Object.fromEntries(
                environments.map((server) => [server.id, connected])
              )}
              activeRuntimeEnvironmentId={null}
              remoteServerUpdates={remoteServerUpdates}
              remoteServerUpdatesRunning={running}
              connectingId={null}
              switchingValue={null}
              disconnectingId={null}
              removingId={null}
              isBusy={false}
              managedCatalog={managedCatalog}
              onOpenUpdate={() => {}}
              onConnect={() => {}}
              onDisconnect={() => {}}
              onRemove={() => {}}
              onMakeDefault={() => {}}
              onCheckForUpdates={() => {}}
              onRecheck={() => {}}
              rechecking={false}
              onChanged={() => {}}
              onPasteAccessLink={() => {}}
            />
          </div>
          <RuntimeShareComputerSection />
        </div>
      </SettingsSection>
    </RuntimeServersPageProvider>
  )
}

function sectionFixture({
  environments = servers,
  phases = ['available', 'available', 'current'],
  running = false,
  links = 0,
  width = 720
}: {
  environments?: PublicKnownRuntimeEnvironment[]
  phases?: RemoteServerUpdateEntry['phase'][]
  running?: boolean
  links?: number
  width?: number
}): ReturnType<typeof defineFixture> {
  const remoteServerUpdates = updates(environments, phases)
  return defineFixture({
    width,
    store: { remoteServerUpdates, remoteServerUpdatesRunning: running },
    setup: stubActiveLinks(links),
    render: () => (
      <Section
        environments={environments}
        remoteServerUpdates={remoteServerUpdates}
        running={running}
      />
    )
  })
}

export const twoUpdates = sectionFixture({})
export const updating = sectionFixture({
  phases: ['downloading', 'queued', 'current'],
  running: true
})
export const oneUpdate = sectionFixture({ phases: ['available', 'current', 'current'] })
export const noUpdates = sectionFixture({ phases: ['current', 'current', 'current'] })
export const noServers = sectionFixture({ environments: [] })
export const twoActiveLinks = sectionFixture({ links: 2 })
export const longServerName = sectionFixture({
  environments: [environment('long', LONG_NAME, 'ws://10.0.0.15:6768'), ...servers.slice(1)]
})
/** The settings column at Orca's 600px window minimum, less the 280px sidebar and page padding. */
export const narrowest = sectionFixture({ width: 248 })
export const narrow = sectionFixture({ width: 440 })
export const addServerMenu = defineFixture({
  ...sectionFixture({}),
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  }
})
