import type { Repo } from './repo-types'
import { DEFAULT_REPO_BADGE_COLOR } from './constants'

/** The fields a sidebar project row needs; the host stamp is re-applied on read. */
export type HostRepoCatalogSnapshotRepo = Pick<
  Repo,
  'id' | 'path' | 'displayName' | 'badgeColor' | 'addedAt' | 'kind' | 'connectionId' | 'isPinned'
>

/** A WSL host's last answered `repo.list`, kept on the desktop so a stopped distro still lists its projects. */
export type HostRepoCatalogSnapshot = {
  repos: HostRepoCatalogSnapshotRepo[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snapshotRepo(value: unknown): HostRepoCatalogSnapshotRepo | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.path !== 'string' ||
    typeof value.displayName !== 'string'
  ) {
    return null
  }
  return {
    id: value.id,
    path: value.path,
    displayName: value.displayName,
    badgeColor: typeof value.badgeColor === 'string' ? value.badgeColor : DEFAULT_REPO_BADGE_COLOR,
    addedAt: typeof value.addedAt === 'number' ? value.addedAt : 0,
    ...(value.kind === 'git' || value.kind === 'folder' ? { kind: value.kind } : {}),
    // Part of row identity: on a host's row it names that host's nested SSH target.
    ...(typeof value.connectionId === 'string' ? { connectionId: value.connectionId } : {}),
    ...(value.isPinned === true ? { isPinned: true } : {})
  }
}

/** Null when the payload is not a whole catalog: a partial answer must not erase cached projects. */
export function hostRepoCatalogSnapshotFromRepoList(
  result: unknown
): HostRepoCatalogSnapshot | null {
  if (!isRecord(result) || !Array.isArray(result.repos)) {
    return null
  }
  const repos: HostRepoCatalogSnapshotRepo[] = []
  for (const entry of result.repos) {
    const repo = snapshotRepo(entry)
    if (repo) {
      repos.push(repo)
    }
  }
  return { repos }
}
