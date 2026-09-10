// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { launchSleepingAgentSession } from './sleeping-agent-session-launch'
import { useAiVaultSessionLaunchActions } from '../components/right-sidebar/ai-vault-session-launch-actions'

const fixture = vi.hoisted(() => ({
  order: [] as string[],
  createTab: vi.fn(() => ({ id: 'new-tab' })),
  launch: vi.fn(() => ({ tabId: 'new-tab' })),
  clear: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {},
      tabsByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: {},
      activeWorktreeId: 'target',
      repos: [],
      createTab: fixture.createTab,
      clearSleepingAgentSession: fixture.clear,
      setActiveTabType: vi.fn(),
      setTabBarOrder: vi.fn(),
      getKnownWorktreeById: () => null
    })
  }
}))
vi.mock('./tui-agent-startup', () => ({
  buildAgentResumeStartupPlan: () => ({ launchCommand: 'synthetic-resume', env: { KEEP: 'value' } })
}))
vi.mock('./agent-resume-launch-target', () => ({
  resolveAgentResumeLaunchTarget: () => {
    fixture.order.push('wake-target')
    return { platform: 'linux', shell: '/bin/sh' }
  }
}))
vi.mock('./worktree-runtime-owner', () => ({ getExecutionHostIdForWorktree: () => 'local' }))
vi.mock('./local-preflight-context', () => ({ getLocalProjectExecutionRuntimeContext: () => null }))
vi.mock('./ai-vault-resume-command', () => ({
  buildAiVaultResumeCopyCommandForWorktree: vi.fn(),
  buildAiVaultResumeStartupForWorktree: () => ({
    command: 'synthetic-resume',
    env: { KEEP: 'value' }
  })
}))
vi.mock('./launch-ai-vault-session', () => ({ launchAiVaultSessionInNewTab: fixture.launch }))
vi.mock('./ai-vault-session-resume-preparation', () => ({
  notifyAiVaultSessionPreparationFailure: vi.fn(),
  prepareAiVaultSessionForResume: async (session: unknown) => {
    fixture.order.push('prepare')
    return session
  }
}))
vi.mock('../components/right-sidebar/ai-vault-session-launch-target', () => ({
  aiVaultResumeUnsupportedMessage: vi.fn(),
  resolveAiVaultTargetWorkspacePath: vi.fn(),
  resolveAiVaultSessionLaunchTarget: () => {
    fixture.order.push('vault-target')
    return { worktreeId: 'target' }
  }
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('production resume diagnostic boundaries', () => {
  const observe = vi.fn(async (_args: unknown) => null)
  beforeEach(() => {
    fixture.order.length = 0
    vi.clearAllMocks()
    observe.mockImplementation(async () => {
      fixture.order.push('diagnostic')
      return null
    })
    vi.stubGlobal('api', undefined)
    Object.assign(window, {
      api: { diagnostics: { providerResourceEnabled: true, observeProviderResource: observe } }
    })
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('requests the source before wake target resolution and carries correlation to the queued PTY', () => {
    const record = {
      paneKey: 'source-pane',
      worktreeId: 'target',
      agent: 'claude',
      connectionId: 'source-host',
      providerSession: { key: 'session_id', id: 'session-a', transcriptPath: '/synthetic/a.jsonl' }
    }
    expect(launchSleepingAgentSession(record as never)).toBe(true)
    expect(fixture.order.slice(0, 2)).toEqual(['diagnostic', 'wake-target'])
    expect(observe).toHaveBeenCalledTimes(1)
    const request = observe.mock.calls[0]![0] as unknown as {
      executionHostId: string
      query: { requestId: string }
    }
    expect(request.executionHostId).toBe('ssh:source-host')
    expect(fixture.createTab).toHaveBeenCalledWith(
      'target',
      undefined,
      undefined,
      expect.objectContaining({
        pendingStartup: expect.objectContaining({
          env: {
            KEEP: 'value',
            ORCA_PROVIDER_RESOURCE_DIAGNOSTIC_REQUEST_ID: request.query.requestId
          }
        })
      })
    )
    expect(fixture.clear).toHaveBeenCalledWith('source-pane')
  })

  it('requests the selected AI Vault source before destination and preparation, without gating launch', async () => {
    const { result } = renderHook(() =>
      useAiVaultSessionLaunchActions({
        activeWorktree: null,
        activeWorktreeId: 'target',
        targetState: {} as never
      })
    )
    await act(async () =>
      result.current.handleResume({
        agent: 'claude',
        sessionId: 'session-a',
        filePath: '/synthetic/a.jsonl',
        executionHostId: 'ssh:source-host'
      } as never)
    )
    expect(fixture.order.slice(0, 3)).toEqual(['diagnostic', 'vault-target', 'prepare'])
    expect(observe).toHaveBeenCalledTimes(1)
    const request = observe.mock.calls[0]![0] as unknown as { query: { requestId: string } }
    expect(fixture.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'target',
        env: {
          KEEP: 'value',
          ORCA_PROVIDER_RESOURCE_DIAGNOSTIC_REQUEST_ID: request.query.requestId
        }
      })
    )
  })

  it('preserves the legacy action against an old bridge without diagnostic capability', () => {
    Object.assign(window, { api: { diagnostics: {} } })
    expect(
      launchSleepingAgentSession({
        paneKey: 'p',
        worktreeId: 'target',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'session-a' }
      } as never)
    ).toBe(true)
    expect(observe).not.toHaveBeenCalled()
    expect(fixture.createTab).toHaveBeenCalledWith(
      'target',
      undefined,
      undefined,
      expect.objectContaining({
        pendingStartup: expect.objectContaining({ env: { KEEP: 'value' } })
      })
    )
  })
})
