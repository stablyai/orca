import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import type { Repo } from '../../../shared/repo-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  ensureDetectedAgentsForWorktree,
  readDetectedAgentsForWorktree
} from './agent-detection-target-inventory'

function storeWithRepo(repo: Partial<Repo>) {
  const store = createTestStore()
  const ensureDetectedAgents = vi.fn(async (): Promise<TuiAgent[]> => ['codex'])
  const ensureRemoteDetectedAgents = vi.fn(async (): Promise<TuiAgent[]> => ['gemini'])
  const ensureRuntimeDetectedAgents = vi.fn(async (): Promise<TuiAgent[]> => ['claude'])
  store.setState({
    repos: [{ ...TEST_REPO, ...repo }],
    worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })] },
    ensureDetectedAgents,
    ensureRemoteDetectedAgents,
    ensureRuntimeDetectedAgents
  })
  return { store, ensureDetectedAgents, ensureRemoteDetectedAgents, ensureRuntimeDetectedAgents }
}

// Why (#21429, #25804): a paired server's workspace, including one on that server's own SSH
// target, lists the agents the server finds there; never this client's or its SSH map's.
describe('agent inventory for a worktree', () => {
  it("reads and loads a paired server's SSH workspace from that server", async () => {
    const harness = storeWithRepo({
      connectionId: 'server-ssh-target',
      executionHostId: 'runtime:env-1'
    })
    harness.store.setState({
      detectedAgentIds: ['codex'],
      remoteDetectedAgentIds: { 'server-ssh-target': ['gemini'] },
      runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('env-1', 'wt-1')]: ['claude'] }
    })
    const state = harness.store.getState()

    expect(readDetectedAgentsForWorktree(state, 'wt-1')).toEqual(['claude'])
    await expect(ensureDetectedAgentsForWorktree(state, 'wt-1')).resolves.toEqual(['claude'])
    expect(harness.ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1', 'wt-1')
    expect(harness.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
    expect(harness.ensureDetectedAgents).not.toHaveBeenCalled()
  })

  it('loads a local workspace in its own project runtime', async () => {
    const harness = storeWithRepo({})

    await expect(
      ensureDetectedAgentsForWorktree(harness.store.getState(), 'wt-1')
    ).resolves.toEqual(['codex'])
    expect(harness.ensureDetectedAgents).toHaveBeenCalledWith('wt-1')
  })

  it("loads a direct SSH workspace from this client's connection", async () => {
    const harness = storeWithRepo({ connectionId: 'ssh-1' })

    await expect(
      ensureDetectedAgentsForWorktree(harness.store.getState(), 'wt-1')
    ).resolves.toEqual(['gemini'])
    expect(harness.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
  })

  it('probes nothing while the workspace owner is unknown', async () => {
    const harness = storeWithRepo({})
    harness.store.setState({ repos: [], worktreesByRepo: {} })
    const state = harness.store.getState()

    expect(readDetectedAgentsForWorktree(state, 'repo-missing::wt')).toBeNull()
    await expect(ensureDetectedAgentsForWorktree(state, 'repo-missing::wt')).resolves.toEqual([])
    expect(harness.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(harness.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
    expect(harness.ensureRuntimeDetectedAgents).not.toHaveBeenCalled()
  })
})
