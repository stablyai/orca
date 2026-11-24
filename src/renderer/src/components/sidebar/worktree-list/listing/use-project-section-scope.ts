import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  useAllWorktrees,
  useWorktreeMap
} from '@/store/slices/worktrees/listing/use-worktree-catalog'
import { useProjectHostSetupProjection } from '@/store/projects/use-project-host-setup-projection'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  getRepoHostIdentity,
  getRepoHostIdentityForParts
} from '../../../../../../shared/repository/repo-host-identity'
import { getProjectIdentityKey } from '../../../../../../shared/project/host-setup/project-host-setup-projection'

const EMPTY = []

export function useProjectSectionScope(section: 'projects' | 'chats') {
  const catalog = useAppStore((state) => state.repos)
  const allWorktrees = useAllWorktrees()
  const worktreeMap = useWorktreeMap()
  const projectGroups = useAppStore((state) => state.projectGroups ?? EMPTY)
  const folderWorkspaces = useAppStore(selectFolderWorkspaces)
  const projection = useProjectHostSetupProjection()
  return useMemo(() => {
    const repos = catalog.filter((repo) => Boolean(repo.chatWorkspace) === (section === 'chats'))
    const keys = new Set(repos.map(getRepoHostIdentity))
    const byHost = new Map(catalog.map((repo) => [getRepoHostIdentity(repo), repo]))
    const byId = new Map(catalog.map((repo) => [repo.id, repo]))
    const projectIds = new Set(repos.map(getProjectIdentityKey))
    const owns = (row: { repoId: string; hostId?: string | null }) => {
      const repo =
        byHost.get(getRepoHostIdentityForParts(row.repoId, row.hostId ?? 'local')) ??
        byId.get(row.repoId)
      return repo !== undefined && Boolean(repo.chatWorkspace) === (section === 'chats')
    }
    return {
      repos,
      ownsWorktree: owns,
      repoMap: new Map(repos.map((repo) => [repo.id, repo])),
      allWorktrees: allWorktrees.filter(owns),
      worktreeMap: new Map([...worktreeMap].filter(([, row]) => owns(row))),
      projectGroups: section === 'chats' ? EMPTY : projectGroups,
      folderWorkspaces: section === 'chats' ? EMPTY : folderWorkspaces,
      projectGrouping: {
        projects: projection.projects.filter((project) => projectIds.has(project.id)),
        projectHostSetups: projection.setups.filter((setup) =>
          keys.has(getRepoHostIdentityForParts(setup.repoId, setup.hostId))
        )
      }
    }
  }, [catalog, allWorktrees, worktreeMap, projectGroups, folderWorkspaces, projection, section])
}
