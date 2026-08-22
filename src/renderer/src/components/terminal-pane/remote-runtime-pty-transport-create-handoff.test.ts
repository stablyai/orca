import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, refreshSessionTabsSnapshot, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

describe('createRemoteRuntimePtyTransport', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('closes a remote terminal created after the pane was destroyed', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    transport.destroy?.()
    resolveCreate({ ok: true, result: { terminal: { handle: 'terminal-late' } } })
    await connect

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.close',
      params: { terminal: 'terminal-late' },
      timeoutMs: 15_000
    })
  })

  it('cannot let a stale create completion replace a newer attached terminal', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtySpawn = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onPtySpawn
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    transport.attach({ existingPtyId: 'remote:env-2@@terminal-attached', callbacks: {} })
    resolveCreate({ ok: true, result: { terminal: { handle: 'terminal-late' } } })
    await connect

    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-attached')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.close',
      params: { terminal: 'terminal-late' },
      timeoutMs: 15_000
    })
    transport.destroy?.()
  })

  it('does not close a live owner adopted after provisional pane handoff', async () => {
    let resolveEnsure: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'status.get') {
        return Promise.resolve({
          ok: true,
          result: {
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        })
      }
      if (args.method === 'terminal.ensureAgentSession') {
        return new Promise((resolve) => {
          resolveEnsure = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      launchAgent: 'codex',
      resumeProviderSession: { key: 'session_id', id: 'live-session' }
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.ensureAgentSession' })
      )
    )
    transport.destroy?.()
    resolveEnsure({
      ok: true,
      result: {
        disposition: 'adopted',
        terminal: { handle: 'terminal-live', worktreeId: 'wt-1', title: null }
      }
    })
    await connect

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.close' })
    )
  })

  it('does not close a structured create after provisional pane handoff', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'status.get') {
        return Promise.resolve({
          ok: true,
          result: {
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        })
      }
      if (args.method === 'terminal.createAgentSession') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'provisional-tab',
      leafId: 'provisional-leaf',
      launchAgent: 'codex'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.createAgentSession' })
      )
    )
    transport.destroy?.()
    resolveCreate({
      ok: true,
      result: {
        disposition: 'created',
        terminal: {
          handle: 'terminal-live',
          tabId: 'canonical-host-tab',
          leafId: 'canonical-host-leaf'
        }
      }
    })
    await connect

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.close' })
    )
  })

  it('passes activation intent when creating the remote runtime terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      activate: true
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          tabId: 'tab-1',
          leafId: 'pane:1',
          focus: false,
          presentation: 'background',
          activate: true
        })
      })
    )
  })

  it('scopes ephemeral setup terminals to the floating-terminal selector (#6789)', async () => {
    const { brandEphemeralSetupTerminalWorktreeId } =
      await import('../../../../shared/ephemeral-setup-terminal-worktree-id')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: brandEphemeralSetupTerminalWorktreeId(
        'feature-wall-orchestration-skill-terminal'
      ),
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          worktree: 'id:global-floating-terminal'
        })
      })
    )
  })

  it('passes startup command delivery when creating the remote runtime terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      command: "codex 'linked issue context'",
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      startupCommandDelivery: 'shell-ready',
      terminalColorQueryReplies: { foreground: '#ffffff', background: '#282c34' }
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          command: "codex 'linked issue context'",
          envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
          startupCommandDelivery: 'shell-ready',
          terminalColorQueryReplies: { foreground: '#ffffff', background: '#282c34' }
        })
      })
    )
  })

  it('uses connect-time agent identity while the remote host builds the launch', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1', 'agent-session.omp-resume-path.v1']
            }
          }
        : { ok: true, result: { terminal: { handle: 'terminal-1' } } }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      command: "codex 'old'",
      launchConfig: { agentArgs: '--old', agentEnv: {} },
      agentArgsOverride: '--profile captured',
      launchToken: 'old-token',
      launchAgent: 'codex'
    })

    await transport.connect({
      url: '',
      command: "codex '--model' 'gpt-5' 'resume' 'session-1'",
      env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'fresh-token' },
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' },
        ompResumeFilePath: '/custom/omp/project/session.jsonl'
      },
      launchToken: 'fresh-token',
      launchAgent: 'omp',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-1'
      },
      callbacks: {}
    })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.ensureAgentSession',
        params: expect.objectContaining({
          kind: 'explicit',
          worktree: 'id:wt-1',
          agent: 'omp',
          providerSession: {
            key: 'session_id',
            id: 'session-1'
          },
          ompResumeFilePath: '/custom/omp/project/session.jsonl',
          agentArgs: '--profile captured',
          placement: { tabId: 'tab-1', leafId: 'pane:1' },
          presentation: 'background'
        })
      })
    )
  })

  it('records the exact provisional handoff and refreshes a snapshot that arrived early', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        : {
            ok: true,
            result: {
              disposition: 'created',
              terminal: {
                handle: 'terminal-1',
                tabId: 'canonical-host-tab',
                leafId: 'canonical-host-leaf'
              }
            }
          }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { resolveWebAgentSessionHandoff } =
      await import('../../runtime/web-agent-session-handoff')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'provisional-tab',
      leafId: 'provisional-leaf',
      launchAgent: 'codex'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(
      resolveWebAgentSessionHandoff({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        provisionalTabId: 'provisional-tab'
      })
    ).toBe('canonical-host-tab')
    expect(refreshSessionTabsSnapshot).toHaveBeenCalledWith('env-1', 'wt-1', {
      acceptCurrentSnapshot: true,
      confirmAgentSessionHandoff: {
        provisionalTabId: 'provisional-tab',
        hostTabId: 'canonical-host-tab',
        hostTerminalHandle: 'terminal-1'
      }
    })
  })

  it('preserves the connect-time legacy payload when host authority is unavailable', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: []
            }
          }
        : { ok: true, result: { terminal: { handle: 'terminal-legacy' } } }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      command: "codex 'old'",
      launchConfig: { agentArgs: '--old', agentEnv: {} },
      launchToken: 'old-token',
      launchAgent: 'codex'
    })

    await transport.connect({
      url: '',
      command: "codex '--model' 'gpt-5' 'resume' 'session-1'",
      env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'fresh-token' },
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchToken: 'fresh-token',
      launchAgent: 'codex',
      callbacks: {}
    })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.create',
      params: {
        worktree: 'id:wt-1',
        clientMutationId: expect.any(String),
        command: "codex '--model' 'gpt-5' 'resume' 'session-1'",
        env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'fresh-token' },
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchToken: 'fresh-token',
        launchAgent: 'codex',
        tabId: 'tab-1',
        leafId: 'pane:1',
        focus: false,
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.createAgentSession' })
    )
  })
})
