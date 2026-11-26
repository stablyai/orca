import type { Repo } from '../../repository/repo-types'
import {
  getRepoHostIdentity,
  getRepoHostIdentityForParts
} from '../../repository/repo-host-identity'
import type { WorkspaceListSection } from './workspace-section-folds'

export function createWorkspaceSectionOwnership(
  catalog: readonly Repo[],
  section: WorkspaceListSection
): (row: { repoId: string; hostId?: string | null }) => boolean {
  const byHost = new Map(catalog.map((repo) => [getRepoHostIdentity(repo), repo]))
  const byId = new Map(catalog.map((repo) => [repo.id, repo]))
  return (row) => {
    const exact = byHost.get(getRepoHostIdentityForParts(row.repoId, row.hostId ?? 'local'))
    const repo = exact ?? (row.hostId == null ? byId.get(row.repoId) : undefined)
    return repo !== undefined && Boolean(repo.chatWorkspace) === (section === 'chats')
  }
}
