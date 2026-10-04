// Which surface each production call site resolves to, and what aborts the open.
// Split from the command/prompt/placement files by responsibility; the profile table they share
// lives in agent-launch-caller-profiles-test-harness.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import {
  RUNTIME_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  callerProfileCases,
  type AgentLaunchCallerProfile
} from './agent-launch-caller-profiles-test-harness'
import { createLaunchFunnelStore, resetLaunchFunnelStore } from './agent-launch-funnel-test-harness'

import type * as PairedAdmissionModule from './structured-agent-session-paired-admission'
const store = createLaunchFunnelStore()
const mockIsWebRuntimeSessionActive = vi.fn(() => false)
const mockLaunchAgentInWebHostTab = vi.fn()
const mockLaunchAgentInStructuredNewTab = vi.fn()
const mockBeginPairedStructuredLaunch = vi.fn()
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
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/structured-agent-session-paired-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof PairedAdmissionModule>()),
  beginPairedStructuredLaunch: mockBeginPairedStructuredLaunch
}))
vi.mock('@/lib/launch-agent-in-new-tab-structured', () => ({
  launchAgentInStructuredNewTab: mockLaunchAgentInStructuredNewTab
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => mockHostCapabilities()
}))
/** What the paired server that owns 'wt-1' last reported about itself. */
function serverReports(capabilities: readonly string[] | null): void {
  Object.assign(store, {
    runtimeStatusByEnvironmentId: new Map(
      capabilities ? [['web-runtime', { status: { capabilities } }]] : []
    )
  })
}

const CHAT_DEFAULT_SETTINGS = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}

const cases = callerProfileCases()

async function launch(profile: AgentLaunchCallerProfile) {
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  return launchAgentInNewTab({ ...profile.args })
}

describe('agent launch caller routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLaunchFunnelStore(store)
    mockIsWebRuntimeSessionActive.mockReturnValue(false)
    mockExecutionHostId.mockReturnValue('local')
    serverReports(null)
    mockHostCapabilities.mockReturnValue([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
    mockLaunchAgentInStructuredNewTab.mockReturnValue({
      sessionId: 'session-1',
      tabId: 'tab-structured',
      structuredSettlement: Promise.resolve({ kind: 'structured' })
    })
    mockLaunchAgentInWebHostTab.mockResolvedValue({ delivered: true, failureNotified: false })
  })

  it.each([
    ['git-worktree', 'wt-1'],
    ['folder', 'folder:official-folder']
  ] as const)(
    'official ACP reaches the supported structured executor for %s',
    async (kind, worktreeId) => {
      mockHostCapabilities.mockReturnValue(RUNTIME_CAPABILITIES)
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const { planAgentSessionLaunch } = await import('./agent-session-launch-plan')
      const plannerStore = {
        ...store,
        repos: [],
        projects: [],
        activeRepoId: null,
        activeWorktreeId: null,
        worktreesByRepo: {},
        settings: createGlobalSettingsFixture(store.settings),
        projectGroups: [],
        folderWorkspaces: [
          {
            id: 'official-folder',
            folderPath: '/tmp/official-folder',
            executionHostId: 'local' as const,
            projectGroupId: 'group-1',
            name: 'Official folder',
            linkedTask: null,
            comment: '',
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 0,
            createdAt: 0,
            updatedAt: 0
          }
        ]
      }
      Object.assign(store, plannerStore)
      const plan = planAgentSessionLaunch(plannerStore, {
        agent: 'dsh-acp',
        workspace: { kind, worktreeId }
      })
      expect(plan.route).toBe('structured-native-chat')
      const result = launchAgentInNewTab({ agent: 'dsh-acp', worktreeId })
      expect(result?.surface.kind).toBe('local-agent-session')
      expect(result?.startupPlan).toBeNull()
      expect(mockLaunchAgentInStructuredNewTab).toHaveBeenCalledTimes(1)
      expect(store.createTab).not.toHaveBeenCalled()
      expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    }
  )

  it.each(['auto-submit', 'draft', 'submit-after-ready'] as const)(
    'carries official ACP %s prompts through the structured plan',
    async (promptDelivery) => {
      mockHostCapabilities.mockReturnValue(RUNTIME_CAPABILITIES)
      const onPromptDelivered = vi.fn()
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const result = launchAgentInNewTab({
        agent: 'dsh-acp',
        worktreeId: 'wt-1',
        groupId: 'group-1',
        prompt: '  Explain this change.  ',
        promptDelivery,
        onPromptDelivered
      })
      expect(result?.surface.kind).toBe('local-agent-session')
      expect(mockLaunchAgentInStructuredNewTab).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          targetGroupId: 'group-1',
          plan: expect.objectContaining({
            agent: 'dsh-acp',
            prompt: 'Explain this change.',
            promptDelivery: promptDelivery === 'auto-submit' ? 'draft' : promptDelivery,
            onPromptDelivered
          })
        })
      )
      expect(onPromptDelivered).not.toHaveBeenCalled()
      expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
      expect(store.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
    }
  )

  it.each([null, [], [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]])(
    'refuses official ACP with unestablished or missing host capabilities %j',
    async (capabilities) => {
      mockHostCapabilities.mockReturnValue(capabilities)
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      expect(launchAgentInNewTab({ agent: 'dsh-acp', worktreeId: 'wt-1' })).toBeNull()
      expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
      expect(store.createTab).not.toHaveBeenCalled()
    }
  )

  it.each([null, [], [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]])(
    'refuses official ACP on a paired host without negotiated capabilities %j',
    async (capabilities) => {
      mockHostCapabilities.mockReturnValue(RUNTIME_CAPABILITIES)
      mockExecutionHostId.mockReturnValue('runtime:web-runtime')
      mockIsWebRuntimeSessionActive.mockReturnValue(true)
      serverReports(capabilities)
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      expect(launchAgentInNewTab({ agent: 'dsh-acp', worktreeId: 'wt-1' })).toBeNull()
      expect(mockBeginPairedStructuredLaunch).not.toHaveBeenCalled()
      expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
      expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
      expect(store.createTab).not.toHaveBeenCalled()
    }
  )

  it.each(['override', 'cwd', 'ssh'] as const)(
    'refuses official ACP terminal customization %s',
    async (reason) => {
      mockHostCapabilities.mockReturnValue(RUNTIME_CAPABILITIES)
      if (reason === 'override') {
        store.settings.agentCmdOverrides = { 'dsh-acp': 'dsh --profile acp' }
      }
      if (reason === 'ssh') {
        mockExecutionHostId.mockReturnValue('ssh:connection-1')
      }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      expect(
        launchAgentInNewTab({
          agent: 'dsh-acp',
          worktreeId: 'wt-1',
          ...(reason === 'cwd' ? { initialCwd: '/outside-workspace' } : {})
        })
      ).toBeNull()
      expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
      expect(store.createTab).not.toHaveBeenCalled()
    }
  )

  it('asks the owning paired host to admit official ACP before opening a session', async () => {
    mockExecutionHostId.mockReturnValue('runtime:web-runtime')
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockHostCapabilities.mockReturnValue([])
    serverReports(RUNTIME_CAPABILITIES)
    mockBeginPairedStructuredLaunch.mockReturnValueOnce({
      sessionId: null,
      tab: null,
      settlement: new Promise(() => undefined),
      cancel: vi.fn()
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    expect(launchAgentInNewTab({ agent: 'dsh-acp', worktreeId: 'wt-1' })?.surface).toEqual({
      kind: 'host-published'
    })
    expect(mockBeginPairedStructuredLaunch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        executionHostId: 'runtime:web-runtime',
        plan: expect.objectContaining({ agent: 'dsh-acp' })
      })
    )
    expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })

  it.each(['declined', 'unreachable'] as const)(
    'opens no ACP terminal or local session when a paired host is %s',
    async (answer) => {
      mockExecutionHostId.mockReturnValue('runtime:web-runtime')
      mockIsWebRuntimeSessionActive.mockReturnValue(true)
      serverReports(RUNTIME_CAPABILITIES)
      const actual = await vi.importActual<typeof PairedAdmissionModule>(
        './structured-agent-session-paired-admission'
      )
      mockBeginPairedStructuredLaunch.mockImplementationOnce(actual.beginPairedStructuredLaunch)
      if (answer === 'declined') {
        mockCreateSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
      } else {
        mockCreateSupport.mockRejectedValue(new Error('disconnected'))
      }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const result = launchAgentInNewTab({
        agent: 'dsh-acp',
        worktreeId: 'wt-1',
        prompt: 'Explain this change.',
        promptDelivery: 'submit-after-ready'
      })
      expect(result?.surface.kind).toBe('host-published')
      await expect(result?.structuredSettlement).resolves.toMatchObject({
        kind: answer === 'declined' ? 'cancelled' : 'failed'
      })
      await expect(result?.promptDeliveryResult).resolves.toMatchObject({ delivered: false })
      expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
      expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
      expect(store.createTab).not.toHaveBeenCalled()
    }
  )

  it.each(cases)('routes %s to a local terminal under default settings', async (_id, profile) => {
    const result = await launch(profile)

    expect(result?.surface.kind).toBe('local-terminal')
    expect(store.createTab).toHaveBeenCalledTimes(1)
    expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
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

      // Why: two profiles are structurally barred rather than merely unconfigured — the floating
      // sentinel has no workspace a session can live in, and a caller-named cwd is a process shape
      // only a PTY produces. Both must stay terminal even with the structured default on.
      const structurallyBarred =
        profile.id === 'floating-default-agent' || profile.id === 'session-continuation'
      expect(result?.surface.kind).toBe(
        structurallyBarred ? 'local-terminal' : 'local-agent-session'
      )
    }
  )

  it.each(cases)(
    'reports the structured session identity to %s when it routes structured',
    async (_id, profile) => {
      store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }

      const result = await launch(profile)

      if (result?.surface.kind !== 'local-agent-session') {
        expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
        return
      }
      expect(result.surface).toEqual({
        kind: 'local-agent-session',
        tabId: 'tab-structured',
        sessionId: 'session-1'
      })
      expect(result.pasteDraftAfterLaunch).toBe(false)
      expect(store.createTab).not.toHaveBeenCalled()
      // Placement is the one launch input that does ride to the structured executor, as a target
      // group rather than anything on a wire.
      expect(mockLaunchAgentInStructuredNewTab.mock.calls[0]?.[0]?.targetGroupId).toBe(
        profile.args.groupId
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

    mockBeginPairedStructuredLaunch.mockReturnValueOnce({
      sessionId: null,
      tab: null,
      settlement: new Promise(() => undefined),
      cancel: vi.fn()
    })

    const result = launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    // The server admits the chat before any of it exists here, so the surface is the host's.
    expect(result?.surface.kind).toBe('host-published')
    expect(mockBeginPairedStructuredLaunch).toHaveBeenCalledTimes(1)
    expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
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
    const actual = await vi.importActual<typeof PairedAdmissionModule>(
      './structured-agent-session-paired-admission'
    )
    mockBeginPairedStructuredLaunch.mockImplementationOnce(actual.beginPairedStructuredLaunch)
    mockCreateSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
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
    expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('keeps the host-published terminal for a paired server without structured sessions', async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockExecutionHostId.mockReturnValue('runtime:web-runtime')
    serverReports([])
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    expect(result?.surface).toEqual({ kind: 'host-published' })
    expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
  })

  it('aborts a terminal open when beforeSurfaceOpen refuses', async () => {
    const beforeSurfaceOpen = vi.fn(() => false)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', beforeSurfaceOpen })

    expect(result).toBeNull()
    expect(beforeSurfaceOpen).toHaveBeenCalledExactlyOnceWith({ kind: 'local-terminal' })
    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
  })

  it('aborts a host-published open when beforeSurfaceOpen refuses', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const beforeSurfaceOpen = vi.fn(() => false)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', beforeSurfaceOpen })

    expect(result).toBeNull()
    expect(beforeSurfaceOpen).toHaveBeenCalledExactlyOnceWith({ kind: 'host-published' })
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })

  it('hands the structured branch a session-scoped refusal hook', async () => {
    store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
    const beforeSurfaceOpen = vi.fn(() => false)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', beforeSurfaceOpen })

    // Why: the structured route cannot name its surface before the session id exists, so the
    // funnel wraps the caller's hook and the structured executor decides when to ask.
    const beforeOpen = mockLaunchAgentInStructuredNewTab.mock.calls[0]?.[0]?.beforeOpen
    expect(typeof beforeOpen).toBe('function')
    expect(beforeSurfaceOpen).not.toHaveBeenCalled()
    expect(beforeOpen('session-7')).toBe(false)
    expect(beforeSurfaceOpen).toHaveBeenCalledExactlyOnceWith({
      kind: 'local-agent-session',
      sessionId: 'session-7'
    })
  })

  it('opens the terminal when beforeSurfaceOpen returns undefined rather than false', async () => {
    const beforeSurfaceOpen = vi.fn(() => undefined)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', beforeSurfaceOpen })

    expect(result?.surface.kind).toBe('local-terminal')
    expect(store.createTab).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'returns null without opening any surface for malformed CLI arguments with structured default %s',
    async (structuredDefault) => {
      if (structuredDefault) {
        store.settings = { ...store.settings, ...CHAT_DEFAULT_SETTINGS }
      }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      // Why: unbalanced quoting is the real shape behind every caller's "could not build the launch
      // command" toast — the arguments cannot be tokenized, so no surface should be opened at all.
      const result = launchAgentInNewTab({
        agent: 'codex',
        worktreeId: 'wt-1',
        agentArgs: "--model 'gpt-5.5"
      })

      expect(result).toBeNull()
      expect(store.createTab).not.toHaveBeenCalled()
      expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
      expect(mockLaunchAgentInStructuredNewTab).not.toHaveBeenCalled()
    }
  )
})
