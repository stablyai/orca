// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import type {
  RuntimeEnvironmentStatus,
  RuntimeHostStatusSnapshot
} from '../../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../ui/tooltip'
import { RuntimeServerRow } from './runtime-server-row'

// Why: menu items render inline as buttons so the row's menu actions are queryable.
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => <button onClick={onSelect}>{children}</button>
}))

const ENVIRONMENT_ID = 'env-a'
const initialState = useAppStore.getInitialState()

const environment: PublicKnownRuntimeEnvironment = {
  id: ENVIRONMENT_ID,
  name: 'Windows box',
  createdAt: 100,
  updatedAt: 100,
  pairingRevision: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [{ id: 'ws-a', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
  preferredEndpointId: 'ws-a'
}

function answeredStatus(): RuntimeStatus {
  return {
    runtimeId: 'rt-1',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 0,
    liveLeafCount: 0,
    // Why real versions: an omitted protocol version is a compat block, which is its own
    // disconnected verdict and would mask what this file is measuring.
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
  }
}

function snapshot(patch: Partial<RuntimeHostStatusSnapshot>): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENVIRONMENT_ID,
    pairingRevision: 1,
    sequence: 2,
    checkedAt: 2,
    status: answeredStatus(),
    verification: 'verified',
    transport: 'ready',
    ...patch
  }
}

function setEntry(entry: RuntimeEnvironmentStatus): void {
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([[ENVIRONMENT_ID, entry]]) })
}

function renderRow(
  remoteUpdate?: RemoteServerUpdateEntry,
  duplicateOfNames: readonly string[] = []
): void {
  render(
    <TooltipProvider>
      <RuntimeServerRow
        environment={environment}
        duplicateOfNames={duplicateOfNames}
        details={undefined}
        isActive={false}
        remoteUpdate={remoteUpdate}
        remoteServerUpdatesRunning={false}
        connecting={false}
        switching={false}
        disconnecting={false}
        removing={false}
        isBusy={false}
        onOpenUpdate={vi.fn()}
        onDisconnect={vi.fn()}
        onConnect={vi.fn()}
        onRemove={vi.fn()}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

// Settings > Available Hosts and the repository host-setup section render the same host from the
// same entry. This row derived its own answer from raw `entry.status`, so a probe that did not
// come back flipped it to "error" and swapped Disconnect for Connect while the other surface,
// which already reads the shared verdict, still showed the host as reachable.
it('keeps offering Disconnect while a ready host answers an unverifiable probe', () => {
  setEntry({
    status: null,
    checkedAt: 2,
    snapshot: snapshot({ verification: 'unavailable' })
  })
  renderRow()

  expect(screen.queryByRole('button', { name: /disconnect/i })).not.toBeNull()
  expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
})

// The other direction must still work: a transport the host actually dropped is a host you
// reconnect to, and the row has to offer that.
it('offers Connect once the transport itself is down', () => {
  setEntry({
    status: null,
    checkedAt: 2,
    snapshot: snapshot({ verification: 'unavailable', transport: 'disconnected' })
  })
  renderRow()

  expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull()
})

it('still offers Disconnect for a verified host', () => {
  setEntry({ status: answeredStatus(), checkedAt: 2, snapshot: snapshot({}) })
  renderRow()

  expect(screen.queryByRole('button', { name: /disconnect/i })).not.toBeNull()
})

it('shows one status for an unreachable host instead of a stack of signals', () => {
  setEntry({
    status: null,
    checkedAt: 2,
    snapshot: snapshot({ verification: 'unavailable', transport: 'disconnected' })
  })
  render(
    <TooltipProvider>
      <RuntimeServerRow
        environment={environment}
        details={{
          status: 'error',
          runtimeStatus: null,
          compatibility: null,
          error: 'Timed out waiting for the remote Orca runtime.'
        }}
        isActive={false}
        remoteUpdate={undefined}
        remoteServerUpdatesRunning={false}
        connecting={false}
        switching={false}
        disconnecting={false}
        removing={false}
        isBusy={false}
        onOpenUpdate={vi.fn()}
        onDisconnect={vi.fn()}
        onConnect={vi.fn()}
        onRemove={vi.fn()}
      />
    </TooltipProvider>
  )
  expect(screen.queryByText('Unreachable')).not.toBeNull()
  expect(screen.queryByText('Status unavailable')).toBeNull()
  expect(screen.queryByText('Never connected · x')).not.toBeNull()
  // Why Retry, not Connect: the app already tried and got no answer.
  expect(screen.getAllByRole('button', { name: /^retry$/i })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /re-pair/i })).toBeNull()
})

it('keeps the machine under the label once the host is unreachable', () => {
  const status = { ...answeredStatus(), machineName: 'Studio', hostPlatform: 'darwin' as const }
  setEntry({
    status: null,
    checkedAt: 2,
    snapshot: snapshot({ status, verification: 'unavailable' })
  })
  renderRow()
  expect(screen.queryByText('macOS · Studio')).not.toBeNull()
  cleanup()

  setEntry({
    status: null,
    checkedAt: 2,
    snapshot: snapshot({ status, verification: 'unavailable', transport: 'disconnected' })
  })
  renderRow()
  expect(screen.queryByText('macOS · Studio')).not.toBeNull()
})

// A host that refused our token answered us, so the row must not also claim it is offline.
it('tells one revoked story instead of a disconnected one', () => {
  const status = { ...answeredStatus(), appVersion: '1.4.229' }
  setEntry({
    status: null,
    checkedAt: 2,
    snapshot: snapshot({
      status,
      verification: 'blocked',
      blockedReason: 'access-revoked',
      transport: 'disconnected'
    })
  })
  renderRow({
    environmentId: ENVIRONMENT_ID,
    name: environment.name,
    phase: 'offline',
    currentVersion: null,
    targetVersion: null,
    progress: null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: 'unauthorized'
  })

  expect(screen.queryByText('Access revoked')).not.toBeNull()
  expect(screen.queryByText('Disconnected')).toBeNull()
  expect(screen.queryByText('Unreachable')).toBeNull()
  expect(screen.queryByText('Status unavailable')).toBeNull()
  expect(screen.queryByText('Offline')).toBeNull()
  expect(screen.queryByText(/Re-pair it with a new access link/)).not.toBeNull()
  expect(screen.queryByRole('button', { name: /re-pair/i })).not.toBeNull()
  expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
})

it('marks a server paired twice and names its twin', () => {
  renderRow(undefined, ['Studio relay'])
  expect(
    screen.queryByText(
      'Same server as Studio relay, paired twice. Remove one so its projects can be edited.'
    )
  ).not.toBeNull()
})
