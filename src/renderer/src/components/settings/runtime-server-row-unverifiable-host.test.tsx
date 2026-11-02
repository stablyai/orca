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

// Render menus inline so row actions remain queryable.
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
    // Supply real versions so compatibility blocking cannot mask the reachability behavior under test.
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

// Unverifiable probes must preserve the shared reachability verdict across server rows and repository setup, including Disconnect.
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
