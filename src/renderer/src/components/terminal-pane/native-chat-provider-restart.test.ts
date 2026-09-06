import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneController } from './use-terminal-pane-controller'
const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  rpc: vi.fn(),
  platform: vi.fn(),
  driver: vi.fn(),
  seed: vi.fn(),
  startup: vi.fn(),
  state: {
    settings: {},
    pendingPtyShutdownIds: {} as Record<string, number>,
    suppressedPtyExitIds: {},
    ptyIdsByTabId: {},
    isPtyShutdownPending: (ptyId: string): boolean =>
      (mocks.state.pendingPtyShutdownIds[ptyId] ?? 0) > 0,
    agentStatusByPaneKey: {},
    suppressPtyExit: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(),
    clearTabPtyId: vi.fn((_tabId: string, ptyId: string) => {
      if (mocks.state.isPtyShutdownPending(ptyId)) {
        throw new Error('Cannot clear a terminal binding while shutdown verification is pending')
      }
    }),
    clearNativeChatLaunchDraft: vi.fn(),
    clearNativeChatLaunchPrompt: vi.fn(),
    dropAgentStatus: vi.fn(),
    clearSleepingAgentSession: vi.fn()
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    setState: (update: (state: typeof mocks.state) => object) =>
      Object.assign(mocks.state, update(mocks.state))
  }
}))
vi.mock('@/lib/tui-agent-startup', () => ({ buildAgentStartupPlan: mocks.startup }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  detectAgentSessionContinuationAgents: mocks.detect
}))
vi.mock('@/lib/agent-paste-draft', () => ({ getSettingsForAgentTabRuntimeOwner: () => ({}) }))
vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({ getDriverForPty: mocks.driver }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('./terminal-input-host-platform', () => ({
  resolveTerminalInputHostPlatform: mocks.platform
}))
vi.mock('../native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: mocks.seed
}))
import { restartNativeChatProvider } from './native-chat-provider-restart'

const leafId = 'e70e9e56-1645-43ad-9718-a55b44f923d5'
function fixture(ptyId = 'pty-old') {
  let currentPtyId = ptyId
  const transport = {
    isConnected: () => true,
    getPtyId: () => currentPtyId,
    getConnectionId: () => null,
    getRuntimeEnvironmentId: () => (ptyId.startsWith('remote:') ? 'host-a' : null),
    detach: vi.fn()
  }
  const restart = vi.fn(async () => {
    currentPtyId = 'replacement-pty'
  })
  const controller = {
    chatPane: { id: 1, leafId },
    chatPanePtyId: ptyId,
    tabId: 'tab',
    worktreeId: 'folder:workspace',
    paneTransportsRef: { current: new Map([[1, transport]]) },
    panePtyBindingsRef: { current: new Map([[1, { dispose: vi.fn() }]]) },
    paneCwdRef: { current: new Map([[1, { cwd: '/workspace/nested', confirmed: true }]]) },
    cwd: '/workspace',
    handleRestartChatPane: restart
  } as unknown as TerminalPaneController
  return { controller, transport, restart }
}
describe('same-pane native chat provider restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.detect.mockResolvedValue(['claude', 'codex', 'grok'])
    mocks.driver.mockReturnValue(null)
    mocks.platform.mockReturnValue('darwin')
    mocks.state.agentStatusByPaneKey = {}
    mocks.state.pendingPtyShutdownIds = {}
    mocks.state.suppressedPtyExitIds = {}
    mocks.startup.mockReturnValue({
      launchCommand: 'codex -m selected',
      launchConfig: {},
      sessionOptions: { model: 'selected' }
    })
    mocks.rpc.mockResolvedValue({ stoppedPtyIds: ['pty-old'], postStopVerified: true })
  })
  it('waits for an exact host stop and restarts the same pane in its subdirectory', async () => {
    const { controller, restart, transport } = fixture()
    let resolve!: (result: unknown) => void
    mocks.rpc.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const switching = restartNativeChatProvider(controller, 'codex', 'selected')
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalled())
    expect(restart).not.toHaveBeenCalled()
    expect(mocks.state.isPtyShutdownPending('pty-old')).toBe(true)
    expect(transport.detach).not.toHaveBeenCalled()
    expect(mocks.state.clearSleepingAgentSession).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'terminal.stopExact', {
      worktree: 'id:folder:workspace',
      expectedPtyIds: ['pty-old'],
      keepHistory: true,
      targetOnly: true
    })
    resolve({ stoppedPtyIds: ['pty-old'], postStopVerified: true })
    await switching
    expect(mocks.state.isPtyShutdownPending('pty-old')).toBe(false)
    expect(mocks.state.clearSleepingAgentSession).toHaveBeenCalledWith(`tab:${leafId}`)
    expect(restart).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ launchAgent: 'codex', sessionOptions: { model: 'selected' } }),
      '/workspace/nested'
    )
  })
  it('does not finish switching before the replacement PTY is bound', async () => {
    const { controller, restart } = fixture()
    let bind!: () => void
    restart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          bind = () => {
            controller.paneTransportsRef.current.set(1, {
              ...controller.paneTransportsRef.current.get(1)!,
              getPtyId: () => 'replacement-pty'
            })
            resolve()
          }
        })
    )
    let settled = false
    const switching = restartNativeChatProvider(controller, 'codex', 'selected').then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(restart).toHaveBeenCalled())
    expect(settled).toBe(false)
    bind()
    await switching
    expect(settled).toBe(true)
  })
  it('accepts an acknowledged replacement that reuses the terminal ID and replaces its model cache', async () => {
    const { controller, restart } = fixture()
    restart.mockImplementation(async () => {})
    await expect(restartNativeChatProvider(controller, 'codex', 'selected')).resolves.toBe(
      'pty-old'
    )
    expect(mocks.seed).toHaveBeenCalledWith('pty-old', 'codex', { model: 'selected' })
  })
  it.each([
    { stoppedPtyIds: ['pty-old'], postStopVerified: false },
    { stoppedPtyIds: ['another-pty'], postStopVerified: true }
  ])('does not replace a provider without verified matching exit evidence', async (result) => {
    const { controller, restart, transport } = fixture()
    mocks.rpc.mockResolvedValue(result)
    await expect(restartNativeChatProvider(controller, 'codex', 'selected')).rejects.toThrow(
      'could not confirm'
    )
    expect(restart).not.toHaveBeenCalled()
    expect(mocks.state.isPtyShutdownPending('pty-old')).toBe(false)
    expect(transport.detach).not.toHaveBeenCalled()
  })
  it('uses the execution host platform when preparing the replacement command', async () => {
    const { controller } = fixture()
    mocks.platform.mockReturnValue('win32')
    await restartNativeChatProvider(controller, 'codex', 'selected')
    expect(mocks.platform).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'folder:workspace' })
    )
    expect(mocks.startup).toHaveBeenCalledWith(expect.objectContaining({ platform: 'win32' }))
  })
  it('rechecks new working status after remote host identity resolution', async () => {
    const { controller, restart } = fixture('remote:host-a:term-a')
    mocks.rpc.mockImplementation(async (_target, method) => {
      if (method === 'terminal.show') {
        mocks.state.agentStatusByPaneKey = { [`tab:${leafId}`]: { state: 'working' } }
        return { ptyId: 'host-pty' }
      }
      return { stoppedPtyIds: ['host-pty'], postStopVerified: true }
    })
    await expect(restartNativeChatProvider(controller, 'codex', 'selected')).rejects.toThrow(
      'current response'
    )
    expect(restart).not.toHaveBeenCalled()
    expect(mocks.rpc.mock.calls.some((call) => call[1] === 'terminal.stopExact')).toBe(false)
  })
})
