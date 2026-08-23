import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  nativeChatRouteForAgent,
  nativeChatRouteForTerminal,
  setTerminalNativeChatMode
} from './structured-native-chat-toggle'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'win32'
}))

function terminalState(input: {
  agent?: 'codex' | 'claude'
  structuredSessionId?: string
  connectionId?: string | null
  executionHostId?: `runtime:${string}`
  windowsRuntime?: 'windows-host' | 'wsl'
}) {
  const agent = input.agent ?? 'codex'
  const tab = {
    id: `tab-${agent}`,
    entityId: `terminal-${agent}`,
    worktreeId: 'workspace-1',
    contentType: 'terminal' as const,
    ...(input.structuredSessionId ? { structuredSessionId: input.structuredSessionId } : {})
  }
  const paneKey = `${tab.entityId}:leaf-1`
  return {
    tab,
    state: {
      activeRepoId: 'repo-1',
      activeWorktreeId: 'workspace-1',
      projects: [
        {
          id: 'repo-1',
          localWindowsRuntimePreference:
            input.windowsRuntime === 'wsl'
              ? { kind: 'wsl', distro: 'Ubuntu' }
              : { kind: 'windows-host' }
        }
      ],
      repos: [{ id: 'repo-1', connectionId: input.connectionId ?? null, path: 'C:\\repo' }],
      settings: {},
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'workspace-1',
            repoId: 'repo-1',
            projectId: 'repo-1',
            path: 'C:\\repo\\worktree',
            ...(input.executionHostId ? { hostId: input.executionHostId } : {})
          }
        ]
      },
      detectedWorktreesByRepo: {},
      unifiedTabsByWorktree: { 'workspace-1': [tab] },
      tabsByWorktree: {
        'workspace-1': [{ id: tab.entityId, launchAgent: agent }]
      },
      terminalLayoutsByTabId: {
        [tab.entityId]: {
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': `pty-${agent}` }
        }
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          agentType: agent,
          providerSession: { id: `thread-${agent}` }
        }
      }
    }
  }
}

beforeEach(() => {
  vi.mocked(callStructuredAgentSession).mockReset()
  mockToastError.mockReset()
})

describe('native chat routing', () => {
  it.each([
    ['codex', 'structured'],
    ['claude', 'bridge'],
    ['openclaude', 'bridge'],
    ['grok', 'bridge'],
    ['omp', 'bridge']
  ] as const)('routes %s to %s', (agent, route) => {
    expect(nativeChatRouteForAgent(agent)).toBe(route)
  })

  it('keeps an adopted terminal structured after live Codex evidence disappears', () => {
    expect(
      nativeChatRouteForTerminal({
        agent: null,
        structuredSessionId: 'codex_thread-1',
        mode: 'terminal'
      })
    ).toBe('structured')
  })

  it('lets a pre-migration Codex bridge return to the terminal before adoption', () => {
    expect(nativeChatRouteForTerminal({ agent: 'codex', mode: 'terminal' })).toBe('bridge')
  })

  it.each([
    ['SSH', { connectionId: 'ssh-1' }],
    ['paired runtime', { executionHostId: 'runtime:paired-1' as const }],
    ['WSL', { windowsRuntime: 'wsl' as const }]
  ])('keeps %s Codex panes on the transcript bridge', async (_label, overrides) => {
    const { tab, state } = terminalState(overrides)
    const patch = vi.fn()

    await expect(
      setTerminalNativeChatMode({
        getState: () => state as never,
        patch,
        tabId: tab.id,
        mode: 'chat'
      })
    ).resolves.toBe('bridge')

    expect(callStructuredAgentSession).not.toHaveBeenCalled()
    expect(patch).toHaveBeenCalledWith(tab.id, { viewMode: 'chat' })
  })

  it('retries a failed initial handoff with its original operation id', async () => {
    const { tab, state } = terminalState({})
    const patch = vi.fn((tabId: string, next: Record<string, unknown>) => {
      if (tabId === tab.id) {
        Object.assign(tab, next)
      }
    })
    let originalOperationId = ''
    let startSent = false
    let retrySent = false
    vi.mocked(callStructuredAgentSession).mockImplementation(
      async (_target, method, params: unknown) => {
        const request = params as {
          action?: string
          envelope?: { clientOperationId?: string }
        }
        if (method === 'agentSession.adoptTerminal') {
          return { ok: true, fence: 1 } as never
        }
        if (method === 'agentSession.history') {
          return { ok: true, page: { fence: 2 } } as never
        }
        if (method === 'agentSession.handoff') {
          if (request.action === 'start') {
            originalOperationId = request.envelope?.clientOperationId ?? ''
            startSent = true
          } else {
            expect(request).toMatchObject({
              action: 'retry',
              envelope: { clientOperationId: originalOperationId }
            })
            retrySent = true
          }
          return { ok: true } as never
        }
        if (method === 'agentSession.handoffStatus') {
          return (
            retrySent
              ? { owner: 'native', direction: null, phase: 'idle' }
              : !startSent
                ? { owner: 'tui', direction: null, phase: 'idle' }
                : {
                    owner: 'tui',
                    direction: 'to-native',
                    phase: 'failed',
                    operationId: originalOperationId,
                    error: { message: 'native proof unavailable', recoverableOwner: 'tui' }
                  }
          ) as never
        }
        throw new Error(`Unexpected method: ${method}`)
      }
    )

    await expect(
      setTerminalNativeChatMode({
        getState: () => state as never,
        patch,
        tabId: tab.id,
        mode: 'chat'
      })
    ).resolves.toBe('ignored')
    await expect(
      setTerminalNativeChatMode({
        getState: () => state as never,
        patch,
        tabId: tab.id,
        mode: 'chat'
      })
    ).resolves.toBe('structured')

    expect(originalOperationId).not.toBe('')
    expect(tab).toMatchObject({ structuredSessionId: 'codex_thread-codex' })
    expect(patch).toHaveBeenLastCalledWith(tab.id, {
      structuredSessionId: 'codex_thread-codex',
      viewMode: 'chat'
    })
  })

  it('clears a stale Codex binding before routing another agent to the bridge', async () => {
    const { tab, state } = terminalState({
      agent: 'claude',
      structuredSessionId: 'codex_old-thread'
    })
    const patch = vi.fn()

    await expect(
      setTerminalNativeChatMode({
        getState: () => state as never,
        patch,
        tabId: tab.id,
        mode: 'chat'
      })
    ).resolves.toBe('bridge')

    expect(callStructuredAgentSession).not.toHaveBeenCalled()
    expect(patch).toHaveBeenCalledTimes(1)
    const [patchedTabId, bridgePatch] = patch.mock.calls[0] as [string, Record<string, unknown>]
    expect(patchedTabId).toBe(tab.id)
    expect(bridgePatch.viewMode).toBe('chat')
    // Deep equality treats an absent key as undefined, so presence is the only proof it was cleared.
    expect(Object.keys(bridgePatch)).toContain('structuredSessionId')
    expect(bridgePatch.structuredSessionId).toBeUndefined()
  })

  it('keeps a Codex binding when the same agent falls back to the bridge', async () => {
    const { tab, state } = terminalState({
      agent: 'codex',
      structuredSessionId: 'codex_thread-codex',
      connectionId: 'ssh-1'
    })
    const patch = vi.fn()

    await expect(
      setTerminalNativeChatMode({
        getState: () => state as never,
        patch,
        tabId: tab.id,
        mode: 'chat'
      })
    ).resolves.toBe('bridge')

    expect(callStructuredAgentSession).not.toHaveBeenCalled()
    expect(patch).toHaveBeenCalledTimes(1)
    const [, codexBridgePatch] = patch.mock.calls[0] as [string, Record<string, unknown>]
    expect(Object.keys(codexBridgePatch)).not.toContain('structuredSessionId')
  })

  it('names the terminal direction when returning ownership fails', async () => {
    const { tab, state } = terminalState({ structuredSessionId: 'codex_thread-codex' })
    vi.mocked(callStructuredAgentSession).mockRejectedValueOnce(new Error('history unavailable'))

    await expect(
      setTerminalNativeChatMode({
        getState: () => state as never,
        patch: vi.fn(),
        tabId: tab.id,
        mode: 'terminal'
      })
    ).resolves.toBe('ignored')

    expect(mockToastError).toHaveBeenCalledWith(
      'Could not return this Codex session to the terminal',
      { description: 'history unavailable' }
    )
  })

  it('adopts from trusted foreground Codex evidence before hooks publish a thread', async () => {
    const tab = {
      id: 'tab-foreground',
      entityId: 'terminal-foreground',
      worktreeId: 'workspace-1',
      contentType: 'terminal' as const
    }
    const paneKey = 'terminal-foreground:leaf-1'
    const state = {
      unifiedTabsByWorktree: { 'workspace-1': [tab] },
      tabsByWorktree: { 'workspace-1': [{ id: 'terminal-foreground' }] },
      terminalLayoutsByTabId: {
        'terminal-foreground': {
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-foreground' }
        }
      },
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'codex', shellForeground: false, routingTrusted: true }
      }
    }
    vi.mocked(callStructuredAgentSession)
      .mockResolvedValueOnce({ ok: true, fence: 1 })
      .mockRejectedValueOnce(new Error('handoff failed'))
    const patch = vi.fn()

    await expect(
      setTerminalNativeChatMode({
        getState: () => state as never,
        patch,
        tabId: tab.id,
        mode: 'chat'
      })
    ).resolves.toBe('ignored')
    expect(vi.mocked(callStructuredAgentSession).mock.calls[0]?.[2]).not.toHaveProperty('threadId')
    expect(patch).toHaveBeenCalledWith(
      tab.id,
      expect.objectContaining({ structuredSessionId: expect.stringMatching(/^codex_adopt-/) })
    )
  })
})
