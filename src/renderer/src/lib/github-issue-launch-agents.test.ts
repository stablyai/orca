import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/types'
import { loadGitHubIssueLaunchAgents } from './github-issue-launch-agents'

const localRepo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: 'blue',
  addedAt: 1
}

function makeStore() {
  return {
    settings: { disabledTuiAgents: ['codex'] },
    ensureDetectedAgents: vi.fn().mockResolvedValue(['codex', 'claude', 'opencode']),
    ensureRemoteDetectedAgents: vi.fn().mockResolvedValue(['claude']),
    ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue(['opencode'])
  }
}

describe('loadGitHubIssueLaunchAgents', () => {
  it('returns only detected agents that are enabled for a local repo', async () => {
    const store = makeStore()

    const agents = await loadGitHubIssueLaunchAgents(localRepo, store)

    expect(agents.map((agent) => agent.id)).toEqual(['claude', 'opencode'])
    expect(store.ensureDetectedAgents).toHaveBeenCalledWith({ repoId: 'repo-1' })
    expect(store.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
    expect(store.ensureRuntimeDetectedAgents).not.toHaveBeenCalled()
  })

  it('detects agents on the owning SSH host', async () => {
    const store = makeStore()
    const repo: Repo = { ...localRepo, executionHostId: 'ssh:devbox' }

    const agents = await loadGitHubIssueLaunchAgents(repo, store)

    expect(agents.map((agent) => agent.id)).toEqual(['claude'])
    expect(store.ensureRemoteDetectedAgents).toHaveBeenCalledWith('devbox')
    expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
  })

  it('detects agents on the owning runtime environment', async () => {
    const store = makeStore()
    const repo: Repo = { ...localRepo, executionHostId: 'runtime:env-1' }

    const agents = await loadGitHubIssueLaunchAgents(repo, store)

    expect(agents.map((agent) => agent.id)).toEqual(['opencode'])
    expect(store.ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1')
    expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
  })

  it('returns no agents when the issue repository is unavailable', async () => {
    const store = makeStore()

    await expect(loadGitHubIssueLaunchAgents(null, store)).resolves.toEqual([])
    expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
  })
})
