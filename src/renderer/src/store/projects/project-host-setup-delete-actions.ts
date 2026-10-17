import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { ProjectHostSetupDeleteResult } from '../../../../shared/project-types'
import { omitSparsePresetsForRepos } from '../slices/sparse-presets'
import { repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { pruneRemovedRepoWorktreeRows } from './project-host-setup-row-prune'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from '../repos/repo-state'
import { ERROR_TOAST_DURATION } from '../repos/repo-state'
import { adoptFromEndpoint } from '../adopt-from-endpoint'
import {
  assertProjectHostSetupMutationRuntimeCapabilities,
  getProjectSetupRuntimeTarget
} from './project-host-routing'

/** Delete actions split from project-host-setup-actions (max-lines 300). */
export function createProjectHostSetupDeleteActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'deleteProjectHostSetup'> {
  return {
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
        const repo = result.repo
          ? adoptFromEndpoint(target, { kind: 'repo', row: result.repo })
          : undefined
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
          // Why: this delete removes the repo from `repos` itself, so a later repos:changed refetch
          // no longer sees it; prune the deleted repo's rows here as removeProject does.
          const { rows: nextRows, changed: rowsChanged } = pruneRemovedRepoWorktreeRows(
            s,
            removedRepoIds,
            repo,
            repoHostId
          )
          // Why the guard includes removedRepoIds: even with no rows anywhere, presets and
          // selections for the removed ids still must be cleaned up below.
          if (removedRepoIds.length === 0 && !rowsChanged) {
            return { repos, projects, projectHostSetups }
          }
          return {
            repos,
            projects,
            projectHostSetups,
            ...omitSparsePresetsForRepos(s, removedRepoIds),
            ...nextRows,
            activeRepoId:
              s.activeRepoId && removedRepoIds.includes(s.activeRepoId) ? null : s.activeRepoId,
            filterRepoIds: s.filterRepoIds.filter((id) => !removedRepoIds.includes(id)),
            sortEpoch: s.sortEpoch + 1
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
    }
  }
}
