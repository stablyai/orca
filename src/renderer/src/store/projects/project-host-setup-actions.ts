import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  ProjectHostSetupCreateResult,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateResult
} from '../../../../shared/project-types'
import { repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from '../repos/repo-state'
import { ERROR_TOAST_DURATION } from '../repos/repo-state'
import { adoptFromEndpoint } from '../adopt-from-endpoint'
import { normalizeProjectRow } from '../../../../shared/project-catalog-row-normalization'
import { createProjectHostSetupDeleteActions } from './project-host-setup-delete-actions'
import {
  assertProjectHostSetupMutationRuntimeCapabilities,
  getProjectSetupRuntimeTarget
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
    ...createProjectHostSetupDeleteActions(set, get),

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
        const setup = adoptFromEndpoint(target, {
          kind: 'projectHostSetup',
          row: result.setup
        })
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
        const setup = adoptFromEndpoint(target, {
          kind: 'projectHostSetup',
          row: result.setup
        })
        const project = normalizeProjectRow(result.project)
        const repo = result.repo
          ? adoptFromEndpoint(target, { kind: 'repo', row: result.repo })
          : undefined
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

    setupProjectClone: async (args) => {
      try {
        const parsedHost = parseExecutionHostId(args.hostId)
        // Why: an SSH host clones only through its paired server; never fall back to this computer.
        if (parsedHost?.kind === 'ssh') {
          throw new Error(`SSH connection "${parsedHost.targetId}" not found or not connected`)
        }
        const target = getProjectSetupRuntimeTarget(args.hostId)
        await assertProjectHostSetupMutationRuntimeCapabilities(target)
        const repo =
          target.kind === 'local'
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
