import { TEST_REPO } from '@/store/repos/repo.test-fixture'
// @vitest-environment happy-dom
import './new-tab-agent-menu-host-preferences-test-fixture'
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import {
  useAgentLaunchPickerInventorySource,
  useAgentPickerInventoryEntries
} from '../agent/use-agent-launch-picker-inventory'
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'

it('uses nested SSH runtime preferences and picker seeds while offering only terminal launches', async () => {
  useAppStore.setState({
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({
          id: 'wt',
          repoId: TEST_REPO.id,
          hostId: 'ssh:box',
          runtimeOwnerEnvironmentId: 'alpha'
        })
      ]
    }
  })
  const workspace = { kind: 'git-worktree' as const, worktreeId: 'wt', hostId: 'ssh:box' as const }
  const hook = renderHook(() => {
    const menu = useNewTabAgentMenuRows({ workspace }, true, {
      kind: 'runtime',
      environmentId: 'alpha',
      worktreeId: 'wt'
    })
    const entries = useAgentPickerInventoryEntries(
      useAgentLaunchPickerInventorySource('wt', menu, true)
    )
    return { menu, entries }
  })
  await act(async () => {})
  expect(hook.result.current.menu).toMatchObject({ state: 'settled', defaultTuiAgent: 'codex' })
  expect(hook.result.current.menu.state === 'settled' && hook.result.current.menu.rows).toEqual([
    { agent: 'codex', kind: 'cli', executionHostId: 'ssh:box' },
    { agent: 'claude', kind: 'cli', executionHostId: 'ssh:box' }
  ])
  expect(hook.result.current.entries.find((entry) => entry.agent === 'codex')).toMatchObject({
    terminal: { model: 'host-model', options: { effort: 'low' } },
    surfaces: ['terminal']
  })
  await expect(
    ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
  ).resolves.toMatchObject({
    defaultTuiAgent: 'codex',
    disabledTuiAgents: ['opencode']
  })
})
