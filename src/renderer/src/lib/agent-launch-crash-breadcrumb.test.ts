import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetKnownWorktreeById = vi.fn()
const mockRecordRendererCrashBreadcrumb = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      getKnownWorktreeById: mockGetKnownWorktreeById,
      activeTabType: 'terminal',
      tabsByWorktree: {
        'wt-wsl': [{ id: 'tab-1' }, { id: 'tab-2' }]
      },
      agentStatusByPaneKey: {
        'tab-1:1': { agentType: 'opencode' },
        'tab-other:1': { agentType: 'codex' }
      }
    })
  }
}))

vi.mock('./crash-diagnostics', () => ({
  recordRendererCrashBreadcrumb: mockRecordRendererCrashBreadcrumb
}))

describe('recordAgentLaunchCrashBreadcrumb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records WSL OpenCode launches without raw worktree path text', async () => {
    mockGetKnownWorktreeById.mockReturnValue({
      path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
    })
    const { recordAgentLaunchCrashBreadcrumb } = await import('./agent-launch-crash-breadcrumb')

    recordAgentLaunchCrashBreadcrumb({
      agent: 'opencode',
      worktreeId: 'wt-wsl',
      launchPlatform: 'linux',
      launchSource: 'tab_bar_quick_launch',
      requestKind: 'new',
      hasPrompt: false,
      promptDelivery: 'auto-submit'
    })

    expect(mockRecordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'agent_launch_queued',
      expect.objectContaining({
        agent: 'opencode',
        activeRuntime: 'wsl',
        wslDistroPresent: true,
        worktreePathKind: 'wsl-unc',
        activeTabType: 'terminal',
        terminalCount: 2,
        activeAgentCount: 1,
        activeAgentTypes: 'opencode',
        launchPlatform: 'linux',
        launchSource: 'tab_bar_quick_launch',
        requestKind: 'new',
        hasPrompt: false,
        promptDelivery: 'auto-submit'
      })
    )
    const payloadText = JSON.stringify(mockRecordRendererCrashBreadcrumb.mock.calls[0]?.[1])
    expect(payloadText).not.toContain('Ubuntu')
    expect(payloadText).not.toContain('home')
    expect(payloadText).not.toContain('repo')
  })
})
