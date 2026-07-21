import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem, Repo } from '../../../shared/types'
import type { GitHubWorkItemBackgroundStoreSnapshot } from './github-work-item-background-request'
import {
  buildGitHubWorkItemStartupPlan,
  resolvePreferredQuickAgentForGitHubWorkItem
} from './github-work-item-background-request'

const mocks = vi.hoisted(() => ({
  buildAgentStartupPlan: vi.fn(() => ({
    agent: 'codex' as const,
    launchCommand: 'codex',
    expectedProcess: 'codex',
    followupPrompt: null,
    launchConfig: { kind: 'shell' as const, command: 'codex' }
  }))
}))

vi.mock('@/lib/tui-agent-startup', () => ({
  buildAgentDraftLaunchPlan: vi.fn(() => null),
  buildAgentStartupPlan: mocks.buildAgentStartupPlan
}))

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: 'blue',
  addedAt: 1
}

function makeStore(overrides: Partial<GitHubWorkItemBackgroundStoreSnapshot> = {}) {
  return {
    settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
    ensureDetectedAgents: vi.fn().mockResolvedValue(['codex', 'claude']),
    ensureRemoteDetectedAgents: vi.fn().mockResolvedValue([]),
    ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue([]),
    ...overrides
  } as unknown as GitHubWorkItemBackgroundStoreSnapshot
}

describe('resolvePreferredQuickAgentForGitHubWorkItem', () => {
  it('uses repo-scoped local detection and rejects a newly disabled explicit agent', async () => {
    const initial = makeStore()
    const current = makeStore({
      settings: { defaultTuiAgent: 'codex', disabledTuiAgents: ['claude'] }
    })
    const getStore = vi.fn().mockReturnValueOnce(initial).mockReturnValue(current)

    await expect(
      resolvePreferredQuickAgentForGitHubWorkItem(getStore, repo, 'claude')
    ).resolves.toBe(null)
    expect(initial.ensureDetectedAgents).toHaveBeenCalledWith({ repoId: 'repo-1' })
  })

  it('uses canonical SSH ownership for detection and startup construction', async () => {
    const sshRepo: Repo = { ...repo, executionHostId: 'ssh:devbox' }
    const store = makeStore({
      repos: [sshRepo],
      runtimeStatusByEnvironmentId: new Map(),
      ensureRemoteDetectedAgents: vi.fn().mockResolvedValue(['codex'])
    })
    const item = {
      id: 'issue-42',
      repoId: repo.id,
      type: 'issue',
      number: 42,
      title: 'Fix agent launch',
      labels: [],
      assignees: []
    } as unknown as GitHubWorkItem

    await expect(resolvePreferredQuickAgentForGitHubWorkItem(() => store, sshRepo)).resolves.toBe(
      'codex'
    )
    buildGitHubWorkItemStartupPlan({ agent: 'codex', item, repo: sshRepo, store })

    expect(store.ensureRemoteDetectedAgents).toHaveBeenCalledWith('devbox')
    expect(mocks.buildAgentStartupPlan).toHaveBeenCalledWith(
      expect.objectContaining({ isRemote: true, platform: 'linux' })
    )
  })
})
