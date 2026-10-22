// @vitest-environment happy-dom
import type { PropsWithChildren } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { SshStatusSegment } from './SshStatusSegment'

const mocks = vi.hoisted(() => ({
  disconnectRuntime: vi.fn(async () => undefined),
  disconnectSsh: vi.fn(async () => undefined),
  connectRuntime: vi.fn(async () => true),
  readSnapshots: vi.fn(async () => undefined)
}))

function noSettings(): GlobalSettings | null {
  return null
}

let state = {
  sshTargetLabels: new Map<string, string>(),
  sshConnectionStates: new Map<string, SshConnectionState>(),
  repos: [],
  runtimeEnvironments: new Array<PublicKnownRuntimeEnvironment>(),
  runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>(),
  settings: noSettings(),
  readRuntimeHostStatusSnapshots: mocks.readSnapshots,
  hydrateRuntimeEnvironmentStatuses: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  openSettingsTarget: vi.fn(),
  setActiveView: vi.fn()
}

vi.mock('../../store', () => {
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('./runtime-environment-explicit-connect', () => ({
  connectRuntimeHostAndReloadProjects: mocks.connectRuntime
}))
vi.mock('../settings/RuntimeRepairDialog', () => ({
  RuntimeRepairDialog: ({ environmentId, name }: { environmentId: string; name: string }) => (
    <div role="dialog">{`Re-pair ${name} (${environmentId})`}</div>
  )
}))
vi.mock('@/components/ui/dropdown-menu', () => {
  const content = ({ children }: PropsWithChildren) => <div>{children}</div>
  return {
    DropdownMenu: content,
    DropdownMenuContent: content,
    DropdownMenuItem: content,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: content,
    DropdownMenuSub: content,
    DropdownMenuSubContent: content,
    DropdownMenuSubTrigger: content
  }
})

function environment(id: string, name: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: id,
    endpoints: [],
    preferredEndpointId: id
  }
}

function sshState(managedServer?: SshConnectionState['managedServer']): SshConnectionState {
  return {
    targetId: 'ssh-openclaw',
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    managedServer
  }
}

function readyStatus(): RuntimeEnvironmentStatus {
  return {
    status: {
      runtimeId: 'fixture',
      // Why: a status without a protocol version reads as a too-old server (update required).
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: 1,
      desktopWindowStatus: 'available',
      liveTabCount: 0,
      liveLeafCount: 0
    },
    checkedAt: 1,
    remoteControl: {
      state: 'ready',
      pendingRequestCount: 0,
      subscriptionCount: 0,
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastClose: null,
      lastError: null
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state = {
    ...state,
    sshTargetLabels: new Map([['ssh-openclaw', 'openclaw']]),
    sshConnectionStates: new Map([
      ['ssh-openclaw', sshState({ kind: 'managed', environmentId: 'server-openclaw' })]
    ]),
    runtimeEnvironments: [
      {
        ...environment('server-openclaw', 'openclaw'),
        orcadDeployment: {
          sshTargetId: 'ssh-openclaw',
          sshTargetGeneration: 1,
          localPort: 7001,
          remotePort: 6768
        }
      },
      environment('server-windows', 'win-lowspec')
    ],
    runtimeStatusByEnvironmentId: new Map([
      ['server-openclaw', readyStatus()],
      ['server-windows', readyStatus()]
    ]),
    settings: noSettings()
  }
  Object.assign(window, {
    api: {
      runtimeEnvironments: { disconnect: mocks.disconnectRuntime },
      ssh: { disconnect: mocks.disconnectSsh }
    }
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('the status menu for a managed SSH host', () => {
  it('shows and counts one row per machine and disconnects the managed server', async () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getAllByText('openclaw')).toHaveLength(1)
    expect(screen.queryByText('SSH Host')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Remote host connection status' }).textContent
    ).toContain('2 hosts')
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0])
    await waitFor(() =>
      expect(mocks.disconnectRuntime).toHaveBeenCalledWith({ selector: 'server-openclaw' })
    )
    expect(mocks.disconnectSsh).not.toHaveBeenCalled()
  })

  it('keeps only the SSH row when the host falls back to its relay', async () => {
    state.sshConnectionStates.set(
      'ssh-openclaw',
      sshState({ kind: 'relay', reason: 'source_changed' })
    )
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getAllByText('openclaw')).toHaveLength(1)
    expect(screen.getByText('SSH Host')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Remote host connection status' }).textContent
    ).toContain('2 hosts')
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[1])
    await waitFor(() =>
      expect(mocks.disconnectSsh).toHaveBeenCalledWith({ targetId: 'ssh-openclaw' })
    )
    expect(mocks.disconnectRuntime).not.toHaveBeenCalled()
  })

  it('keeps the managed server reconnect action when the pair is disconnected', async () => {
    state.sshConnectionStates.set('ssh-openclaw', { ...sshState(), status: 'disconnected' })
    state.runtimeStatusByEnvironmentId.set('server-openclaw', {
      status: null,
      checkedAt: 1,
      snapshot: {
        environmentId: 'server-openclaw',
        pairingRevision: 1,
        sequence: 1,
        checkedAt: 1,
        status: null,
        verification: 'unavailable',
        transport: 'disconnected',
        retired: true
      }
    })
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getAllByText('openclaw')).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: 'Remote host connection status' }).textContent
    ).toContain('1 host')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(mocks.connectRuntime).toHaveBeenCalledWith('server-openclaw'))
  })

  it('does not merge an independently paired server just because its name matches', () => {
    state.runtimeEnvironments[0] = environment('server-openclaw', 'openclaw')
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getAllByText('openclaw')).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: 'Remote host connection status' }).textContent
    ).toContain('3 hosts')
  })

  it('keeps the SSH row until the managed server catalog has arrived', () => {
    state.runtimeEnvironments = [environment('server-windows', 'win-lowspec')]
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getAllByText('openclaw')).toHaveLength(1)
    expect(screen.getByText('SSH Host')).toBeTruthy()
  })

  it('names the managed row after its SSH host, honouring a rename saved on the SSH id', () => {
    state.runtimeEnvironments[0] = { ...state.runtimeEnvironments[0], name: 'orcad-ssh-openclaw' }
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getAllByText('openclaw')).toHaveLength(1)
    expect(screen.queryByText('orcad-ssh-openclaw')).toBeNull()
    cleanup()
    state.settings = {
      ...getDefaultSettings('/home/test'),
      hostSettingOverrides: { 'ssh:ssh-openclaw': { displayLabel: 'Claw box' } }
    }
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getAllByText('Claw box')).toHaveLength(1)
  })

  it('names a revoked server and offers Re-pair instead of a futile Connect', () => {
    state.runtimeStatusByEnvironmentId.set('server-windows', blockedStatus('access-revoked'))
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getByText('Access revoked')).toBeTruthy()
    expect(screen.queryByText('Disconnected')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
    fireEvent.click(screen.getAllByText('Re-pair…')[0])
    expect(screen.getByRole('dialog').textContent).toBe('Re-pair win-lowspec (server-windows)')
  })

  it('names an incompatible server as needing an update', () => {
    state.runtimeStatusByEnvironmentId.set('server-windows', blockedStatus('incompatible'))
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getByText('Update required')).toBeTruthy()
    expect(screen.queryByText('Re-pair…')).toBeNull()
  })
})

function blockedStatus(blockedReason: 'access-revoked' | 'incompatible'): RuntimeEnvironmentStatus {
  return {
    status: null,
    checkedAt: 1,
    snapshot: {
      environmentId: 'server-windows',
      pairingRevision: 1,
      sequence: 1,
      checkedAt: 1,
      status: null,
      verification: 'blocked',
      blockedReason,
      transport: 'unknown'
    }
  }
}
