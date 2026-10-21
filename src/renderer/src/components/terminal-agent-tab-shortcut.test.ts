import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'

const store: { current: ReturnType<typeof createTestStore> | null } = vi.hoisted(() => ({
  current: null
}))

vi.mock('../store', () => ({
  useAppStore: { getState: () => store.current!.getState() }
}))

import { resolveTerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'

// Why (#25804): the paired server's SSH workspace lists its agents under the server, not under
// the server's SSH connection id, which this client has no connection for.
describe('resolveTerminalAgentTabShortcut', () => {
  it("picks the default agent from a paired server's SSH workspace inventory", () => {
    store.current = createTestStore()
    store.current.setState({
      repos: [
        { ...TEST_REPO, connectionId: 'server-ssh-target', executionHostId: 'runtime:env-1' }
      ],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })] },
      runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('env-1', 'wt-1')]: ['claude'] }
    })

    const shortcut = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt-1',
      keybindings: {},
      matchShortcut: (actionId) => actionId === 'tab.newAgent'
    })

    expect(shortcut).toEqual({ actionId: 'tab.newAgent', agent: 'claude' })
  })

  // Why (#29599): before the tab bar's probe lands, the shortcut must ask the paired server.
  it("waits for a paired server's agent list instead of reporting no agent", async () => {
    store.current = createTestStore()
    const ensureRuntimeDetectedAgents = vi.fn(async () => ['claude' as const])
    const ensureDetectedAgents = vi.fn(async () => [])
    store.current.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:env-1' }],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })] },
      settings: { ...store.current.getState().settings!, defaultTuiAgent: 'claude' },
      ensureRuntimeDetectedAgents,
      ensureDetectedAgents
    })

    const shortcut = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt-1',
      keybindings: {},
      matchShortcut: (actionId) => actionId === 'tab.newAgent'
    })

    expect(shortcut.actionId).toBe('tab.newAgent')
    await expect(shortcut.pendingAgent).resolves.toBe('claude')
    expect(ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1', 'wt-1')
    expect(ensureDetectedAgents).not.toHaveBeenCalled()
  })
})
