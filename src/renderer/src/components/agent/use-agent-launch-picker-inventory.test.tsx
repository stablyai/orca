// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { useNewTabAgentMenuRows } from './launch-menu/use-new-tab-agent-menu-rows'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'

it('labels agents with their Settings catalog names, not raw ids', async () => {
  const worktree = makeWorktree({ repoId: 'repo1', id: 'repo1::/teams', path: '/teams' })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [worktree] },
    settings: { ...getDefaultSettings('/synthetic'), nativeChatProviders: {} },
    localDetectedAgentIdsByContext: { host: ['claude-agent-teams'] },
    ensureDetectedAgents: async () => ['claude-agent-teams']
  })
  const hook = renderHook(() =>
    useAgentLaunchPickerInventory(
      worktree.id,
      useNewTabAgentMenuRows(worktree.id, true, { kind: 'local', contextKey: 'host' }),
      true
    )
  )
  await waitFor(() =>
    expect(hook.result.current.find((entry) => entry.agent === 'claude-agent-teams')?.label).toBe(
      'Claude Agent Teams'
    )
  )
})
