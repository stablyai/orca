import type { Worktree } from '../../../../../shared/worktree/types'

import { makeWorktree } from './worktree.test-fixture'

export function makeRuntimeOwnedWorktree(
  overrides: Partial<Worktree> & { id: string; repoId: string },
  runtimeEnvironmentId = 'runtime-1'
): Worktree {
  return makeWorktree({
    ...overrides,
    hostId: overrides.hostId ?? 'local',
    runtimeOwnerEnvironmentId: runtimeEnvironmentId
  })
}
