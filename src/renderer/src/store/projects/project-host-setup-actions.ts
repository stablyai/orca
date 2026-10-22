import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateResult
} from '../../../../shared/project-types'
import { omitSparsePresetsForRepos } from '../slices/sparse-presets'
import { repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from '../repos/repo-state'
import { ERROR_TOAST_DURATION } from '../repos/repo-state'
import { adoptFromEndpoint } from '../adopt-from-endpoint'
import { normalizeProjectRow } from '../../../../shared/project-catalog-row-normalization'
import {
  assertProjectHostSetupMutationRuntimeCapabilities,
  getProjectSetupRuntimeTarget,
  isSameProjectHostSetup,
  prepareProjectHostSetupMutation,
  upsertProjectHostSetup
} from './project-host-routing'
import { selectProjectHostSetups, selectProjects, selectRepos } from '../project-catalog-selectors'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'
import { mainCatalogDropsSetup, mainCatalogShowsSetup } from './project-host-setup-catalog-shown'
import { setupProjectClone } from './project-clone-setup'

export function createProjectHostSetupActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  RepoSlice,
  | 'setupProjectExistingFolder'
  | 'createProjectHostSetup'
  | 'updateProjectHostSetup'
  | 'deleteProjectHostSetup'
  | 'setupProjectClone'
> {
  return {
    setupProjectExistingFolder: async (args) => {
      try {
        const target = getProjectSetupRuntimeTarget(args.hostId)
        await assertProjectHostSetupMutationRuntimeCapabilities(target)
        const projectProviderIdentity =
          args.projectProviderIdentity ??
          selectProjects(get()).find((project) => project.id === args.projectId)?.providerIdentity
        // Why: the target host may not have a project record yet; carry the selected source-host identity across the boundary.
        const setupArgs = projectProviderIdentity ? { ...args, projectProviderIdentity } : args
        const result =
          target.kind === 'local'
            ? await window.api.projects.setupExistingFolder(setupArgs)
            : (
                await callRuntimeRpc<{ result: ProjectHostSetupResult }>(
                  target,
                  'projectHostSetup.setupExistingFolder',
                  setupArgs,
                  { timeoutMs: 15_000 }
                )
              ).result
        const repo = adoptFromEndpoint(target, {
          kind: 'repo',
          row: result.repo
        })
        const repoHostId = getRepoExecutionHostId(repo)
        const setup = adoptFromEndpoint(target, {
          kind: 'projectHostSetup',
          row: result.setup
        })
        const project = normalizeProjectRow(result.project)
        if (ORCA_SIDEBAR_INPUTS_IS_MAIN && !(await mainCatalogShowsSetup(target, setup, repo))) {
          return null
        }
        set((s) => {
          if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
            return s
          }
          const nextRepos = selectRepos(s).some((entry) =>
            repoMatchesHostIdentity(entry, repo.id, repoHostId)
          )
            ? selectRepos(s).map((entry) =>
                repoMatchesHostIdentity(entry, repo.id, repoHostId) ? repo : entry
              )
            : [...selectRepos(s), repo]
          const nextProjects = selectProjects(s).some((entry) => entry.id === project.id)
            ? selectProjects(s).map((entry) => (entry.id === project.id ? project : entry))
            : [...selectProjects(s), project]
          const nextSetups = selectProjectHostSetups(s).some((entry) => entry.id === setup.id)
            ? selectProjectHostSetups(s).map((entry) => (entry.id === setup.id ? setup : entry))
            : [...selectProjectHostSetups(s), setup]
          return {
            repos: nextRepos,
            projects: nextProjects,
            projectHostSetups: nextSetups
          }
        })
        toast.success(translate('auto.store.slices.repos.8bb3ad7935', 'Project added'), {
          description: repo.displayName
        })
        return { ...result, project, repo, setup }
      } catch (err) {
        console.error('Failed to set up project on host:', err)
        const message = err instanceof Error ? err.message : String(err)
        toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
          description: message,
          duration: ERROR_TOAST_DURATION
        })
        return null
      }
    },

    createProjectHostSetup: async (args) => {
      try {
        const target = getProjectSetupRuntimeTarget(args.hostId)
        await assertProjectHostSetupMutationRuntimeCapabilities(target)
        const result =
          target.kind === 'local'
            ? await window.api.projects.createHostSetup(args)
            : (
                await callRuntimeRpc<{ result: ProjectHostSetupCreateResult }>(
                  target,
                  'projectHostSetup.create',
                  args,
                  { timeoutMs: 15_000 }
                )
              ).result
        const setup = adoptFromEndpoint(target, {
          kind: 'projectHostSetup',
          row: result.setup
        })
        const project = normalizeProjectRow(result.project)
        if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
          return (await mainCatalogShowsSetup(target, setup, undefined)) ? { project, setup } : null
        }
        set((s) => ({
          projects: selectProjects(s).some((entry) => entry.id === project.id)
            ? selectProjects(s).map((entry) => (entry.id === project.id ? project : entry))
            : [...selectProjects(s), project],
          projectHostSetups: upsertProjectHostSetup(selectProjectHostSetups(s), setup)
        }))
        return { project, setup }
      } catch (err) {
        console.error('Failed to create project host setup:', err)
        const message = err instanceof Error ? err.message : String(err)
        toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
          description: message,
          duration: ERROR_TOAST_DURATION
        })
        return null
      }
    },

    updateProjectHostSetup: async (args) => {
      try {
        const { target, hostArgs } = await prepareProjectHostSetupMutation(
          selectProjectHostSetups(get()),
          args
        )
        const result =
          target.kind === 'local'
            ? await window.api.projects.updateHostSetup(hostArgs)
            : (
                await callRuntimeRpc<{ result: ProjectHostSetupUpdateResult }>(
                  target,
                  'projectHostSetup.update',
                  hostArgs,
                  { timeoutMs: 15_000 }
                )
              ).result
        const setup = adoptFromEndpoint(target, {
          kind: 'projectHostSetup',
          row: result.setup
        })
        const project = normalizeProjectRow(result.project)
        const repo = result.repo
          ? adoptFromEndpoint(target, { kind: 'repo', row: result.repo })
          : undefined
        const repoHostId = repo ? getRepoExecutionHostId(repo) : null
        if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
          const shown = await mainCatalogShowsSetup(target, setup, repo)
          return shown ? { ...result, project, repo, setup } : null
        }
        set((s) => ({
          repos: repo
            ? selectRepos(s).some((entry) => repoMatchesHostIdentity(entry, repo.id, repoHostId!))
              ? selectRepos(s).map((entry) =>
                  repoMatchesHostIdentity(entry, repo.id, repoHostId!) ? repo : entry
                )
              : [...selectRepos(s), repo]
            : selectRepos(s),
          projects: selectProjects(s).some((entry) => entry.id === project.id)
            ? selectProjects(s).map((entry) => (entry.id === project.id ? project : entry))
            : [...selectProjects(s), project],
          projectHostSetups: upsertProjectHostSetup(selectProjectHostSetups(s), setup)
        }))
        return { ...result, project, repo, setup }
      } catch (err) {
        console.error('Failed to update project host setup:', err)
        const message = err instanceof Error ? err.message : String(err)
        toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
          description: message,
          duration: ERROR_TOAST_DURATION
        })
        return null
      }
    },

    deleteProjectHostSetup: async (args) => {
      try {
        const { target, hostArgs } = await prepareProjectHostSetupMutation(
          selectProjectHostSetups(get()),
          args
        )
        const result =
          target.kind === 'local'
            ? await window.api.projects.deleteHostSetup(hostArgs)
            : (
                await callRuntimeRpc<{ result: ProjectHostSetupDeleteResult }>(
                  target,
                  'projectHostSetup.delete',
                  hostArgs,
                  { timeoutMs: 15_000 }
                )
              ).result
        const repo = result.repo
          ? adoptFromEndpoint(target, { kind: 'repo', row: result.repo })
          : undefined
        const repoHostId = repo ? getRepoExecutionHostId(repo) : null
        const removedSetup = adoptFromEndpoint(target, {
          kind: 'projectHostSetup',
          row: result.setup
        })
        if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
          const repoIds = new Set(selectRepos(get()).map((r) => r.id))
          if (!(await mainCatalogDropsSetup(target, removedSetup, repo))) {
            return null
          }
          const gone = [...repoIds].filter((id) => !selectRepos(get()).some((r) => r.id === id))
          set((s) => omitSparsePresetsForRepos(s, gone))
          return { ...result, repo }
        }
        set((s) => {
          const projectHostSetups = selectProjectHostSetups(s).filter(
            (setup) => !isSameProjectHostSetup(setup, removedSetup)
          )
          const repos =
            repo && repoHostId
              ? selectRepos(s).filter(
                  (entry) => !repoMatchesHostIdentity(entry, repo.id, repoHostId)
                )
              : selectRepos(s)
          const projects =
            repo && !projectHostSetups.some((setup) => setup.projectId === result.project.id)
              ? selectProjects(s).filter((project) => project.id !== result.project.id)
              : selectProjects(s)
          const survivingRepoIds = new Set(repos.map((r) => r.id))
          const removedRepoIds = selectRepos(s)
            .filter((r) => !survivingRepoIds.has(r.id))
            .map((r) => r.id)
          return {
            repos,
            projects,
            projectHostSetups,
            ...omitSparsePresetsForRepos(s, removedRepoIds)
          }
        })
        return { ...result, repo }
      } catch (err) {
        console.error('Failed to delete project host setup:', err)
        const message = err instanceof Error ? err.message : String(err)
        toast.error(
          translate('auto.store.slices.repos.removeProjectFailed', 'Failed to remove project'),
          {
            description: message,
            duration: ERROR_TOAST_DURATION
          }
        )
        return null
      }
    },

    setupProjectClone: (args) => setupProjectClone(get, args)
  }
}
