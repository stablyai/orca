import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import { copyOwnStreamParent } from '../../../../shared/perforce/workspace-copy/workspace-copy-stream-choice'
import {
  getPerforceCopyName,
  isPerforceCopyWorktreeIdForRepo
} from '../../../../shared/worktree/perforce-copy-worktree'
import type { Worktree } from '../../../../shared/worktree/types'

export type PerforceCopyDeleteTarget = {
  /** The Perforce folder project the copy belongs to, and the host that owns it. */
  repoId: string
  hostId: ExecutionHostId
  sourcePath: string
  copyName: string
}

function copyTargetForRepo(
  repo: Repo | null | undefined,
  worktree: Pick<Worktree, 'id' | 'path'>
): PerforceCopyDeleteTarget | null {
  if (!repo || !isFolderRepo(repo) || !isPerforceCopyWorktreeIdForRepo(repo, worktree.id)) {
    return null
  }
  const copyName = getPerforceCopyName(worktree.path)
  return copyName
    ? { repoId: repo.id, hostId: getRepoExecutionHostId(repo), sourcePath: repo.path, copyName }
    : null
}

/** The delete-confirmation target when `worktree` is a Perforce copy of a folder project, else null. */
export function getPerforceCopyDeleteTarget(
  state: {
    repos: readonly Repo[]
    settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  },
  worktree: Pick<Worktree, 'id' | 'repoId' | 'path' | 'hostId'>
): PerforceCopyDeleteTarget | null {
  const repo = findRepoForHost(state.repos, worktree.repoId, {
    hostId: worktree.hostId,
    settings: state.settings
  })
  return copyTargetForRepo(repo, worktree)
}

export type PerforceCopyUpTarget = PerforceCopyDeleteTarget & { stream: string; parent: string }

/** The copy-up target when `worktree` is a Perforce copy of `repo` on a stream of its own, else null. */
export function getPerforceCopyUpTarget(
  repo: Repo | null | undefined,
  worktree: Pick<Worktree, 'id' | 'path' | 'perforceStream'>
): PerforceCopyUpTarget | null {
  const copy = copyTargetForRepo(repo, worktree)
  const stream = worktree.perforceStream
  const parent = copy && stream ? copyOwnStreamParent(stream, copy.copyName) : null
  return copy && stream && parent ? { ...copy, stream, parent } : null
}
