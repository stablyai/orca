import { createHostSessionLaunchRuntimeFixture } from './remote-runtime-host-session-launch-test-fixture'
import { ExplicitEnsure } from '../../../../../../shared/rpc-contract/agent-session-params'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { deliverCreatedWebRuntimeAgentSessionPrompt } from '@/runtime/hosted-terminals/creation/web-runtime-created-agent-prompt-delivery'
const promptFailure = vi.hoisted(() => ({ error: vi.fn(), copy: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: promptFailure.error } }))
const delivery = vi.hoisted(() =>
  vi.fn<typeof deliverCreatedWebRuntimeAgentSessionPrompt>(async () => true)
)
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-created-agent-prompt-delivery', () => ({
  deliverCreatedWebRuntimeAgentSessionPrompt: delivery
}))
const appStore = vi.hoisted(() => {
  const state = {
    runtimeStatusByEnvironmentId: new Map()
  }
  return { getState: vi.fn(() => state) }
})
vi.mock('@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => undefined)
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
describe('createRemoteRuntimePtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const fixture = createHostSessionLaunchRuntimeFixture()
  const {
    runtimeCall,
    runtimeSubscribe,
    unsubscribe,
    unsubscribeFn,
    latestRemoteSubscribePayload
  } = fixture

  beforeEach(() => {
    vi.resetModules()
    delivery.mockReset().mockResolvedValue(true)
    promptFailure.error.mockClear()
    promptFailure.copy.mockClear()
    fixture.reset()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        runtimeEnvironments: {
          ...originalWindow?.api?.runtimeEnvironments,
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('round-trips a strict saved ensure and its actual refused shell result', async () => {
    const providerSession = { key: 'session_id' as const, id: 'C' }
    const decision = { agent: 'codex' as const, providerSession, verdict: 'chat-home' as const }
    runtimeCall.mockImplementation(async (args: { method?: string; params?: unknown }) => {
      if (args.method === 'status.get') {
        return {
          ok: true,
          result: {
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: [
              'agent-session.host-authority.v1',
              'agent-session.saved-resume-origin.v1'
            ]
          }
        }
      }
      expect(args.method).toBe('terminal.ensureAgentSession')
      expect(ExplicitEnsure.parse(args.params)).toMatchObject({
        resumeOrigin: 'saved',
        providerSession
      })
      return {
        ok: true,
        result: {
          disposition: 'created',
          terminal: {
            handle: 'term-remote',
            worktreeId: 'repo1::/remote/wt',
            title: null,
            savedResumeDecision: decision,
            agentResumeRefused: 'chat-home',
            agentResumeUnavailable: true
          }
        }
      }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      launchAgent: 'codex',
      resumeOrigin: 'saved',
      resumeProviderSession: providerSession,
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    const result = await transport.connect({ url: '', callbacks: {} })
    expect(result).toMatchObject({
      id: 'remote:env-1@@term-remote',
      savedResumeDecision: decision,
      agentResumeRefused: 'chat-home',
      agentResumeUnavailable: true
    })
    expect(result).not.toHaveProperty('launchAgent')
    transport.disconnect()
  })

  it('creates and subscribes to a terminal on the active remote runtime', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onData = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: 'claude',
      env: { ORCA_TAB_ID: 'tab-1' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    const result = await transport.connect({
      url: '',
      callbacks: { onReplayData, onData, onConnect }
    })

    expect(result).toEqual({ id: 'remote:env-1@@term-remote', replay: '' })
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.create',
      params: {
        worktree: 'id:repo1::/remote/wt',
        clientMutationId: expect.any(String),
        command: 'claude',
        env: { ORCA_TAB_ID: 'tab-1' },
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        focus: false,
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.multiplex',
        params: {}
      }),
      expect.any(Object)
    )
    const { streamId } = latestRemoteSubscribePayload()

    fixture.subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({ kind: 'scrollback' })
      })
    )
    fixture.subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotChunk,
        streamId,
        seq: 2,
        payload: encodeTerminalStreamText('hello')
      })
    )
    fixture.subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 3,
        payload: new Uint8Array()
      })
    )
    fixture.subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq: 4,
        payload: encodeTerminalStreamText(' world')
      })
    )

    expect(onReplayData).toHaveBeenCalledWith('hello', { carriesNormalBuffer: true })
    expect(onConnect).toHaveBeenCalled()
    expect(onData).toHaveBeenCalledWith(' world', expect.objectContaining({ seq: 4 }))
  })

  it('reports a host stable-pane adoption as reattach without fresh-spawn ownership', async () => {
    runtimeCall.mockResolvedValue({
      id: 'rpc-create',
      ok: true,
      result: {
        terminal: {
          handle: 'term-original',
          worktreeId: 'repo1::/remote/wt',
          title: 'Original',
          surface: 'background',
          isReattach: true
        }
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const onPtySpawn = vi.fn()
    const onReattachDetermined = vi.fn()
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      onPtySpawn
    })

    const result = await transport.connect({
      url: '',
      callbacks: { onReattachDetermined }
    })

    expect(result).toEqual({
      id: 'remote:env-1@@term-original',
      replay: '',
      isReattach: true
    })
    expect(onReattachDetermined).toHaveBeenCalledOnce()
    expect(onPtySpawn).not.toHaveBeenCalled()
  })

  it('does not close an adopted stable-pane owner when create resolves after destroy', async () => {
    let resolveCreate!: (value: unknown) => void
    runtimeCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        })
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    const connecting = transport.connect({ url: '', callbacks: {} })
    transport.destroy?.()
    resolveCreate({
      id: 'rpc-create',
      ok: true,
      result: {
        terminal: {
          handle: 'term-original',
          worktreeId: 'repo1::/remote/wt',
          title: 'Original',
          surface: 'background',
          isReattach: true
        }
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await connecting

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.close' })
    )
  })

  it('suspends passive remote output until host sleep is cancelled', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { applyHostWorktreeTerminalSleepState } =
      await import('../shutdown/pty-shutdown-exit-deferral')
    const onData = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    await transport.connect({ url: '', callbacks: { onData } })
    const { streamId } = latestRemoteSubscribePayload()
    const started = {
      type: 'worktreeTerminalSleepState' as const,
      worktreeId: 'repo1::/remote/wt',
      generation: 7,
      phase: 'started' as const,
      ptyIds: ['host-pty-1'],
      terminalHandles: ['term-remote']
    }

    applyHostWorktreeTerminalSleepState('env-1', started)
    fixture.subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamText('teardown output')
      })
    )
    expect(onData).not.toHaveBeenCalled()

    applyHostWorktreeTerminalSleepState('env-1', { ...started, phase: 'cancelled' })
    expect(onData).toHaveBeenCalledWith('teardown output', expect.objectContaining({ seq: 1 }))
  })

  it('routes provider resumes through the host authority without sending the client command', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: "claude '--resume' 'provider-session'",
      env: { CLIENT_ONLY: 'must-not-cross' },
      launchAgent: 'claude',
      agentArgsOverride: '--permission-mode plan',
      resumeProviderSession: { key: 'session_id', id: 'provider-session' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.ensureAgentSession',
      params: {
        kind: 'explicit',
        worktree: 'id:repo1::/remote/wt',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'provider-session' },
        agentArgs: '--permission-mode plan',
        placement: {
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111'
        },
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create',
        params: expect.objectContaining({ command: expect.any(String) })
      })
    )
  })

  it('degrades a Kimi resume to a legacy launch when the host predates the resume capability', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: "kimi '--session' 'session_431324d7'",
      launchAgent: 'kimi',
      resumeProviderSession: { key: 'session_id', id: 'session_431324d7' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    await transport.connect({ url: '', callbacks: {} })

    // Baseline host authority lacks Kimi enum support; only the per-agent probe avoids fatal invalid_argument.
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.ensureAgentSession' })
    )
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create',
        params: expect.objectContaining({ command: "kimi '--session' 'session_431324d7'" })
      })
    )
  })

  it('claims the Kimi provider session on a host that advertises the resume capability', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            id: 'rpc-status',
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1', 'agent-session.kimi-resume.v1']
            },
            _meta: { runtimeId: 'runtime-remote' }
          }
        : {
            id: 'rpc-create',
            ok: true,
            result: {
              terminal: {
                handle: 'term-remote',
                worktreeId: 'repo1::/remote/wt',
                title: null,
                surface: 'background'
              }
            },
            _meta: { runtimeId: 'runtime-remote' }
          }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: "kimi '--session' 'session_431324d7'",
      launchAgent: 'kimi',
      resumeProviderSession: { key: 'session_id', id: 'session_431324d7' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.ensureAgentSession',
        params: expect.objectContaining({
          agent: 'kimi',
          providerSession: { key: 'session_id', id: 'session_431324d7' }
        })
      })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create',
        params: expect.objectContaining({ command: expect.any(String) })
      })
    )
  })

  it('treats an explicitly killed remote session as normal retirement', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'terminal.create'
        ? {
            id: 'rpc-create',
            ok: false,
            error: {
              code: 'terminal_gone',
              message: 'Session "pty-dead" was explicitly killed'
            }
          }
        : {
            id: 'rpc-status',
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt'
    })
    const onError = vi.fn()

    await expect(transport.connect({ url: '', callbacks: { onError } })).resolves.toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
  })

  it('routes fresh agents through an idempotent host-built launch', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: "codex 'fix the race'",
      env: { CLIENT_ONLY: 'must-not-cross' },
      launchAgent: 'codex',
      agentPrompt: 'fix the race',
      agentPromptDelivery: 'draft',
      agentLaunchPreferences: { model: 'gpt-5', effort: 'high' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.createAgentSession',
      params: {
        clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        worktree: 'id:repo1::/remote/wt',
        agent: 'codex',
        prompt: 'fix the race',
        promptDelivery: 'draft',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        placement: {
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111'
        },
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create',
        params: expect.objectContaining({ command: expect.any(String) })
      })
    )
  })

  it('normalizes a non-native draft through the shared host startup contract and delivers to the returned pane once', async () => {
    const original = runtimeCall.getMockImplementation()!
    const { buildAgentDraftLaunchPlan, buildAgentStartupPlan } =
      await import('../../../../../../shared/agent-launch/startup/tui-agent-startup')
    const { resolveAgentStartupPlanInputs } =
      await import('../../../../../../shared/agent-launch/startup/agent-startup-plan-inputs')
    let statusAnswered = false
    runtimeCall.mockImplementation(
      async (args: { method?: string; params?: Record<string, unknown> }) => {
        if (args.method === 'status.get') {
          if (statusAnswered) {
            return await new Promise(() => {})
          }
          statusAnswered = true
        }
        const response = await original(args)
        if (args.method === 'terminal.createAgentSession') {
          const params = args.params!
          const inputs = resolveAgentStartupPlanInputs({
            agent: 'codex',
            settings: {},
            agentArgs: '',
            sessionOptions: {
              model: 'gpt-host-pick',
              effort: 'high',
              permissionMode: 'full-access'
            },
            platform: 'linux',
            shell: 'posix',
            isRemote: false
          })
          const prompt = String(params.prompt ?? '')
          const plan =
            params.promptDelivery === 'draft'
              ? buildAgentDraftLaunchPlan({ ...inputs, draft: prompt })
              : buildAgentStartupPlan({ ...inputs, prompt, allowEmptyPromptLaunch: true })
          if (!plan) {
            return {
              ok: false,
              error: { code: 'capability_unsupported', message: 'No native draft' }
            }
          }
          return {
            ...response,
            result: {
              ...response.result,
              disposition: 'created',
              terminal: { ...response.result.terminal, tabId: 'host-adopted' }
            }
          }
        }
        return args.method === 'status.get'
          ? {
              ...response,
              result: {
                ...response.result,
                capabilities: ['agent-session.host-authority.v1', 'agent-session.create-options.v1']
              }
            }
          : response
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: '/desktop/codex --model desktop',
      env: { DESKTOP_ONLY: 'yes' },
      launchAgent: 'codex',
      launchToken: 'draft-recovery-token',
      freshAgentLaunch: {
        agentArgs: '',
        sessionOptions: { model: 'gpt-host-pick', effort: 'high', permissionMode: 'full-access' },
        prompt: 'ship it',
        promptDelivery: 'draft'
      },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    await transport.connect({ url: '', callbacks: {} })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.createAgentSession',
        params: expect.objectContaining({
          agent: 'codex',
          agentArgs: '',
          sessionOptions: { model: 'gpt-host-pick', effort: 'high', permissionMode: 'full-access' }
        })
      })
    )
    const create = runtimeCall.mock.calls.find(
      ([args]) => args.method === 'terminal.createAgentSession'
    )?.[0]
    expect(create?.params).not.toHaveProperty('command')
    expect(create?.params).not.toHaveProperty('env')
    expect(delivery).toHaveBeenCalledExactlyOnceWith(
      { outcome: { status: 'created' }, hostTabId: 'host-adopted' },
      expect.objectContaining({
        agent: 'codex',
        rendererTabId: 'web-terminal-host-adopted',
        promptAfterReady: 'ship it',
        submitPrompt: false,
        forcePromptPaste: true
      })
    )
    const delivered = delivery.mock.calls[0]?.[1]
    await expect(delivered?.launchPty).resolves.toBe('remote:env-1@@term-remote')
    expect(delivered?.beforePaste?.()).toBe(true)
    transport.disconnect()
    expect(delivered?.beforePaste?.()).toBe(false)
  })

  it('reports a failed single Aider prompt attempt once with Copy prompt after a transient detach', async () => {
    let finishDelivery!: (delivered: boolean) => void
    delivery.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishDelivery = resolve
        })
    )
    Object.assign(window.api, { ui: { writeClipboardText: promptFailure.copy } })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      launchAgent: 'aider',
      launchToken: 'aider-launch',
      freshAgentLaunch: { prompt: 'fix the parser', promptDelivery: 'draft' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    await transport.connect({ url: '', callbacks: {} })
    transport.disconnect()
    finishDelivery(false)
    await vi.dynamicImportSettled()
    expect(delivery).toHaveBeenCalledOnce()
    expect(promptFailure.error).toHaveBeenCalledOnce()
    promptFailure.error.mock.calls[0]?.[1].action.onClick()
    expect(promptFailure.copy).toHaveBeenCalledExactlyOnceWith('fix the parser')
    transport.disconnect()
    await vi.dynamicImportSettled()
    expect(delivery).toHaveBeenCalledOnce()
    expect(promptFailure.error).toHaveBeenCalledOnce()
  })

  it('keeps the existing pane request when an old host needs a prepared launch', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: 'goose',
      launchAgent: 'goose',
      agentLaunchPreferences: { mode: 'full-access' },
      freshAgentLaunch: {
        sessionOptions: { permissionMode: 'full-access' },
        prompt: 'fix permissions',
        promptDelivery: 'auto-submit'
      },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    await transport.connect({ url: '', callbacks: {} })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.createAgentSession',
        params: expect.objectContaining({
          agent: 'goose',
          launchPreferences: { mode: 'full-access' }
        })
      })
    )
    const create = runtimeCall.mock.calls.find(
      ([args]) => args.method === 'terminal.createAgentSession'
    )?.[0]
    expect(create?.params).not.toHaveProperty('sessionOptions')
    expect(create?.params).not.toHaveProperty('prompt')
    expect(delivery).toHaveBeenCalledExactlyOnceWith(
      { outcome: { status: 'created' }, hostTabId: undefined },
      expect.objectContaining({
        promptAfterReady: 'fix permissions',
        submitPrompt: true,
        forcePromptPaste: true
      })
    )
    transport.disconnect()
  })

  it.each([
    {
      agent: 'codex' as const,
      delivery: 'draft' as const,
      submit: false,
      command: "codex '-c' 'disable_paste_burst=true'"
    },
    {
      agent: 'aider' as const,
      delivery: 'auto-submit' as const,
      submit: true,
      command: 'aider'
    }
  ])(
    'delivers ordinary legacy $agent text once without a recovery flag',
    async ({ agent, delivery: promptDelivery, submit, command }) => {
      const original = runtimeCall.getMockImplementation()!
      runtimeCall.mockImplementation(async (args: { method?: string }) => {
        const result = await original(args)
        return args.method === 'status.get'
          ? { ...result, result: { ...result.result, capabilities: [] } }
          : result
      })
      const { planLaunchAgentStartupPrompt } =
        await import('@/lib/agent-session/launch/prompt/launch-agent-startup-prompt-plan')
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const prepare = () =>
        planLaunchAgentStartupPrompt({
          base: { agent, cmdOverrides: {}, agentArgs: null, platform: 'linux', isRemote: true },
          prompt: 'ordinary work',
          promptDelivery,
          submitFollowup: true,
          isFollowupPath: agent === 'aider'
        })
      const startup = prepare().startupPlan!
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'repo1::/remote/wt',
        launchAgent: agent,
        launchToken: `ordinary-${agent}`,
        command: startup.launchCommand,
        freshAgentLaunch: { prompt: 'ordinary work', promptDelivery, legacy: prepare },
        tabId: 'ordinary-tab',
        leafId: '11111111-1111-4111-8111-111111111111'
      })
      await transport.connect({ url: '', callbacks: {} })
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.create',
          params: expect.objectContaining({ command })
        })
      )
      expect(delivery).toHaveBeenCalledExactlyOnceWith(
        { outcome: { status: 'created' }, hostTabId: undefined },
        expect.objectContaining({
          rendererTabId: 'ordinary-tab',
          promptAfterReady: 'ordinary work',
          submitPrompt: submit,
          forcePromptPaste: true
        })
      )
      transport.disconnect()
    }
  )

  it('forwards input over the stream and disconnects without closing shared remote sessions', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'repo1::/remote/wt',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestRemoteSubscribePayload()
      runtimeCall.mockClear()
      const send = unsubscribe?.sendBinary as unknown as {
        mockClear: () => void
        mock: { calls: [Uint8Array<ArrayBufferLike>][] }
      }
      send.mockClear()

      expect(transport.sendInput('ls\r', 'driving')).toBe(true)
      await vi.runOnlyPendingTimersAsync()
      expect(runtimeCall).not.toHaveBeenCalled()
      const inputFrame = decodeTerminalStreamFrame(send.mock.calls[0][0])
      expect(inputFrame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(inputFrame?.streamId).toBe(streamId)

      transport.disconnect()
      expect(unsubscribeFn).toHaveBeenCalled()
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.close'
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
