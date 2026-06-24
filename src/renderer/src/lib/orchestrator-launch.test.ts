import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../shared/types'

// A mutable harness the mocked modules read, reset per test.
const harness = vi.hoisted(() => ({
  registerOrchestrator: vi.fn(),
  settings: { defaultTuiAgent: 'claude' } as { defaultTuiAgent?: string },
  activate: vi.fn(),
  pasteDraft: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(harness), {
    getState: () => ({
      registerOrchestrator: harness.registerOrchestrator,
      settings: harness.settings
    })
  })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: (...args: unknown[]) => harness.activate(...args)
}))

vi.mock('@/lib/director-worktree-shell', () => ({
  createDirectorWorktreeShell: vi.fn(async () => ({ worktreeId: 'wt_director', setup: undefined }))
}))

vi.mock('@/lib/tui-agent-startup', () => ({
  buildAgentStartupPlan: () => ({
    launchCommand: 'claude',
    env: undefined,
    launchConfig: undefined
  })
}))

vi.mock('../../../shared/tui-agent-launch-defaults', () => ({
  resolveTuiAgentLaunchArgs: () => undefined,
  resolveTuiAgentLaunchEnv: () => undefined
}))

vi.mock('@/lib/launch-work-item-direct-agent', () => ({
  buildDirectWorkItemStartupOpts: () => ({ startup: { command: 'claude' } })
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: (...args: unknown[]) => harness.pasteDraft(...args)
}))

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => harness.toastError(...args) }
}))

import { launchOrchestratorForProject } from './orchestrator-launch'

const PROJECT: Project = {
  id: 'proj_1',
  displayName: 'Demo',
  sourceRepoIds: ['repo_1']
} as unknown as Project

beforeEach(() => {
  vi.clearAllMocks()
  harness.settings = { defaultTuiAgent: 'claude' }
  harness.activate.mockReturnValue({ primaryTabId: 'tab_1' })
})

describe('launchOrchestratorForProject', () => {
  it('reveals the director worktree but suppresses the active-tab switch', async () => {
    const ok = await launchOrchestratorForProject(PROJECT)
    expect(ok).toBe(true)

    expect(harness.activate).toHaveBeenCalledTimes(1)
    const [worktreeId, opts] = harness.activate.mock.calls[0]
    expect(worktreeId).toBe('wt_director')
    // The programmatic launch must NOT yank the user's active tab.
    expect(opts.suppressActivation).toBe(true)
    // ...while still revealing it in the sidebar tree + Mission Control DAG.
    expect(opts.sidebarRevealBehavior).toBe('auto')
  })
})
