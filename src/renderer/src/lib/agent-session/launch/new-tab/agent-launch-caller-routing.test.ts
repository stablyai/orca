import { nonRefusedAgentLaunch } from '@/lib/agent-tab-launch-outcome.test-fixture'
import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { createLaunchFunnelStore, resetLaunchFunnelStore } from './agent-launch-funnel-test-harness'

import type * as LaunchAdmissionModule from '../structured-agent-session-launch-admission'
import type * as LaunchConnectionOwnerModule from '../../../workspace/ownership/connection-owner-resolution'
import type * as LaunchAgentKindModule from '../../../../../../shared/agent-kind'

const store = createLaunchFunnelStore()
const mockIsWebRuntimeSessionActive = vi.fn(() => false)
const mockLaunchAgentInWebHostTab = vi.fn()
const mockBeginHostAdmittedStructuredLaunch = vi.fn()
const mockCreateSupport = vi.fn()
const mockAwaitCapabilities = vi.fn()
const mockHostCapabilities = vi.fn<() => readonly string[] | null>(() => [])
const mockExecutionHostId = vi.fn(() => 'local')

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdFromState: mockLaunchConnectionId
}))
const mockLaunchConnectionId = vi.hoisted(() => () => null)
vi.mock('../../../workspace/ownership/connection-owner-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchConnectionOwnerModule>()),
  getConnectionIdFromState: mockLaunchConnectionId
}))

vi.mock(
  '../../../../../../shared/native-chat/transcript/native-chat-transcript-readability',
  () => ({
    isNativeChatTranscriptLocalReadable: () => true
  })
)
vi.mock('@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => mockExecutionHostId(),
  runtimeEnvironmentIdOrLocalUnlessTwin: () => 'web-runtime'
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-web-host-tab', () => ({
  launchAgentInWebHostTab: mockLaunchAgentInWebHostTab
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: mockLaunchAgentKind
}))
const mockLaunchAgentKind = vi.hoisted(() => (agent: string) => agent)
vi.mock('../../../../../../shared/agent-kind', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchAgentKindModule>()),
  tuiAgentToAgentKind: mockLaunchAgentKind
}))

vi.mock('../../../../../../shared/native-chat/input/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn(async () => true) }))
vi.mock('@/lib/agent-ready-wait', () => ({
  waitForAgentReady: vi.fn(async () => ({ ready: true, reason: 'foreground-match' }))
}))
// Mock structured execution while retaining real route selection; callers must still reach the correct surface.
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: (_target: unknown, method: string) =>
    method === 'agentSession.createSupport' ? mockCreateSupport() : new Promise(() => undefined)
}))
const { mockToastInfo } = vi.hoisted(() => ({ mockToastInfo: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: mockToastInfo, error: vi.fn(), success: vi.fn() } }))
vi.mock(
  '@/lib/agent-session/launch/structured-agent-session-launch-admission',
  async (importOriginal) => ({
    ...(await importOriginal<typeof LaunchAdmissionModule>()),
    beginHostAdmittedStructuredLaunch: mockBeginHostAdmittedStructuredLaunch
  })
)
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => mockHostCapabilities(),
  awaitLocalRuntimeCapabilities: () => mockAwaitCapabilities()
}))
function serverReports(capabilities: readonly string[] | null): void {
  Object.assign(store, {
    runtimeStatusByEnvironmentId: new Map(
      capabilities ? [['web-runtime', { status: { capabilities, hostPlatform: 'linux' } }]] : []
    )
  })
}

const CHAT_DEFAULT_SETTINGS = {
  nativeChatProviders: EVERY_AGENT_CHAT
}

async function useActualAdmission(): Promise<void> {
  const actual = await vi.importActual<typeof LaunchAdmissionModule>(
    '../structured-agent-session-launch-admission'
  )
  mockBeginHostAdmittedStructuredLaunch.mockImplementationOnce(
    actual.beginHostAdmittedStructuredLaunch
  )
}

describe('agent launch caller routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLaunchFunnelStore(store)
    mockIsWebRuntimeSessionActive.mockReturnValue(false)
    mockExecutionHostId.mockReturnValue('local')
    serverReports(null)
    mockHostCapabilities.mockReturnValue([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
    mockBeginHostAdmittedStructuredLaunch.mockReturnValue({
      sessionId: null,
      tab: null,
      settlement: new Promise(() => undefined),
      cancel: vi.fn()
    })
    mockLaunchAgentInWebHostTab.mockResolvedValue({
      delivered: true,
      failureNotified: false,
      outcome: { status: 'created' }
    })
  })

  it('opens a structured chat on the paired server that owns the workspace', async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockExecutionHostId.mockReturnValue('runtime:web-runtime')
    mockHostCapabilities.mockReturnValue([])
    serverReports([
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    ])
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = nonRefusedAgentLaunch(
      launchAgentInNewTab({
        requestId: 'request-2',
        agent: 'claude',
        worktreeId: 'wt-1'
      })
    )

    expect(result?.surface.kind).toBe('host-published')
    expect(mockBeginHostAdmittedStructuredLaunch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'web-runtime' } })
    )
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })

  // Decline must preserve the workspace tab, caller arguments and honest outcome when falling back to a terminal.
  it("runs the caller's own launch as the server's terminal when the server declines the chat", async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockExecutionHostId.mockReturnValue('runtime:web-runtime')
    serverReports([
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    ])
    await useActualAdmission()
    mockCreateSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = nonRefusedAgentLaunch(
      launchAgentInNewTab({
        requestId: 'request-3',
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'fix the flaky test',
        promptDelivery: 'submit-after-ready',
        agentArgs: '--model sonnet'
      })
    )

    expect(result?.surface).toEqual({ kind: 'host-published' })
    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    await expect(result?.promptDeliveryResult).resolves.toMatchObject({
      delivered: true,
      failureNotified: false
    })
    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledOnce()
    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        prompt: 'fix the flaky test',
        agentArgs: '--model sonnet'
      })
    )
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it("opens the caller's own fallback, not the agent's terminal, when it names one", async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    await useActualAdmission()
    mockCreateSupport.mockResolvedValue({ supported: false })
    const onStructuredHostDeclined = vi.fn(() => ({ opened: true }))
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = nonRefusedAgentLaunch(
      launchAgentInNewTab({
        requestId: 'request-11',
        agent: 'claude',
        worktreeId: 'wt-1',
        onStructuredHostDeclined
      })
    )

    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    expect(onStructuredHostDeclined).toHaveBeenCalledOnce()
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('aborts a terminal open when beforeSurfaceOpen refuses', async () => {
    const beforeSurfaceOpen = vi.fn(() => false)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-5',
      agent: 'codex',
      worktreeId: 'wt-1',
      beforeSurfaceOpen
    })

    expect(result).toBeNull()
    expect(beforeSurfaceOpen).toHaveBeenCalledExactlyOnceWith({ kind: 'local-terminal' })
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('aborts a host-published open when beforeSurfaceOpen refuses', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const beforeSurfaceOpen = vi.fn(() => false)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-6',
      agent: 'codex',
      worktreeId: 'wt-1',
      beforeSurfaceOpen
    })

    expect(result).toBeNull()
    expect(beforeSurfaceOpen).toHaveBeenCalledExactlyOnceWith({ kind: 'host-published' })
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })

  it('aborts a structured open before its host is asked when beforeSurfaceOpen refuses', async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    const beforeSurfaceOpen = vi.fn(() => false)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-7',
      agent: 'codex',
      worktreeId: 'wt-1',
      beforeSurfaceOpen
    })

    expect(result).toBeNull()
    expect(beforeSurfaceOpen).toHaveBeenCalledExactlyOnceWith({ kind: 'host-published' })
    expect(mockBeginHostAdmittedStructuredLaunch).not.toHaveBeenCalled()
    expect(mockCreateSupport).not.toHaveBeenCalled()
  })

  it('returns a notified refusal without opening a surface when no startup plan can be built', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    // Unbalanced argument quoting must abort before any surface opens.
    const result = launchAgentInNewTab({
      requestId: 'request-9',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: "--model 'gpt-5.5"
    })

    expect(result).toEqual({ refused: { delivered: false, failureNotified: true } })
    expect(store.createTab).not.toHaveBeenCalled()
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })
})
