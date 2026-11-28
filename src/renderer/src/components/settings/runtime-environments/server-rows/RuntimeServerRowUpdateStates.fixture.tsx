import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { OrcadManagedRuntimeStatus } from '../../../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import { UNVERIFIABLE_ORCAD_TERMINAL_CENSUS } from '../../../../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import type { RemoteServerUpdateEntry } from '../../../../../../shared/remote-runtime/host-updates/remote-server-update-coordinator'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { RuntimeHostDetails } from '../catalog/runtime-environment-host-details'
import type { ManagedServerLifecycle } from '../managed-servers/use-managed-server-lifecycle'
import { RuntimeServerRow } from './runtime-server-row'

// Each row's update entry as the store holds it once its host has answered.
const CHECKED_VERSION = '1.8.0'
const RELEASE = '1.9.0'

type Scene = {
  id: string
  name: string
  phase: RemoteServerUpdateEntry['phase']
  liveVersion: string
  managed?: OrcadManagedRuntimeStatus
}

function managedStatus(id: string, deferred: boolean): OrcadManagedRuntimeStatus {
  return {
    environmentId: id,
    sshTargetId: `${id}-ssh`,
    activeVersion: deferred ? `${CHECKED_VERSION}+a1b2c3d4e5f6` : `${RELEASE}+0f1e2d3c4b5a`,
    activeAppVersion: deferred ? CHECKED_VERSION : RELEASE,
    previousVersion: null,
    activatedAt: null,
    rollbackAvailable: false,
    recovery: null,
    terminals: UNVERIFIABLE_ORCAD_TERMINAL_CENSUS,
    migration: null,
    deferredUpdate: deferred
      ? {
          outcome: 'deferred',
          candidateVersion: `${RELEASE}+0f1e2d3c4b5a`,
          code: 'orcad_update_terminals_running',
          reason: 'Terminals are running.',
          deferredAt: '2026-01-01T00:00:00Z'
        }
      : null
  }
}

const SCENES: Scene[] = [
  // Update anyway finished; the server came back on the new release and was re-checked.
  {
    id: 'example-updated',
    name: 'example-updated',
    phase: 'current',
    liveVersion: RELEASE,
    managed: managedStatus('example-updated', false)
  },
  {
    id: 'example-updating',
    name: 'example-updating',
    phase: 'downloading',
    liveVersion: CHECKED_VERSION
  },
  {
    id: 'example-deferred',
    name: 'example-deferred',
    phase: 'manual',
    liveVersion: CHECKED_VERSION,
    managed: managedStatus('example-deferred', true)
  },
  { id: 'example-failed', name: 'example-failed', phase: 'failed', liveVersion: CHECKED_VERSION }
]

function environment(scene: Scene, index: number): PublicKnownRuntimeEnvironment {
  return {
    id: scene.id,
    name: scene.name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: `${scene.id}-ws`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: `ws://192.0.2.${index + 40}:6768`
      }
    ],
    preferredEndpointId: `${scene.id}-ws`
  }
}

function snapshot(scene: Scene): RemoteServerUpdateEntry {
  return {
    environmentId: scene.id,
    name: scene.name,
    phase: scene.phase,
    currentVersion: scene.liveVersion,
    targetVersion: RELEASE,
    progress: scene.phase === 'downloading' ? 40 : null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: scene.phase === 'failed' ? 'Download failed' : null,
    managedOverSsh: Boolean(scene.managed),
    clientVersion: RELEASE
  }
}

function liveStatus(scene: Scene): RuntimeEnvironmentStatus {
  const { result } = createCompatibleRuntimeStatusResponse(`${scene.id}-runtime`)
  return { status: { ...result, appVersion: scene.liveVersion }, checkedAt: 1 }
}

function lifecycle(status: OrcadManagedRuntimeStatus): ManagedServerLifecycle {
  return {
    status,
    statusError: null,
    recovery: null,
    busy: null,
    confirmingStop: false,
    confirmingForget: false,
    confirmingRestore: false,
    confirmingForceUpdate: null,
    setConfirmingForceUpdate: () => {},
    setConfirmingStop: () => {},
    setConfirmingForget: () => {},
    setConfirmingRestore: () => {},
    loadStatus: async () => {},
    run: async () => {}
  }
}

const connected: RuntimeHostDetails = {
  status: 'ready',
  runtimeStatus: null,
  compatibility: { kind: 'ok', clientProtocolVersion: 1, serverProtocolVersion: 1 },
  error: null
}

function rows(width: number): ReturnType<typeof defineFixture> {
  return defineFixture({
    width,
    store: {
      runtimeStatusByEnvironmentId: new Map(SCENES.map((scene) => [scene.id, liveStatus(scene)]))
    },
    render: () => (
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {SCENES.map((scene, index) => (
          <RuntimeServerRow
            key={scene.id}
            environment={environment(scene, index)}
            details={connected}
            isActive={false}
            remoteUpdate={snapshot(scene)}
            remoteServerUpdatesRunning={scene.phase === 'downloading'}
            connecting={false}
            switching={false}
            disconnecting={false}
            removing={false}
            isBusy={false}
            managed={scene.managed ? lifecycle(scene.managed) : null}
            onOpenUpdate={() => {}}
            onDisconnect={() => {}}
            onConnect={() => {}}
            onRemove={() => {}}
          />
        ))}
      </div>
    )
  })
}

export const updateStates = rows(720)
// The narrowest settings column (see RuntimeServersSection.fixture narrowest).
export const narrowestUpdateStates = rows(248)
