import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../shared/types'

const harness = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  repos: [] as { id: string; worktreeBaseRef?: string }[],
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(harness), {
    getState: () => ({ createWorktree: harness.createWorktree, repos: harness.repos })
  })
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => harness.toastError(...args) } }))

import { createDirectorWorktreeShell } from './director-worktree-shell'

// createWorktree's positional signature: the createdWithAgent flag — the arg that
// makes activation relaunch an agent — sits well after displayName.
const CREATED_WITH_AGENT_ARG_INDEX = 10
const SETUP_DECISION_ARG_INDEX = 3

const PROJECT: Project = {
  id: 'proj_1',
  displayName: 'Demo',
  sourceRepoIds: ['repo_1']
} as unknown as Project

beforeEach(() => {
  vi.clearAllMocks()
  harness.repos = [{ id: 'repo_1', worktreeBaseRef: 'main' }]
  harness.createWorktree.mockResolvedValue({ worktree: { id: 'wt_director' }, setup: undefined })
})

describe('createDirectorWorktreeShell', () => {
  it('creates the shell token-free: no agent is seeded into the director pane', async () => {
    const shell = await createDirectorWorktreeShell(PROJECT, { label: 'My Recipe' })

    expect(shell).toEqual({ worktreeId: 'wt_director', setup: undefined })
    expect(harness.createWorktree).toHaveBeenCalledTimes(1)

    const args = harness.createWorktree.mock.calls[0]
    // 'skip' setup (a director coordinates, it doesn't build)...
    expect(args[SETUP_DECISION_ARG_INDEX]).toBe('skip')
    // ...and CRUCIALLY no createdWithAgent — otherwise activation would relaunch an
    // LLM in the director pane, breaking the token-free invariant.
    expect(args[CREATED_WITH_AGENT_ARG_INDEX]).toBeUndefined()
    // ...and the trailing options suppress host activation so an SSH create
    // reveals the director without switching the user's active tab to it.
    expect(args.at(-1)).toEqual({ suppressActivation: true })
  })

  it('returns null and toasts when the project has no repo', async () => {
    const shell = await createDirectorWorktreeShell(
      { ...PROJECT, sourceRepoIds: [] } as unknown as Project,
      { label: 'x' }
    )
    expect(shell).toBeNull()
    expect(harness.createWorktree).not.toHaveBeenCalled()
    expect(harness.toastError).toHaveBeenCalledTimes(1)
  })

  it('returns null and toasts when worktree creation fails', async () => {
    harness.createWorktree.mockRejectedValue(new Error('boom'))
    const shell = await createDirectorWorktreeShell(PROJECT, { label: 'x' })
    expect(shell).toBeNull()
    expect(harness.toastError).toHaveBeenCalledWith('boom')
  })
})
