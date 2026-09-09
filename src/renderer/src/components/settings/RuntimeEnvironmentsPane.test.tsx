// @vitest-environment happy-dom

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  evaluateHostDetails,
  getActiveServerModeDescription,
  getHostDetailsDescription,
  getHostDetailsSummary,
  getHostModelCapabilitySummary,
  getRuntimeCapabilitiesSummary,
  getRuntimeServerConnectionState,
  isRuntimeServerTransportConnected,
  isRuntimeEnvironmentRemovalBlocked,
  RuntimeEnvironmentsPane,
  type RuntimeHostDetails
} from './RuntimeEnvironmentsPane'

function details(overrides: Partial<RuntimeHostDetails>): RuntimeHostDetails {
  return {
    status: 'ready',
    runtimeStatus: null,
    compatibility: null,
    error: null,
    ...overrides
  }
}

function readyTransport(
  overrides: Partial<NonNullable<RuntimeHostDetails['remoteControl']>> = {}
): NonNullable<RuntimeHostDetails['remoteControl']> {
  return {
    state: 'ready',
    pendingRequestCount: 0,
    subscriptionCount: 0,
    reconnectAttempt: 0,
    lastConnectedAt: 1,
    lastClose: null,
    lastError: null,
    ...overrides
  }
}

function makeEnvironment(
  overrides: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'Dev box',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws-env-1',
    endpoints: [
      { id: 'ws-env-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://dev-1:39221' }
    ],
    ...overrides
  }
}

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  setActive: vi.fn(),
  remove: vi.fn(),
  connect: vi.fn(),
  getStatus: vi.fn(),
  disconnect: vi.fn(),
  resolve: vi.fn(),
  verifyAndAddFromPairingCode: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

const storeMock = vi.hoisted(() => ({
  state: {
    settingsSearchQuery: '',
    remoteServerUpdates: new Map(),
    remoteServerUpdatesChecking: false,
    remoteServerUpdatesRunning: false,
    setRemoteServerUpdateDialogOpen: vi.fn(),
    refreshRemoteServerUpdates: vi.fn(async () => {}),
    runtimeStatusByEnvironmentId: new Map(),
    setRuntimeEnvironments: vi.fn(),
    setRuntimeEnvironmentStatus: vi.fn(),
    fetchRuntimeEnvironmentRepos: vi.fn(async () => [])
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state),
    { getState: () => storeMock.state }
  )
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  unwrapRuntimeRpcResult: vi.fn((response: { result: unknown }) => response.result)
}))

vi.mock('@/hooks/runtime-project-refresh-scheduler', () => ({
  refreshRuntimeProjectWorktreesAndLineage: vi.fn(async () => {})
}))

vi.mock('../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div data-slot="dialog-content">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

type SettingsOverrides = Partial<{
  activeRuntimeEnvironmentId: string | null
}>

function makeSettings(
  overrides: SettingsOverrides = {}
): ComponentProps<typeof RuntimeEnvironmentsPane>['settings'] {
  return {
    activeRuntimeEnvironmentId: null,
    ...overrides
  } as ComponentProps<typeof RuntimeEnvironmentsPane>['settings']
}

function mockListResult(
  environments: PublicKnownRuntimeEnvironment[],
  activeEnvironmentId: string | null = environments[0]?.id ?? null
): void {
  // Why: the settings hook currently consumes list() as a bare array while the
  // API migrates to { environments, activeEnvironmentId }; satisfy both shapes
  // so this suite survives either side of the migration.
  const result = Object.assign([...environments], { environments, activeEnvironmentId })
  apiMocks.list.mockResolvedValue(result as unknown as PublicKnownRuntimeEnvironment[])
}

beforeEach(() => {
  apiMocks.list.mockReset()
  apiMocks.setActive.mockReset()
  apiMocks.remove.mockReset()
  apiMocks.connect.mockReset()
  apiMocks.getStatus.mockReset()
  apiMocks.disconnect.mockReset()
  apiMocks.resolve.mockReset()
  apiMocks.verifyAndAddFromPairingCode.mockReset()
  apiMocks.setActive.mockResolvedValue({ environment: makeEnvironment() })
  apiMocks.remove.mockResolvedValue({ removed: makeEnvironment() })
  apiMocks.connect.mockResolvedValue({ ok: false, error: { code: 'x', message: 'offline' } })
  apiMocks.getStatus.mockRejectedValue(new Error('offline'))
  window.api = {
    runtimeEnvironments: apiMocks
  } as unknown as typeof window.api
})

const roots: Root[] = []

async function renderPane(
  props: Partial<ComponentProps<typeof RuntimeEnvironmentsPane>> = {}
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <RuntimeEnvironmentsPane
        settings={makeSettings()}
        setActiveRuntimeEnvironmentPreference={vi.fn(async () => true)}
        {...props}
      />
    )
  })
  // Why: the catalog probes each saved host after list(); settle those promises.
  await act(async () => {})
  return container
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  document.body.innerHTML = ''
})

describe('RuntimeEnvironmentsPane host details', () => {
  it('summarizes loading, error, compatible, and blocked hosts', () => {
    expect(getHostDetailsSummary(undefined)).toBe('Checking…')
    expect(getHostDetailsSummary(details({ status: 'error', error: 'offline' }))).toBe(
      'Status unavailable'
    )
    expect(
      getHostDetailsSummary(
        details({
          compatibility: {
            kind: 'ok',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: RUNTIME_PROTOCOL_VERSION
          }
        })
      )
    ).toBe('Compatible')
    expect(
      getHostDetailsSummary(
        details({
          compatibility: {
            kind: 'blocked',
            reason: 'server-too-old',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
            requiredServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
          }
        })
      )
    ).toBe('Update server')
    expect(
      getHostDetailsSummary(
        details({
          compatibility: {
            kind: 'blocked',
            reason: 'client-too-old',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            requiredClientProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1
          }
        })
      )
    ).toBe('Update client')
  })

  it('evaluates runtime protocol compatibility from status aliases', () => {
    expect(
      evaluateHostDetails({
        runtimeId: 'runtime-old',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        protocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
        minCompatibleMobileVersion: 0
      })
    ).toMatchObject({ kind: 'blocked', reason: 'server-too-old' })
  })

  it('explains blocked runtime compatibility with required protocol versions', () => {
    expect(
      getHostDetailsDescription(
        details({
          compatibility: {
            kind: 'blocked',
            reason: 'server-too-old',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
            requiredServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
          }
        })
      )
    ).toContain('client requires server protocol')
  })

  it('summarizes runtime capabilities by name with overflow count', () => {
    expect(
      getRuntimeCapabilitiesSummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: ['runtime.environments.v1', 'terminal.multiplex.v1']
      })
    ).toBe('runtime.environments.v1, terminal.multiplex.v1')

    expect(
      getRuntimeCapabilitiesSummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: [
          'runtime.environments.v1',
          'browser.screencast.v1',
          'terminal.multiplex.v1',
          'project-host-setup.v1'
        ]
      })
    ).toBe('runtime.environments.v1, browser.screencast.v1, terminal.multiplex.v1 +1')
  })

  it('summarizes Host model capability support for version-skewed servers', () => {
    expect(
      getHostModelCapabilitySummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0
      })
    ).toBe('Host model support: checking server capabilities')

    expect(
      getHostModelCapabilitySummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: [
          PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
          TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
          WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
        ]
      })
    ).toBe('Host model support: ready')

    expect(
      getHostModelCapabilitySummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: [PROJECT_HOST_SETUP_RUNTIME_CAPABILITY]
      })
    ).toBe('Host model support: update server for task source context, workspace run context')
  })

  it('distinguishes transport-up/runtime-down from an attached ready runtime', () => {
    // Why: the row tracks attachment (reachable + ready), which exposes Disconnect.
    // Whether the host is the default *active* server is a separate concept, so it
    // must NOT change this label — otherwise the dot/label/button disagree (a host
    // showed "Available" with a grey dot yet offered Disconnect).
    expect(getRuntimeServerConnectionState(details({ status: 'ready' }))).toBe(
      'runtime-unavailable'
    )
    expect(isRuntimeServerTransportConnected('runtime-unavailable')).toBe(true)
    expect(
      getRuntimeServerConnectionState(
        details({
          status: 'ready',
          runtimeStatus: {
            runtimeId: 'runtime-ready',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: 1,
            liveTabCount: 0,
            liveLeafCount: 0
          }
        })
      )
    ).toBe('connected')
    expect(getHostDetailsDescription(details({ status: 'ready' }))).toContain(
      'SSH transport is connected'
    )
    expect(getHostDetailsSummary(details({ status: 'ready' }))).toBe('Orca unavailable')
    expect(getRuntimeServerConnectionState(undefined)).toBe('checking')
    expect(getRuntimeServerConnectionState(details({ status: 'loading' }))).toBe('checking')
    expect(getRuntimeServerConnectionState(details({ status: 'error', error: 'offline' }))).toBe(
      'disconnected'
    )
    expect(
      getRuntimeServerConnectionState(
        details({
          status: 'ready',
          compatibility: {
            kind: 'blocked',
            reason: 'server-too-old',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
            requiredServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
          }
        })
      )
    ).toBe('disconnected')
  })

  it('keeps a transport-ready failed status probe available in Settings', () => {
    const failedProbe = details({
      status: 'error',
      runtimeStatus: null,
      remoteControl: readyTransport(),
      error: 'runtime.status.get timed out'
    })

    expect(getHostDetailsSummary(failedProbe)).toBe('Orca unavailable')
    expect(getHostDetailsDescription(failedProbe)).toContain('SSH transport is connected')
    expect(getHostDetailsDescription(failedProbe)).toContain('runtime.status.get timed out')
    expect(getRuntimeServerConnectionState(failedProbe)).toBe('runtime-unavailable')
    expect(isRuntimeServerTransportConnected(getRuntimeServerConnectionState(failedProbe))).toBe(
      true
    )
  })

  it('keeps reconnecting and handshaking failed probes out of disconnected state', () => {
    for (const state of ['reconnecting', 'awaiting_ready', 'awaiting_authenticated'] as const) {
      expect(
        getRuntimeServerConnectionState(
          details({
            status: 'error',
            remoteControl: readyTransport({ state }),
            error: 'runtime.status.get failed'
          })
        ),
        state
      ).toBe(state === 'reconnecting' ? 'reconnecting' : 'checking')
    }
  })

  it('does not treat an errored probe with a stale compatibility verdict as connected', () => {
    expect(
      getRuntimeServerConnectionState(
        details({
          status: 'error',
          compatibility: {
            kind: 'ok',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: RUNTIME_PROTOCOL_VERSION
          },
          error: 'runtime.status.get failed'
        })
      )
    ).toBe('disconnected')
  })

  it('explains that selecting a saved server is the explicit default Host mode', () => {
    expect(getActiveServerModeDescription(true)).toContain('Use this computer by default')
    expect(getActiveServerModeDescription(true)).toContain('browser/mobile handoff')
    expect(getActiveServerModeDescription(false)).toContain('default Host')
    expect(getActiveServerModeDescription(false)).toContain('paired Orca runtime')
  })

  it('blocks removing the active server independently of local-runtime availability', () => {
    expect(isRuntimeEnvironmentRemovalBlocked('windows-2', 'windows-2')).toBe(true)
    expect(isRuntimeEnvironmentRemovalBlocked(undefined, 'windows-2')).toBe(false)
    expect(isRuntimeEnvironmentRemovalBlocked('local', 'windows-2')).toBe(false)
  })
})

describe('RuntimeEnvironmentsPane server list', () => {
  it('renders one row per saved environment and marks the active row', async () => {
    mockListResult(
      [
        makeEnvironment({ id: 'env-1', name: 'Dev box' }),
        makeEnvironment({
          id: 'env-2',
          name: 'LAN box',
          preferredEndpointId: 'ws-env-2',
          endpoints: [
            { id: 'ws-env-2', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://lan:39221' }
          ]
        })
      ],
      'env-2'
    )

    const container = await renderPane({
      settings: makeSettings({ activeRuntimeEnvironmentId: 'env-2' })
    })

    expect(container.querySelector('[data-settings-section="env-1"]')).not.toBeNull()
    expect(container.querySelector('[data-settings-section="env-2"]')).not.toBeNull()
    expect(container.textContent).toContain('Dev box')
    expect(container.textContent).toContain('LAN box')
    expect(
      container.querySelector('[data-settings-section="env-2"]')?.getAttribute('data-current')
    ).toBe('true')
    expect(
      container.querySelector('[data-settings-section="env-1"]')?.getAttribute('data-current')
    ).toBeNull()
  })

  it('shows the empty state when no servers are saved', async () => {
    mockListResult([])
    const container = await renderPane()
    expect(container.textContent).toContain('No saved servers.')
  })

  it('activates a saved server through setActive with the row id', async () => {
    const second = makeEnvironment({ id: 'env-2', name: 'LAN box' })
    mockListResult([makeEnvironment({ id: 'env-1', name: 'Dev box' }), second], 'env-1')

    const container = await renderPane()
    const row = container.querySelector('[data-settings-section="env-2"]')!
    const activateButton = [...row.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Activate')
    )
    expect(activateButton).toBeTruthy()

    await act(async () => {
      ;(activateButton as HTMLButtonElement).click()
    })

    expect(apiMocks.setActive).toHaveBeenCalledWith({ id: 'env-2' })
  })

  it('removes a saved server after confirmation and refreshes the list', async () => {
    const first = makeEnvironment({ id: 'env-1', name: 'Dev box' })
    const second = makeEnvironment({
      id: 'env-2',
      name: 'LAN box',
      preferredEndpointId: 'ws-env-2',
      endpoints: [
        { id: 'ws-env-2', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://lan:39221' }
      ]
    })
    mockListResult([first, second], 'env-1')

    const container = await renderPane()
    const row = container.querySelector('[data-settings-section="env-2"]')!
    const removeButton = [...row.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.includes('Remove')
    )
    expect(removeButton).toBeTruthy()

    await act(async () => {
      ;(removeButton as HTMLButtonElement).click()
    })
    // Confirmation dialog opens before the API call.
    expect(apiMocks.remove).not.toHaveBeenCalled()
    const confirmButton = [
      ...container.querySelectorAll('[data-slot="dialog-content"] button')
    ].find((button) => button.textContent?.trim() === 'Remove')
    expect(confirmButton).toBeTruthy()

    let resolveRemove: ((value: { removed: PublicKnownRuntimeEnvironment }) => void) | null = null
    apiMocks.remove.mockReturnValue(
      new Promise<{ removed: PublicKnownRuntimeEnvironment }>((resolve) => {
        resolveRemove = resolve
      })
    )
    await act(async () => {
      ;(confirmButton as HTMLButtonElement).click()
    })
    expect(apiMocks.remove).toHaveBeenCalledWith({ selector: 'env-2' })

    mockListResult([first], 'env-1')
    await act(async () => {
      resolveRemove!({ removed: second })
    })

    expect(container.querySelector('[data-settings-section="env-2"]')).toBeNull()
    expect(container.querySelector('[data-settings-section="env-1"]')).not.toBeNull()
  })

  it('keeps the Add Server form flow alongside the saved server list', async () => {
    mockListResult([makeEnvironment({ id: 'env-1', name: 'Dev box' })], 'env-1')
    const container = await renderPane()

    expect(container.textContent).toContain('Add Server')
    const nameInput = container.querySelector<HTMLInputElement>('#web-runtime-name')
    expect(nameInput).toBeNull()
  })
})
