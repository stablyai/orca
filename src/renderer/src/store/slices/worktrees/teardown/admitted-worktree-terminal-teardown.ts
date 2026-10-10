import type { AppState } from '../../../types'
import type {
  AdmittedDetectedWorktreeRefresh,
  WorktreeSliceGet
} from '../listing/worktree-slice-types'
import { worktreeListingRefusal } from '../listing/detected-worktree-refresh-admission'
import { teardownMissingWorktreeTerminalsBestEffort } from './missing-worktree-terminal-teardown'

export async function teardownAfterAdmittedWorktreeListing(
  get: WorktreeSliceGet,
  args: {
    settings: AppState['settings']
    repoId: string
    refresh: AdmittedDetectedWorktreeRefresh
    connectionId?: string | null
    knownWorktreeIds?: readonly string[]
    ownerMayBeMissing: boolean
  }
): Promise<void> {
  const { settings, repoId, refresh, connectionId, knownWorktreeIds, ownerMayBeMissing } = args
  if (
    !knownWorktreeIds ||
    worktreeListingRefusal(get(), refresh, repoId, refresh.executionHostId, ownerMayBeMissing)
  ) {
    return
  }
  await teardownMissingWorktreeTerminalsBestEffort(
    settings,
    repoId,
    connectionId,
    knownWorktreeIds,
    refresh.result
  )
}
