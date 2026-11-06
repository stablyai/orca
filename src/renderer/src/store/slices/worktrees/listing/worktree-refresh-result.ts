import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { AdmittedDetectedWorktreeRefresh } from './worktree-slice-types'

export type WorktreeRefreshResult = {
  repoId: string
  hostId: ExecutionHostId
  refresh: AdmittedDetectedWorktreeRefresh | null
}
