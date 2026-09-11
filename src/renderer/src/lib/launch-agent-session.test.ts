import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  planAgentSessionLaunch: vi.fn(),
  launchTerminalSession: vi.fn(),
  activateAndRevealWorkspace: vi.fn(),
  activateStructuredAgentSessionById: vi.fn(),
  closeStructuredAgentSession: vi.fn(),
  callRuntimeRpc: vi.fn(),
  state: { unifiedTabsByWorktree: {} } as Record<string, unknown>
}))

vi.mock('@/lib/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: mocks.planAgentSessionLaunch
}))
vi.mock('@/lib/launch-agent-session-terminal', () => ({
  launchTerminalSession: mocks.launchTerminalSession
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById
}))
vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (workspaceId: string) => ({ id: workspaceId })
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))

import { launchAgentSession } from './launch-agent-session'

const request = {
  agent: 'codex' as const,
  workspaceId: 'worktree-1',
  prompt: 'Fix it',
  visibility: 'reveal' as const,
  launchSource: 'task_page' as const
}

describe('launchAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = { unifiedTabsByWorktree: {} }
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
    mocks.closeStructuredAgentSession.mockResolvedValue(undefined)
    mocks.callRuntimeRpc.mockResolvedValue(undefined)
  })

  it('launches terminal routes through the shared terminal operation', async () => {
    mocks.planAgentSessionLaunch.mockReturnValue({ route: 'terminal-tui' })
    mocks.launchTerminalSession.mockResolvedValue({ tabId: 'terminal-1' })

    await expect(launchAgentSession({} as never, request)).resolves.toEqual({
      kind: 'terminal',
      tabId: 'terminal-1',
      viaRefusal: false
    })
    expect(mocks.launchTerminalSession).toHaveBeenCalledWith(request)
  })

  it('activates a folder workspace before selecting its structured chat', async () => {
    const order: string[] = []
    mocks.activateAndRevealWorkspace.mockImplementation(() => {
      order.push('workspace')
      return { primaryTabId: null }
    })
    mocks.activateStructuredAgentSessionById.mockImplementation(() => order.push('chat'))
    mocks.planAgentSessionLaunch.mockReturnValue({
      route: 'structured-native-chat',
      launch: vi.fn(async (hooks) => {
        hooks.onStructuredReady('session-1')
        return { kind: 'structured', sessionId: 'session-1' }
      })
    })

    await expect(
      launchAgentSession({} as never, { ...request, workspaceId: 'folder:folder-1' })
    ).resolves.toEqual({
      kind: 'structured',
      sessionId: 'session-1',
      tabId: 'agent-session:session-1'
    })
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('folder:folder-1', {
      providesInitialSurface: true
    })
    expect(order).toEqual(['workspace', 'chat'])
  })

  it('maps a definitive refusal to the terminal fallback outcome', async () => {
    mocks.launchTerminalSession.mockResolvedValue({ tabId: 'fallback-1' })
    mocks.planAgentSessionLaunch.mockReturnValue({
      route: 'structured-native-chat',
      launch: vi.fn(async (hooks) => ({
        kind: 'refused-then-legacy',
        ...(await hooks.legacyFallback())
      }))
    })

    await expect(launchAgentSession({} as never, request)).resolves.toEqual({
      kind: 'terminal',
      tabId: 'fallback-1',
      viaRefusal: true
    })
  })

  it('suppresses generic failure ownership when terminal fallback is disabled', async () => {
    const launch = vi.fn().mockResolvedValue({ kind: 'failed', error: new Error('refused') })
    mocks.planAgentSessionLaunch.mockReturnValue({ route: 'structured-native-chat', launch })

    await launchAgentSession({} as never, { ...request, terminalFallback: false })

    expect(mocks.planAgentSessionLaunch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notifyFailure: false })
    )
    expect(launch.mock.calls[0]?.[0]).not.toHaveProperty('legacyFallback')
    expect(mocks.launchTerminalSession).not.toHaveBeenCalled()
  })

  it('retires a cancelled structured session and drops its session id from the outcome', async () => {
    mocks.planAgentSessionLaunch.mockReturnValue({
      route: 'structured-native-chat',
      launch: vi.fn().mockResolvedValue({ kind: 'cancelled', sessionId: 'session-1' })
    })

    const outcome = await launchAgentSession({} as never, request)

    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(outcome).not.toHaveProperty('sessionId')
    expect(mocks.closeStructuredAgentSession).toHaveBeenCalledWith({ kind: 'local' }, 'session-1')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'session.tabs.close',
      expect.objectContaining({ tabId: 'agent-session:session-1' })
    )
  })

  it('keeps background structured launches from activating a workspace', async () => {
    mocks.planAgentSessionLaunch.mockReturnValue({
      route: 'structured-native-chat',
      launch: vi.fn().mockResolvedValue({ kind: 'structured', sessionId: 'session-1' })
    })

    await launchAgentSession({} as never, { ...request, visibility: 'background' })

    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
  })
})
