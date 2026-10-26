// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import {
  useIsSleepingWorktree,
  resetWorktreeSleepStateCacheForTests
} from './use-worktree-sleep-state'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetWorktreeSleepStateCacheForTests()
})
it('keeps a workspace awake through a PTY gap using canonical status only', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  const owner = getAgentStatusOwner(useAppStore)
  const view = renderHook(() => useIsSleepingWorktree('workspace'))
  expect(view.result.current).toBe(true)
  act(() =>
    owner.transact((transaction) =>
      transaction.setEntry('tab:leaf', {
        paneKey: 'tab:leaf',
        worktreeId: 'workspace',
        agentType: 'codex',
        state: 'working',
        prompt: '',
        stateHistory: [],
        stateStartedAt: Date.now(),
        updatedAt: Date.now()
      })
    )
  )
  expect(useAppStore.getState()).not.toHaveProperty('agentStatusByPaneKey')
  expect(view.result.current).toBe(false)
  act(() => owner.transact((transaction) => transaction.setEntry('tab:leaf', undefined)))
  expect(view.result.current).toBe(true)
})
