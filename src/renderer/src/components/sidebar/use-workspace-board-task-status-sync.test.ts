import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import {
  linearSettingsForBoardWorktree,
  clickUpSettingsForBoardWorktree
} from './use-workspace-board-task-status-sync'

const WORKTREE_ID = 'repo::/w'
type OwnerHost = 'local' | 'runtime:env-b'

function ownedBy(...hostIds: OwnerHost[]) {
  return {
    repos: hostIds.map((hostId) => ({ id: 'repo', executionHostId: hostId })),
    worktreesByRepo: {
      repo: hostIds.map((hostId) => ({
        id: WORKTREE_ID,
        repoId: 'repo',
        hostId,
        ...(hostId === 'local' ? {} : { runtimeOwnerEnvironmentId: 'env-b' })
      }))
    }
  }
}

describe('linearSettingsForBoardWorktree', () => {
  it("uses the runtime owner's Linear settings", () => {
    expect(linearSettingsForBoardWorktree(ownedBy('runtime:env-b'), WORKTREE_ID)).toEqual({
      kind: 'environment',
      environmentId: 'env-b'
    })
  })

  it("skips a local twin of a server instead of borrowing this computer's Linear", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(linearSettingsForBoardWorktree(ownedBy('local', 'runtime:env-b'), WORKTREE_ID)).toBe(
      null
    )
    expect(warn.mock.calls[0]).toContain(WORKTREE_ID)
    warn.mockRestore()
  })
})

describe('clickUpSettingsForBoardWorktree', () => {
  it('prefers the saved ClickUp task source context over workspace owner routing', () => {
    const source = {
      kind: 'task-source' as const,
      provider: 'clickup' as const,
      projectId: 'proj',
      hostId: 'local' as const
    }
    expect(
      clickUpSettingsForBoardWorktree(
        {
          ...ownedBy('runtime:env-b'),
          getKnownWorktreeById: () => ({ linkedTaskSourceContext: source })
        },
        WORKTREE_ID
      )
    ).toEqual({ activeRuntimeEnvironmentId: null })
  })
})
