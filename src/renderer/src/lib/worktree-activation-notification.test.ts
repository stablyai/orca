import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import * as activationGate from './worktree-agent-activation-gate'
import * as sleepingSessions from './resume-sleeping-agent-session'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent-test-state'

const initialState = useAppStore.getState()
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

it('selects an empty notification workspace without adopting live PTYs or recovering sessions', () => {
  const worktree = makeCreatedAgentWorktree()
  seedEmptyActivatableWorktree(worktree)
  vi.stubGlobal('window', { api: { runtime: { call: vi.fn() }, pty: { listSessions: vi.fn() } } })
  const gate = vi.spyOn(activationGate, 'gateWorktreeAgentActivation').mockResolvedValue('adopted')
  const resume = vi
    .spyOn(sleepingSessions, 'resumeSleepingAgentSessionsForWorktree')
    .mockReturnValue(0)

  expect(
    activateAndRevealWorktree(worktree.id, {
      providesInitialSurface: true,
      restoreSessions: false,
      notifyHostRuntime: false
    })
  ).not.toBe(false)

  expect(useAppStore.getState().activeWorktreeId).toBe(worktree.id)
  expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toEqual([])
  expect(gate).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
})
