import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RepoSlice } from '../repos/repo-state'
import { createRepoCatalogActions } from '../repos/repo-catalog-actions'
import { createRuntimeRepoCatalogActions } from '../repos/runtime-repo-catalog-actions'
import { createAllHostRepoCatalogActions } from '../repos/all-host-repo-catalog-actions'
import { createProjectGroupCatalogActions } from '../project-groups/project-group-catalog-actions'
import { createFolderWorkspaceCatalogActions } from '../folder-workspaces/folder-workspace-catalog-actions'
import { createFolderPathStatusActions } from '../folder-workspaces/folder-path-status-actions'
import { createNestedRepositoryActions } from '../project-groups/nested-repository-operations'
import { createProjectGroupMutationActions } from '../project-groups/project-group-mutations'
import { createFolderWorkspaceMutationActions } from '../folder-workspaces/folder-workspace-mutations'
import { createRepoAddActions } from '../repos/repo-add-actions'
import { createProjectHostSetupActions } from '../projects/project-host-setup-actions'
import { createRepoRemovalActions } from '../repos/repo-removal'
import { createProjectUpdateActions } from '../projects/project-update'
import { createRepoUpdateActions } from '../repos/repo-update'
import { createRepoOrderingActions } from '../repos/repo-ordering'

export const createRepoSlice: StateCreator<AppState, [], [], RepoSlice> = (set, get) => {
  const repoCatalogActions = createRepoCatalogActions(set, get)
  const runtimeRepoCatalogActions = createRuntimeRepoCatalogActions(set, get)
  const allHostRepoCatalogActions = createAllHostRepoCatalogActions(set, get)
  const projectGroupCatalogActions = createProjectGroupCatalogActions(set, get)
  const folderWorkspaceCatalogActions = createFolderWorkspaceCatalogActions(set, get)
  const folderPathStatusActions = createFolderPathStatusActions(set, get)
  const nestedRepositoryOperations = createNestedRepositoryActions(set, get)
  const projectGroupMutations = createProjectGroupMutationActions(set, get)
  const folderWorkspaceMutations = createFolderWorkspaceMutationActions(set, get)
  const repoAddActions = createRepoAddActions(set, get)
  const projectHostSetupActions = createProjectHostSetupActions(set, get)
  const repoRemoval = createRepoRemovalActions(set, get)
  const projectUpdate = createProjectUpdateActions(set, get)
  const repoUpdate = createRepoUpdateActions(set, get)
  const repoOrdering = createRepoOrderingActions(set, get)
  return {
    repos: [],
    projects: [],
    projectHostSetups: [],
    projectGroups: [],
    folderWorkspaces: [],
    folderWorkspacePathStatuses: {},
    activeRepoId: null,
    reposFetchGeneration: 0,
    pendingSshRepoReadoptions: [],
    recordSshRepoReadoptions: repoCatalogActions.recordSshRepoReadoptions,
    fetchRepos: repoCatalogActions.fetchRepos,
    fetchRuntimeEnvironmentRepos: runtimeRepoCatalogActions.fetchRuntimeEnvironmentRepos,
    fetchReposForAllHosts: allHostRepoCatalogActions.fetchReposForAllHosts,
    awaitLocalRepoCatalogSettlement: repoCatalogActions.awaitLocalRepoCatalogSettlement,
    fetchProjectGroups: projectGroupCatalogActions.fetchProjectGroups,
    fetchProjectGroupsForAllHosts: projectGroupCatalogActions.fetchProjectGroupsForAllHosts,
    fetchFolderWorkspaces: folderWorkspaceCatalogActions.fetchFolderWorkspaces,
    fetchFolderWorkspacesForAllHosts:
      folderWorkspaceCatalogActions.fetchFolderWorkspacesForAllHosts,
    getFolderWorkspacePathStatusCacheKey:
      folderPathStatusActions.getFolderWorkspacePathStatusCacheKey,
    getFreshFolderWorkspacePathStatus: folderPathStatusActions.getFreshFolderWorkspacePathStatus,
    fetchFolderWorkspacePathStatus: folderPathStatusActions.fetchFolderWorkspacePathStatus,
    scanNestedRepos: nestedRepositoryOperations.scanNestedRepos,
    cancelNestedRepoScan: nestedRepositoryOperations.cancelNestedRepoScan,
    importNestedRepos: nestedRepositoryOperations.importNestedRepos,
    createProjectGroup: projectGroupMutations.createProjectGroup,
    createFolderWorkspace: folderWorkspaceMutations.createFolderWorkspace,
    updateFolderWorkspace: folderWorkspaceMutations.updateFolderWorkspace,
    deleteFolderWorkspace: folderWorkspaceMutations.deleteFolderWorkspace,
    updateProjectGroup: projectGroupMutations.updateProjectGroup,
    deleteProjectGroup: projectGroupMutations.deleteProjectGroup,
    deleteProjectGroupWithContainedProjects:
      projectGroupMutations.deleteProjectGroupWithContainedProjects,
    moveProjectToGroup: projectGroupMutations.moveProjectToGroup,
    addRepoPath: repoAddActions.addRepoPath,
    setupProjectExistingFolder: projectHostSetupActions.setupProjectExistingFolder,
    createProjectHostSetup: projectHostSetupActions.createProjectHostSetup,
    updateProjectHostSetup: projectHostSetupActions.updateProjectHostSetup,
    deleteProjectHostSetup: projectHostSetupActions.deleteProjectHostSetup,
    setupProjectClone: projectHostSetupActions.setupProjectClone,
    addRepo: repoAddActions.addRepo,
    addNonGitFolder: repoAddActions.addNonGitFolder,
    removeProject: repoRemoval.removeProject,
    updateProject: projectUpdate.updateProject,
    updateRepo: repoUpdate.updateRepo,
    setActiveRepo: repoOrdering.setActiveRepo,
    reorderRepos: repoOrdering.reorderRepos
  }
}
