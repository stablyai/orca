// Which surface each production call site resolves to, and what aborts the open.
// Split from the command/prompt/placement files by responsibility; the profile table they share
// lives in agent-launch-caller-profiles-test-harness.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  callerProfileCases,
  type AgentLaunchCallerProfile
} from './agent-launch-caller-profiles-test-harness'
import { createLaunchFunnelStore, resetLaunchFunnelStore } from './agent-launch-funnel-test-harness'

import type * as LaunchAdmissionModule from './structured-agent-session-launch-admission'
const store = createLaunchFunnelStore()
const mockIsWebRuntimeSessionActive = vi.fn(() => false)
const mockLaunchAgentInWebHostTab = vi.fn()
const mockBeginHostAdmittedStructuredLaunch = vi.fn()
const mockCreateSupport = vi.fn()
const mockHostCapabilities = vi.fn<() => readonly string[] | null>(() => [])
const mockExecutionHostId = vi.fn(() => 'local')

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => mockExecutionHostId(),
  getRuntimeEnvironmentIdForWorktree: () => 'web-runtime'
}))
vi.mock('@/lib/launch-agent-web-host-tab', () => ({
  launchAgentInWebHostTab: mockLaunchAgentInWebHostTab
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn(async () => true) }))
vi.mock('@/lib/agent-ready-wait', () => ({
  waitForAgentReady: vi.fn(async () => ({ ready: true, reason: 'foreground-match' }))
}))
// Why: the structured executor is mocked, the structured ROUTE is not. The real resolver still
// decides which profiles reach this seam, which is the fact worth pinning; the seam itself is an
// internal boundary a migration is free to move.
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (_target: unknown, method: string) =>
    method === 'agentSession.createSupport' ? mockCreateSupport() : new Promise(() => undefined)
}))
const { mockToastInfo } = vi.hoisted(() => ({ mockToastInfo: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: mockToastInfo, error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/structured-agent-session-launch-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchAdmissionModule>()),
  beginHostAdmittedStructuredLaunch: mockBeginHostAdmittedStructuredLaunch
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => mockHostCapabilities()
}))
/** What the paired server that owns 'wt-1' last reported about itself. */
function serverReports(capabilities: readonly string[] | null): void {
  Object.assign(store, {
    runtimeStatusByEnvironmentId: new Map(
      capabilities ? [['web-runtime', { status: { capabilities, hostPlatform: 'linux' } }]] : []
    )
  })
}

const CHAT_DEFAULT_SETTINGS = {
  experimentalNativeChat: true
}

const cases = callerProfileCases()

async function useActualAdmission(): Promise<void> {
  const actual = await vi.importActual<typeof LaunchAdmissionModule>(
    './structured-agent-session-launch-admission'
  )
  mockBeginHostAdmittedStructuredLaunch.mockImplementationOnce(
    actual.beginHostAdmittedStructuredLaunch
  )
}

async function launch(profile: AgentLaunchCallerProfile) {
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  return launchAgentInNewTab({ requestId: 'request-1', ...profile.args })
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
    mockLaunchAgentInWebHostTab.mockResolvedValue({ delivered: true, failureNotified: false })
  })

  it.each(cases)('routes %s to a local terminal under default settings', async (_id, profile) => {
    const result = await launch(profile)

    expect(result?.surface.kind).toBe('local-terminal')
    expect(store.createTab).toHaveBeenCalledTimes(1)
    expect(mockBeginHostAdmittedStructuredLaunch).not.toHaveBeenCalled()
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })

  it.each(cases)(
    'routes %s to the paired host when a web runtime owns it',
    async (_id, profile) => {
      mockIsWebRuntimeSessionActive.mockReturnValue(true)

      const result = await launch(profile)

      expect(result?.surface).toEqual({ kind: 'host-published' })
      // Placement never rides this route's payload as a tab; the host owns the surface.
      expect(store.createTab).not.toHaveBeenCalled()
      expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledTimes(1)
      expect(mockLaunchAgentInWebHostTab.mock.calls[0]?.[0]).toMatchObject({
        agent: profile.args.agent,
        worktreeId: profile.args.worktreeId,
        environmentId: 'web-runtime'
      })
    }
  )

  it.each(cases)(
    'settles %s on the structured or terminal surface its own arguments allow',
    async (_id, profile) => {
      store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }

      const result = await launch(profile)

      // Why: a caller-named cwd is a process shape only a PTY produces, so that profile is
      // structurally barred rather than merely unconfigured and stays terminal with the default on.
      const structurallyBarred = profile.id === 'session-continuation'
      expect(result?.surface.kind).toBe(structurallyBarred ? 'local-terminal' : 'host-published')
    }
  )

  it.each(cases)(
    'asks this machine to admit the chat %s routes structured before any of it opens',
    async (_id, profile) => {
      store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }

      const result = await launch(profile)

      if (result?.surface.kind !== 'host-published') {
        expect(mockBeginHostAdmittedStructuredLaunch).not.toHaveBeenCalled()
        return
      }
      expect(result.pasteDraftAfterLaunch).toBe(false)
      expect(store.createTab).not.toHaveBeenCalled()
      expect(mockBeginHostAdmittedStructuredLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: profile.args.worktreeId,
          executionHostId: 'local',
          target: { kind: 'local' }
        })
      )
    }
  )

  it('opens a structured chat on the paired server that owns the workspace', async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockExecutionHostId.mockReturnValue('runtime:web-runtime')
    // This machine could not host one; the server that owns the workspace can.
    mockHostCapabilities.mockReturnValue([])
    serverReports([
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    ])
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'claude',
      worktreeId: 'wt-1'
    })

    // The server admits the chat before any of it exists here, so the surface is the host's.
    expect(result?.surface.kind).toBe('host-published')
    expect(mockBeginHostAdmittedStructuredLaunch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'web-runtime' } })
    )
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })

  // Before, the chat opened first and a decline replaced it: the workspace could lose its only tab,
  // the caller heard "failed" while a terminal ran its prompt, and the caller's arguments were lost.
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

    const result = launchAgentInNewTab({
      requestId: 'request-3',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'fix the flaky test',
      promptDelivery: 'submit-after-ready',
      agentArgs: '--model sonnet'
    })

    expect(result?.surface).toEqual({ kind: 'host-published' })
    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
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

  // Before, a local chat opened first and this machine's "no" left it failed, with a Retry that
  // failed the same way and no terminal.
  it("runs the caller's own launch as a local terminal when this machine declines the chat", async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    await useActualAdmission()
    mockCreateSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-10',
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: 'fix the flaky test',
      promptDelivery: 'submit-after-ready',
      agentArgs: '--model sonnet'
    })

    expect(result?.surface).toEqual({ kind: 'host-published' })
    expect(store.createTab).not.toHaveBeenCalled()
    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    expect(store.createTab).toHaveBeenCalledOnce()
    expect(store.createTab.mock.calls[0]?.slice(0, 2)).toEqual(['wt-1', 'group-1'])
    expect(store.queueTabStartupCommand).toHaveBeenCalledOnce()
    expect(store.queueTabStartupCommand.mock.calls[0]?.[1]?.command).toBe(
      "claude '--model' 'sonnet'"
    )
    // The typed prompt goes to that terminal once, and the caller hears it arrived.
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    const { pasteDraftWhenAgentReady } = await import('@/lib/agent-paste-draft')
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledOnce()
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'fix the flaky test' })
    )
    // On this machine the terminal opening is the answer; no notice names a server.
    expect(mockToastInfo).not.toHaveBeenCalled()
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })

  it("opens the caller's own fallback, not the agent's terminal, when it names one", async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    await useActualAdmission()
    mockCreateSupport.mockResolvedValue({ supported: false })
    const onStructuredHostDeclined = vi.fn(() => ({ opened: true }))
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-11',
      agent: 'claude',
      worktreeId: 'wt-1',
      onStructuredHostDeclined
    })

    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    expect(onStructuredHostDeclined).toHaveBeenCalledOnce()
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('keeps the host-published terminal for a paired server without structured sessions', async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockExecutionHostId.mockReturnValue('runtime:web-runtime')
    serverReports([])
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-4',
      agent: 'claude',
      worktreeId: 'wt-1'
    })

    expect(result?.surface).toEqual({ kind: 'host-published' })
    expect(mockBeginHostAdmittedStructuredLaunch).not.toHaveBeenCalled()
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
    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
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

  it('opens the terminal when beforeSurfaceOpen returns undefined rather than false', async () => {
    const beforeSurfaceOpen = vi.fn(() => undefined)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-8',
      agent: 'codex',
      worktreeId: 'wt-1',
      beforeSurfaceOpen
    })

    expect(result?.surface.kind).toBe('local-terminal')
    expect(store.createTab).toHaveBeenCalledTimes(1)
  })

  it('returns null without opening any surface when no startup plan can be built', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    // Why: unbalanced quoting is the real shape behind every caller's "could not build the launch
    // command" toast — the arguments cannot be tokenized, so no surface should be opened at all.
    const result = launchAgentInNewTab({
      requestId: 'request-9',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: "--model 'gpt-5.5"
    })

    expect(result).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })
})
