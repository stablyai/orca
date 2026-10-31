import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  callerProfileCases,
  type AgentLaunchCallerProfile
} from './agent-launch-caller-profiles-test-harness'
import {
  createLaunchFunnelStore,
  createdTabOptions,
  hostLaunchRequest,
  queuedStartupPayload,
  resetLaunchFunnelStore
} from './agent-launch-funnel-test-harness'

import type * as LaunchAdmissionModule from './structured-agent-session-launch-admission'
import { projectSourceControlActionLaunch } from '../../../shared/source-control-action-launch-preferences'
import { tokenizeStartupCommand } from '../../../shared/tui-agent-startup-shell'
const store = createLaunchFunnelStore()
const mockIsWebRuntimeSessionActive = vi.fn(() => false)
const mockLaunchAgentInWebHostTab = vi.fn()
const mockBeginHostAdmittedStructuredLaunch = vi.fn()
const mockCreateSupport = vi.fn()
const mockAwaitCapabilities = vi.fn()
const mockHostCapabilities = vi.fn<() => readonly string[] | null>(() => [])
const mockExecutionHostId = vi.fn(() => 'local')

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('../../../shared/native-chat/transcript/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => mockExecutionHostId(),
  runtimeEnvironmentIdOrLocalUnlessTwin: () => 'web-runtime'
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
// Mock structured execution while retaining real route selection; callers must still reach the correct surface.
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
    mockLaunchAgentInWebHostTab.mockResolvedValue({
      delivered: true,
      failureNotified: false,
      outcome: { status: 'created' }
    })
  })

  it.each([
    { surface: 'chat', chatDefault: false, supported: true, chat: true },
    { surface: 'terminal', chatDefault: true, supported: true, chat: false },
    { surface: undefined, chatDefault: true, supported: true, chat: true },
    { surface: undefined, chatDefault: false, supported: true, chat: false },
    { surface: 'chat', chatDefault: false, supported: false, chat: false }
  ] as const)(
    'replays saved $surface with Chat default $chatDefault and host support $supported',
    async ({ surface, chatDefault, supported, chat }) => {
      store.settings = { ...store.settings, nativeChatProviders: { codex: chatDefault } }
      mockHostCapabilities.mockReturnValue(
        supported ? [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] : []
      )
      const projection = projectSourceControlActionLaunch(
        { agentId: 'codex', surface, agentArgs: '--search' },
        'codex',
        { basePrompt: 'Fix checks', settings: store.settings }
      )
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const result = launchAgentInNewTab({
        requestId: 'saved-surface',
        agent: 'codex',
        worktreeId: 'wt-1',
        ...projection
      })
      expect(result?.surface.kind).toBe(chat ? 'host-published' : 'local-terminal')
      if (chat) {
        expect(store.createTab).not.toHaveBeenCalled()
        expect(mockBeginHostAdmittedStructuredLaunch).toHaveBeenCalledOnce()
        expect(mockBeginHostAdmittedStructuredLaunch).toHaveBeenCalledWith(
          expect.objectContaining({
            plan: expect.objectContaining({ agent: 'codex', route: 'structured-native-chat' }),
            worktreeId: 'wt-1'
          })
        )
        expect(mockBeginHostAdmittedStructuredLaunch.mock.calls[0][0].plan).not.toHaveProperty(
          'requestedSurface'
        )
      } else {
        expect(mockBeginHostAdmittedStructuredLaunch).not.toHaveBeenCalled()
        expect(store.createTab).toHaveBeenCalledOnce()
        expect(
          tokenizeStartupCommand(String(queuedStartupPayload(store)?.command), 'posix')
        ).toMatchObject({
          ok: true,
          tokens: ['codex', '-c', 'disable_paste_burst=true', '--search']
        })
      }
    }
  )

  it.each(['new-tab', 'default-no-callback'] as const)(
    'settles delayed saved-source decline through %s with the captured Terminal base and exact Args',
    async (consumer) => {
      store.settings = {
        ...store.settings,
        nativeChatProviders: { codex: false },
        agentCmdOverrides: { codex: 'cx' }
      }
      await useActualAdmission()
      let answer!: (value: { supported: boolean }) => void
      mockCreateSupport.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve
        })
      )
      const projection: Omit<
        ReturnType<typeof projectSourceControlActionLaunch>,
        'sessionOptions' | 'chatSessionOptions'
      > & { sessionOptions?: Record<string, string>; chatSessionOptions?: Record<string, string> } =
        projectSourceControlActionLaunch(
          {
            agentId: 'codex',
            surface: 'chat',
            agentArgs: `-c 'model="true"'`,
            launchPreferences: {
              agentId: 'codex',
              modelSelection: {
                base: 'default',
                options: { effort: { agentId: 'codex', value: 'high' } }
              }
            }
          },
          'codex',
          { basePrompt: 'Fix checks' }
        )
      expect(projection.sessionOptions).toEqual({ effort: 'high' })
      expect(projection.chatSessionOptions).toEqual({ model: 'true', effort: 'high' })
      const { useAppStore } = await import('@/store')
      const { planAgentSessionLaunch } = await import('./agent-session-launch-plan')
      const { beginStructuredAgentSessionProvisionalLaunch } =
        await import('./agent-session/structured-agent-session-provisional-tab')
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const result =
        consumer === 'new-tab'
          ? launchAgentInNewTab({
              requestId: 'delayed-q',
              agent: 'codex',
              worktreeId: 'wt-1',
              launchPlatform: 'linux',
              ...projection
            })
          : beginStructuredAgentSessionProvisionalLaunch({
              plan: planAgentSessionLaunch(useAppStore.getState(), {
                requestId: 'delayed-q',
                agent: 'codex',
                workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
                launchOptions: projection.sessionOptions,
                chatLaunchOptions: projection.chatSessionOptions,
                preferredSurface: projection.preferredSurface
              }),
              hooks: {},
              declinedTerminal: { agentArgs: projection.agentArgs, launchPlatform: 'linux' }
            })
      expect(store.createTab).not.toHaveBeenCalled()
      expect(mockCreateSupport).toHaveBeenCalledOnce()
      // The form can change while the host owns the outstanding admission.
      Object.assign(projection.sessionOptions!, { effort: 'low' })
      Object.assign(projection.chatSessionOptions!, { model: 'later-form', effort: 'low' })
      projection.agentArgs = '--search'
      answer({ supported: false })
      const settlement =
        result &&
        ('structuredSettlement' in result
          ? result.structuredSettlement
          : 'settlement' in result
            ? result.settlement
            : undefined)
      await expect(settlement).resolves.toEqual({ kind: 'terminal' })
      expect(store.createTab).toHaveBeenCalledOnce()
      const startup = queuedStartupPayload(store)
      expect(tokenizeStartupCommand(String(startup?.command), 'posix')).toEqual(
        expect.objectContaining({
          ok: true,
          tokens: ['cx', '-c', 'model="true"', '-c', 'model_reasoning_effort=high']
        })
      )
      expect(startup?.launchConfig).toEqual({
        agentCommand: `cx '-c' 'model="true"'`,
        agentArgs: `-c 'model="true"'`,
        agentEnv: {}
      })
      expect(JSON.stringify(startup)).not.toContain('chatSessionOptions')
      expect(JSON.stringify(startup)).not.toContain('chatLaunchOptions')
      expect(JSON.stringify(startup)).not.toContain('later-form')
      expect(mockCreateSupport).toHaveBeenCalledOnce()
    }
  )

  it('settles actual host-answer re-entry and Chat decline from the same captured source', async () => {
    store.settings = {
      ...store.settings,
      nativeChatProviders: { codex: false },
      agentCmdOverrides: { codex: 'cx' }
    }
    mockHostCapabilities.mockReturnValue(null)
    const known = Promise.withResolvers<readonly string[]>()
    const stop = vi.fn()
    mockAwaitCapabilities.mockReturnValue({ known: known.promise, stop })
    mockCreateSupport.mockResolvedValue({ supported: false })
    await useActualAdmission()
    const projection: Omit<
      ReturnType<typeof projectSourceControlActionLaunch>,
      'sessionOptions' | 'chatSessionOptions'
    > & { sessionOptions?: Record<string, string>; chatSessionOptions?: Record<string, string> } =
      projectSourceControlActionLaunch(
        {
          agentId: 'codex',
          surface: 'chat',
          agentArgs: `-c 'model="true"'`,
          launchPreferences: {
            agentId: 'codex',
            modelSelection: {
              base: 'default',
              options: { effort: { agentId: 'codex', value: 'high' } }
            }
          }
        },
        'codex',
        { basePrompt: 'Fix checks' }
      )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const result = launchAgentInNewTab({
      requestId: 'wait-q',
      agent: 'codex',
      worktreeId: 'wt-1',
      ...projection
    })
    expect(result?.surface.kind).toBe('host-published')
    expect(mockCreateSupport).not.toHaveBeenCalled()
    projection.agentArgs = '--model later-form'
    projection.sessionOptions!.effort = 'low'
    projection.chatSessionOptions!.model = 'later-form'
    const capabilities = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    mockHostCapabilities.mockReturnValue(capabilities)
    known.resolve(capabilities)
    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    expect(mockAwaitCapabilities).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(mockCreateSupport).toHaveBeenCalledOnce()
    expect(
      tokenizeStartupCommand(String(queuedStartupPayload(store)?.command), 'posix')
    ).toMatchObject({
      ok: true,
      tokens: ['cx', '-c', 'model="true"', '-c', 'model_reasoning_effort=high']
    })
    expect(queuedStartupPayload(store)?.launchConfig?.agentArgs).toBe(`-c 'model="true"'`)
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

      // A caller-named custom cwd requires a PTY, so enabling default chat cannot admit that profile.
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

  // Local refusal must fall back to a terminal rather than strand a failed chat with a futile Retry.
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
    expect(hostLaunchRequest(store)).toMatchObject({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:wt-1' },
      agentArgs: '--model sonnet'
    })
    const options = createdTabOptions(store)
    const tabId = options?.id
    if (typeof tabId !== 'string') {
      throw new Error('Expected an allocated terminal tab id')
    }
    expect(options).toMatchObject({
      id: store.createTab.mock.results[0]?.value.id,
      initialLeafId: expect.any(String),
      agentLaunchPane: { leafId: options?.initialLeafId }
    })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    const { pasteDraftWhenAgentReady } = await import('@/lib/agent-paste-draft')
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledOnce()
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ tabId, content: 'fix the flaky test' })
    )
    await expect(vi.mocked(pasteDraftWhenAgentReady).mock.calls[0]?.[0].launchPty).resolves.toBe(
      `${tabId}-pty`
    )
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

    // Unbalanced argument quoting must abort before any surface opens.
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
