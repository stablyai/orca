import { useEffect, useState } from 'react'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SettingsSection } from '../section-layout/SettingsSection'
import { ServerListRow, ServerRowChip } from '../host-rows/ServerListRow'
import { Button } from '../../ui/button'
import { RuntimeServersHeaderActions } from './runtime-servers-header-actions'
import { RuntimeServersPageProvider, useRuntimeServersPage } from './runtime-servers-page-context'
import { RuntimeAddServerDialog } from './pairing/runtime-add-server-dialog'
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
  environment('dev-box', 'dev-box', 'ws://192.0.2.12:6768'),
  environment('gpu-runner', 'gpu-runner', 'ws://192.0.2.13:6768'),
  environment('home-desktop', 'home-desktop', 'ws://192.0.2.14:6768')
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

function stubActiveLinks(count: number | null): () => void {
  return () => {
    let activeCount = count
    window.api.mobile.onDevicesChanged = (callback) => {
      const listener = (event: Event): void => {
        if (
          event instanceof CustomEvent &&
          (typeof event.detail === 'number' || event.detail === null)
        ) {
          activeCount = event.detail
          callback()
        }
      }
      window.addEventListener('fixture-runtime-grants-change', listener)
      return () => window.removeEventListener('fixture-runtime-grants-change', listener)
    }
    window.api.mobile.listRuntimeAccessGrants = async () => {
      if (activeCount === null) {
        throw new Error('Fixture grant count unavailable')
      }
      return {
        grants: Array.from({ length: activeCount }, (_, index) => ({
          deviceId: `device-${index}`,
          name: `Device ${index + 1}`,
          createdAt: 1,
          lastSeenAt: null
        }))
      }
    }
  }
}

function Section({
  environments,
  remoteServerUpdates,
  running = false,
  web = false
}: {
  environments: PublicKnownRuntimeEnvironment[]
  remoteServerUpdates: Map<string, RemoteServerUpdateEntry>
  running?: boolean
  web?: boolean
}): React.JSX.Element {
  const { dialog, setDialog, restoreAddFocus } = useRuntimeServersPage()
  const [addedServer, setAddedServer] = useState(false)
  useEffect(() => {
    const finishAdd = (): void => {
      setAddedServer(true)
      setDialog(null)
    }
    window.addEventListener('fixture-first-server-added', finishAdd)
    return () => window.removeEventListener('fixture-first-server-added', finishAdd)
  }, [setDialog])
  const listedEnvironments = addedServer ? servers.slice(0, 1) : environments
  return (
    <SettingsSection
      id="servers"
      forceVisible
      title="Remote Orca servers"
      description={web ? 'Connect to a saved Orca server.' : 'Work on another machine from here.'}
      headerAction={<RuntimeServersHeaderActions />}
      fullWidthDescriptionOnNarrow
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <RuntimeServerListHeader />
          <RuntimeServerList
            environments={listedEnvironments}
            detailsByEnvironmentId={Object.fromEntries(
              listedEnvironments.map((server) => [server.id, connected])
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
            onPasteAccessLink={(trigger) => setDialog('add', trigger)}
          />
        </div>
        {web ? null : <RuntimeShareComputerSection />}
        <RuntimeAddServerDialog
          open={dialog === 'add'}
          name=""
          accessLink=""
          busy={false}
          failure={null}
          onNameChange={() => {}}
          onAccessLinkChange={() => {}}
          onSubmit={() => {}}
          onClose={() => setDialog(null)}
          onCloseAutoFocus={restoreAddFocus}
        />
      </div>
    </SettingsSection>
  )
}

function sectionFixture({
  environments = servers,
  phases = ['available', 'available', 'current'],
  running = false,
  links = 0,
  width = 720,
  web = false,
  clientVersion
}: {
  environments?: PublicKnownRuntimeEnvironment[]
  phases?: RemoteServerUpdateEntry['phase'][]
  running?: boolean
  links?: number | null
  width?: number
  web?: boolean
  clientVersion?: string
}): ReturnType<typeof defineFixture> {
  const remoteServerUpdates = updates(environments, phases)
  if (clientVersion) {
    for (const entry of remoteServerUpdates.values()) {
      entry.clientVersion = clientVersion
    }
  }
  return defineFixture({
    width,
    store: { remoteServerUpdates, remoteServerUpdatesRunning: running },
    setup: stubActiveLinks(links),
    render: () => (
      <RuntimeServersPageProvider>
        <Section
          environments={environments}
          remoteServerUpdates={remoteServerUpdates}
          running={running}
          web={web}
        />
      </RuntimeServersPageProvider>
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
export const unknownLinks = sectionFixture({ links: null })
const longNameServers = [
  environment('long', LONG_NAME, 'ws://192.0.2.15:6768'),
  ...servers.slice(1)
]
export const longServerName = sectionFixture({ environments: longNameServers })
// The 600px window has a 280px sidebar, 64px of gutters and up to 12px for the scrollbar.
// The fixture frame adds 32px of padding around the resulting 244px settings column.
export const settingsMinimum = sectionFixture({ width: 276, links: 2 })
export const webSettingsMinimum = sectionFixture({ width: 276, web: true })
export const narrowest = sectionFixture({ width: 248, environments: longNameServers })
export const narrow = sectionFixture({ width: 440 })
export const compactVersionSkew = sectionFixture({
  width: 248,
  environments: servers.slice(0, 1),
  phases: ['current'],
  clientVersion: '1.7.0'
})
export const compactChippedRows = chippedRows(248)
export const minimumChippedRows = chippedRows(276)

function chippedRows(width: number): ReturnType<typeof defineFixture> {
  return defineFixture({
    width,
    render: () => (
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        <ServerListRow
          name="Ubuntu"
          chips={<ServerRowChip>WSL</ServerRowChip>}
          status={{ label: 'Connected', tone: 'success' }}
          primaryAction={
            <Button variant="outline" size="xs">
              Restart
            </Button>
          }
          menuItems={<div>More</div>}
        />
        <ServerListRow
          name="dev-box"
          chips={<ServerRowChip>SSH tunnel</ServerRowChip>}
          status={{ label: 'Connected', tone: 'success' }}
          primaryAction={
            <Button variant="outline" size="xs">
              Update
            </Button>
          }
          menuItems={<div>More</div>}
        />
      </div>
    )
  })
}
export const addServerMenu = defineFixture({
  ...sectionFixture({}),
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  }
})
