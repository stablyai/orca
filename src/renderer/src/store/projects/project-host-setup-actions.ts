import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateResult
} from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { omitSparsePresetsForRepos } from '../slices/sparse-presets'
import { repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from '../repos/repo-state'
import { ERROR_TOAST_DURATION } from '../repos/repo-state'
import { repoWithFetchedOwner } from '../repos/owner-routing'
import { normalizeProjectRow } from '../../../../shared/project-catalog-row-normalization'
import {
  assertProjectHostSetupMutationRuntimeCapabilities,
  getProjectSetupRuntimeTarget,
  setupWithFetchedOwner
} from './project-host-routing'

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
          get().projects.find((project) => project.id === args.projectId)?.providerIdentity
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
        const repo = repoWithFetchedOwner(result.repo, target)
        const repoHostId = getRepoExecutionHostId(repo)
        const setup = setupWithFetchedOwner(result.setup, target)
        const project = normalizeProjectRow(result.project)
        set((s) => {
          const nextRepos = s.repos.some((entry) =>
            repoMatchesHostIdentity(entry, repo.id, repoHostId)
          )
            ? s.repos.map((entry) =>
                repoMatchesHostIdentity(entry, repo.id, repoHostId) ? repo : entry
              )
            : [...s.repos, repo]
          const nextProjects = s.projects.some((entry) => entry.id === project.id)
            ? s.projects.map((entry) => (entry.id === project.id ? project : entry))
            : [...s.projects, project]
          const nextSetups = s.projectHostSetups.some((entry) => entry.id === setup.id)
            ? s.projectHostSetups.map((entry) => (entry.id === setup.id ? setup : entry))
            : [...s.projectHostSetups, setup]
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
        const setup = setupWithFetchedOwner(result.setup, target)
        const project = normalizeProjectRow(result.project)
        set((s) => ({
          projects: s.projects.some((entry) => entry.id === project.id)
            ? s.projects.map((entry) => (entry.id === project.id ? project : entry))
            : [...s.projects, project],
          projectHostSetups: s.projectHostSetups.some((entry) => entry.id === setup.id)
            ? s.projectHostSetups.map((entry) => (entry.id === setup.id ? setup : entry))
            : [...s.projectHostSetups, setup]
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
        const currentSetup = get().projectHostSetups.find((setup) => setup.id === args.setupId)
        const target = currentSetup
          ? getProjectSetupRuntimeTarget(currentSetup.hostId)
          : { kind: 'local' as const }
        await assertProjectHostSetupMutationRuntimeCapabilities(target)
        const result =
          target.kind === 'local'
            ? await window.api.projects.updateHostSetup(args)
            : (
                await callRuntimeRpc<{ result: ProjectHostSetupUpdateResult }>(
                  target,
                  'projectHostSetup.update',
                  args,
                  { timeoutMs: 15_000 }
                )
              ).result
        const setup = setupWithFetchedOwner(result.setup, target)
        const project = normalizeProjectRow(result.project)
        const repo = result.repo ? repoWithFetchedOwner(result.repo, target) : undefined
        const repoHostId = repo ? getRepoExecutionHostId(repo) : null
        set((s) => ({
          repos: repo
            ? s.repos.some((entry) => repoMatchesHostIdentity(entry, repo.id, repoHostId!))
              ? s.repos.map((entry) =>
                  repoMatchesHostIdentity(entry, repo.id, repoHostId!) ? repo : entry
                )
              : [...s.repos, repo]
            : s.repos,
          projects: s.projects.some((entry) => entry.id === project.id)
            ? s.projects.map((entry) => (entry.id === project.id ? project : entry))
            : [...s.projects, project],
          projectHostSetups: s.projectHostSetups.some((entry) => entry.id === setup.id)
            ? s.projectHostSetups.map((entry) => (entry.id === setup.id ? setup : entry))
            : [...s.projectHostSetups, setup]
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
        const currentSetup = get().projectHostSetups.find((setup) => setup.id === args.setupId)
        const target = currentSetup
          ? getProjectSetupRuntimeTarget(currentSetup.hostId)
          : { kind: 'local' as const }
        await assertProjectHostSetupMutationRuntimeCapabilities(target)
        const result =
          target.kind === 'local'
            ? await window.api.projects.deleteHostSetup(args)
            : (
                await callRuntimeRpc<{ result: ProjectHostSetupDeleteResult }>(
                  target,
                  'projectHostSetup.delete',
                  args,
                  { timeoutMs: 15_000 }
                )
              ).result
        const repo = result.repo ? repoWithFetchedOwner(result.repo, target) : undefined
        const repoHostId = repo ? getRepoExecutionHostId(repo) : null
        set((s) => {
          const projectHostSetups = s.projectHostSetups.filter(
            (setup) => setup.id !== result.setup.id
          )
          const repos =
            repo && repoHostId
              ? s.repos.filter((entry) => !repoMatchesHostIdentity(entry, repo.id, repoHostId))
              : s.repos
          const projects =
            repo && !projectHostSetups.some((setup) => setup.projectId === result.project.id)
              ? s.projects.filter((project) => project.id !== result.project.id)
              : s.projects
          const survivingRepoIds = new Set(repos.map((r) => r.id))
          const removedRepoIds = s.repos.filter((r) => !survivingRepoIds.has(r.id)).map((r) => r.id)
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

    setupProjectClone: async (args) => {
      try {
        const parsedHost = parseExecutionHostId(args.hostId)
        const target = getProjectSetupRuntimeTarget(args.hostId)
        if (parsedHost?.kind !== 'ssh') {
          await assertProjectHostSetupMutationRuntimeCapabilities(target)
        }
        const repo =
          parsedHost?.kind === 'ssh'
            ? await window.api.repos.cloneRemote({
                connectionId: parsedHost.targetId,
                url: args.url,
                destination: args.destination
              })
            : target.kind === 'local'
              ? await window.api.repos.clone({
                  url: args.url,
                  destination: args.destination
                })
              : (
                  await callRuntimeRpc<{ repo: Repo }>(
                    target,
                    'repo.clone',
                    {
                      url: args.url,
                      destination: args.destination
                    },
                    { timeoutMs: 10 * 60_000 }
                  )
                ).repo
        return await get().setupProjectExistingFolder({
          projectId: args.projectId,
          hostId: args.hostId,
          path: repo.path,
          kind: 'git',
          displayName: args.displayName,
          setupMethod: 'cloned'
        })
      } catch (err) {
        console.error('Failed to clone project on host:', err)
        const message = err instanceof Error ? err.message : String(err)
        toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
          description: message,
          duration: ERROR_TOAST_DURATION
        })
        return null
      }
    }
  }
}
