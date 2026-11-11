import { getDefaultSettings } from '../../../shared/constants'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../shared/worktree/types'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { Store } from '../../../main/persistence/loading-store/store'
import {
  listWslStoppedWorktrees,
  wslDistroNotRunningForScanFailure
} from '../../../main/ipc/worktrees/listing/wsl-stopped-worktree-listing'
import { WslDistroStoppedError } from '../../../main/wsl/filesystem/wsl-unc-access-gate'

export function stoppedWorkspaceListing(repo: Repo, rows: Worktree[]): DetectedWorktreeListResult {
  const meta: Record<string, WorktreeMeta> = Object.fromEntries(rows.map((row) => [row.id, row]))
  const store: Partial<Store> = {
    getRepos: () => [repo],
    getSettings: () => getDefaultSettings('/qa'),
    getProjectHostSetups: () => [],
    getAllWorktreeMeta: () => meta,
    getWorktreeMetaForHost: (id: string) => meta[id],
    getAllWorktreeMetaForHost: () => meta,
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    setWorktreeMeta: (target: HostWorktreeTarget, updates: Partial<WorktreeMeta>) =>
      (meta[target.id] = { ...meta[target.id], ...updates })
  }
  return {
    repoId: repo.id,
    authoritative: false,
    source: 'metadata-fallback',
    wslDistroStopped:
      wslDistroNotRunningForScanFailure(new WslDistroStoppedError('orca-qa')) ?? undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stopped listing only reads these validated metadata/ownership methods; no persistence or process method is reachable.
    worktrees: listWslStoppedWorktrees(store as Store, repo, meta)
  }
}
