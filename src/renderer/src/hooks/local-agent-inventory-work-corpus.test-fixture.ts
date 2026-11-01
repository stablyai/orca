import { makeProjectGroup } from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import {
  makeWorktree,
  makeFolderWorkspace,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'

export function installLocalAgentInventoryWorkCorpus(
  count: number,
  observe: {
    projectRead: () => void
    projectCopy: () => void
    workspaceRead: () => void
    folderRead: () => void
  }
) {
  const repos: Repo[] = Array.from({ length: 1000 }, (_, index) => ({
    ...TEST_REPO,
    id: `repo-${index}`,
    path: `C:\\project-${index}`
  }))
  repos[0] = { ...repos[0], projectGroupId: 'folder-group' }
  const catalog = projectHostSetupProjectionFromRepos(repos)
  const projects = (rows: readonly Project[]) =>
    rows.map((project) => {
      observe.projectCopy()
      return {
        ...project,
        get id() {
          observe.projectRead()
          return project.id
        },
        get sourceRepoIds() {
          observe.projectRead()
          return project.sourceRepoIds
        }
      }
    })
  const worktrees = repos.slice(-count - 1).map((repo) => {
    const worktree = makeWorktree({
      id: `${repo.id}::${repo.path}`,
      repoId: repo.id,
      path: repo.path
    })
    return {
      ...worktree,
      get id() {
        observe.workspaceRead()
        return worktree.id
      }
    }
  })
  const folderWorkspace = makeFolderWorkspace({
    id: 'folder',
    projectGroupId: 'folder-group',
    folderPath: 'C:\\folder',
    executionHostId: 'local'
  })
  useAppStore.setState({
    repos,
    projects: projects(
      catalog.projects.map((project) => ({
        ...project,
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }))
    ),
    folderWorkspaces: [
      {
        ...folderWorkspace,
        get id() {
          observe.folderRead()
          return folderWorkspace.id
        }
      }
    ],
    projectGroups: [{ ...makeProjectGroup(), id: 'folder-group' }],
    projectHostSetups: [...catalog.setups],
    worktreesByRepo: Object.fromEntries(worktrees.map((wt) => [wt.repoId, [wt]])),
    settings: getDefaultSettings('/tmp')
  })
  return { repos, catalog, projects, worktrees }
}
