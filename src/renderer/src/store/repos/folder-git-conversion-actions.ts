import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { translate } from '@/i18n/i18n'
import type { RepoSlice } from './repo-state'
import { ERROR_TOAST_DURATION } from './repo-state'
import { getAddRepoPathRouteSettings, repoWithFetchedOwner } from './owner-routing'
import { mergeProjectCompatibilityForHostRepoChange } from './repo-catalog-identity'

export function createFolderGitConversionActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'convertNonGitFolderToGit'> {
  return {
    convertNonGitFolderToGit: async ({ path, connectionId, runtimeEnvironmentId }) => {
      try {
        // Why: the active host can change while the confirmation dialog is open;
        // conversion must stay on the host that inspected the folder.
        const target = getActiveRuntimeTarget(
          getAddRepoPathRouteSettings(
            runtimeEnvironmentId === undefined ? undefined : { runtimeEnvironmentId },
            get().settings
          )
        )
        let repo: Repo
        if (connectionId) {
          // SSH folder: convert on the host via the connection's providers.
          const result = await window.api.repos.convertRemoteToGit({
            connectionId,
            remotePath: path
          })
          if ('error' in result) {
            throw new Error(result.error)
          }
          repo = result.repo
        } else if (target.kind === 'environment') {
          // Non-local runtime target: the folder lives on the runtime host.
          const result = await callRuntimeRpc<{ repo: Repo } | { error: string }>(
            target,
            'repo.convertToGit',
            { path },
            { timeoutMs: 60_000 }
          )
          if ('error' in result) {
            throw new Error(result.error)
          }
          repo = result.repo
        } else {
          const result = await window.api.repos.convertToGit({ path })
          if ('error' in result) {
            throw new Error(result.error)
          }
          repo = result.repo
        }
        repo = connectionId
          ? { ...repo, executionHostId: toSshExecutionHostId(connectionId) }
          : repoWithFetchedOwner(repo, target)
        const repoHostId = getRepoExecutionHostId(repo)
        set((s) => {
          const nextRepos = s.repos.some((entry) =>
            repoMatchesHostIdentity(entry, repo.id, repoHostId)
          )
            ? s.repos.map((entry) =>
                repoMatchesHostIdentity(entry, repo.id, repoHostId) ? repo : entry
              )
            : [...s.repos, repo]
          return {
            repos: nextRepos,
            ...mergeProjectCompatibilityForHostRepoChange({
              previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
              nextRepos,
              hostId: repoHostId
            }),
            folderWorkspacePathStatuses: {}
          }
        })
        await markOnboardingProjectAdded('addedRepo')
        toast.success(
          translate('auto.store.slices.repos.24424c2102', 'Converted to a Git repository'),
          {
            description: repo.displayName
          }
        )
        return repo
      } catch (err) {
        console.error('Failed to convert folder to git:', err)
        const message = err instanceof Error ? err.message : String(err)
        toast.error(
          translate(
            'auto.store.slices.repos.e6c1e9dba0',
            'Failed to convert folder to a Git repository'
          ),
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
