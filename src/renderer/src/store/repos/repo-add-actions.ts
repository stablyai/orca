import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { resolveDismissedOnboardingFolderAgentLaunch } from '@/lib/onboarding-folder-agent-startup'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { RepoSlice } from './repo-state'
import { ERROR_TOAST_DURATION } from './repo-state'
import {
  fetchRuntimeAddProjectPathStatus,
  getAddRepoPathRouteSettings,
  getRuntimeEnvironmentDisplayName,
  repoWithFetchedOwner
} from './owner-routing'
import { mergeProjectCompatibilityForHostRepoChange } from './repo-catalog-identity'
import { warnIfProjectKnownInAnotherProfile } from '../projects/project-profile-presence'
import { warnIfProjectCrossesWslFilesystemBoundary } from '../projects/project-wsl-filesystem-boundary-advisory'

export function createRepoAddActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'addRepoPath' | 'addRepo' | 'addNonGitFolder'> {
  return {
    addRepoPath: async (path, kind = 'git', options) => {
      try {
        const target = getActiveRuntimeTarget(getAddRepoPathRouteSettings(options, get().settings))
        const displayName = options?.displayName?.trim() || undefined
        let repo: Repo
        try {
          if (target.kind === 'local') {
            const result = await window.api.repos.add({
              path,
              kind,
              ...(displayName ? { displayName } : {})
            })
            if ('error' in result) {
              throw new Error(result.error)
            }
            repo = result.repo
          } else {
            repo = (
              await callRuntimeRpc<{ repo: Repo }>(
                target,
                'repo.add',
                { path, kind, ...(displayName ? { displayName } : {}) },
                { timeoutMs: 15_000 }
              )
            ).repo
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (kind !== 'git' || !message.includes('Not a valid git repository')) {
            throw err
          }
          if (target.kind !== 'local') {
            const status = await fetchRuntimeAddProjectPathStatus({ target, path })
            if (status?.exists !== true) {
              const hostName = getRuntimeEnvironmentDisplayName(get(), target.environmentId)
              toast.error(
                translate(
                  'auto.store.slices.repos.3be0f7df04',
                  'Cannot open folder on selected runtime'
                ),
                {
                  description: translate(
                    'auto.store.slices.repos.15cf5319ec',
                    '{{path}} was checked on {{hostName}}, but that host did not report a usable folder.',
                    { path, hostName }
                  ),
                  duration: ERROR_TOAST_DURATION
                }
              )
              return null
            }
          }
          // Why: folder mode is a capability downgrade (no worktrees/SCM/PRs/checks), so confirm via dialog rather than silently falling back.
          const { openModal } = get()
          openModal('confirm-non-git-folder', {
            folderPath: path,
            ...(displayName ? { displayName } : {}),
            ...(target.kind === 'environment' ? { runtimeEnvironmentId: target.environmentId } : {})
          })
          return null
        }
        repo = repoWithFetchedOwner(repo, target)
        const repoIdentity = getRepoHostIdentity(repo)
        const alreadyAdded = get().repos.some((r) => getRepoHostIdentity(r) === repoIdentity)
        if (alreadyAdded) {
          get().clearOrcaHookTrustForRepo(repo.id)
        }
        set((s) => {
          if (s.repos.some((r) => getRepoHostIdentity(r) === repoIdentity)) {
            return s
          }
          const nextRepos = [...s.repos, repo]
          const hostId = getRepoExecutionHostId(repo)
          return {
            repos: nextRepos,
            ...mergeProjectCompatibilityForHostRepoChange({
              previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
              nextRepos,
              hostId
            }),
            folderWorkspacePathStatuses: {}
          }
        })
        if (alreadyAdded) {
          toast.info(translate('auto.store.slices.repos.a8e4b3af5b', 'Project already added'), {
            description: repo.displayName
          })
        } else {
          toast.success(
            isGitRepoKind(repo)
              ? translate('auto.store.slices.repos.8bb3ad7935', 'Project added')
              : translate('auto.store.slices.repos.90d129b48b', 'Folder added'),
            {
              description: repo.displayName
            }
          )
          // Why: the cross-profile advisory applies to SSH-added projects too; the presence lookup already keys on connection/host.
          await warnIfProjectKnownInAnotherProfile(repo, get().activeOrcaProfileId)
          // Why after the set(): the project row carrying the runtime override only exists once the repo is in state.
          warnIfProjectCrossesWslFilesystemBoundary(repo, get().projects, get().settings)
        }
        return repo
      } catch (err) {
        console.error('Failed to add project:', err)
        const message = err instanceof Error ? err.message : String(err)
        const duration = ERROR_TOAST_DURATION
        toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
          description: message,
          duration
        })
        return null
      }
    },

    addRepo: async () => {
      const target = getActiveRuntimeTarget(get().settings)
      if (target.kind !== 'local') {
        // Why: OS folder pickers return client-local paths; remote environments need an explicit host path (Add Project dialog).
        toast.error(
          translate(
            'auto.store.slices.repos.e649269645',
            'Use Add Project to enter a path on the selected host.'
          )
        )
        return null
      }
      const path = await window.api.repos.pickFolder()
      if (!path) {
        return null
      }
      return get().addRepoPath(path)
    },

    addNonGitFolder: async (path, options) => {
      try {
        const hadProjectBeforeAdd = get().repos.length > 0
        const repo = await get().addRepoPath(path, 'folder', options)
        if (!repo) {
          return null
        }
        await markOnboardingProjectAdded('addedFolder')
        // Why: focus the new folder so the add is visible; lazy-import worktree-activation to avoid a circular module load (it imports the store root).
        const executionHostId =
          options?.runtimeEnvironmentId === undefined
            ? undefined
            : options.runtimeEnvironmentId
              ? toRuntimeExecutionHostId(options.runtimeEnvironmentId)
              : LOCAL_EXECUTION_HOST_ID
        await get().fetchWorktrees(repo.id, executionHostId ? { executionHostId } : undefined)
        const folderWorktree = get().worktreesByRepo[repo.id]?.find(
          (worktree) => executionHostId === undefined || worktree.hostId === executionHostId
        )
        if (folderWorktree) {
          const { activateAndRevealWorktree } = await import('../../lib/worktree-activation')
          const onboarding = await window.api.onboarding.get().catch(() => null)
          // Why: adding the first folder from Landing skips onboarding's completeRepo hook; carry the default agent into the first terminal here.
          const launch = resolveDismissedOnboardingFolderAgentLaunch({
            settings: get().settings,
            onboarding,
            hasExistingProject: hadProjectBeforeAdd,
            executionHostId: executionHostId ?? LOCAL_EXECUTION_HOST_ID,
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
              repo.connectionId
            )
          })
          activateAndRevealWorktree(folderWorktree.id, {
            sidebarRevealBehavior: 'auto',
            ...(executionHostId ? { executionHostId } : {}),
            ...(launch.startup ? { startup: launch.startup } : {}),
            ...(launch.route === 'structured-native-chat' ? { providesInitialSurface: true } : {})
          })
          if (launch.route === 'structured-native-chat' && launch.agent === 'codex') {
            const [{ startStructuredCodexLaunch }, { StructuredAgentSessionCreateRefusalError }] =
              await Promise.all([
                import('@/lib/structured-agent-session-launch'),
                import('@/lib/launch-structured-codex-session')
              ])
            const structured = startStructuredCodexLaunch(folderWorktree.id)
            const fallback = structured.claimDefinitiveRefusalFallback(() => {
              activateAndRevealWorktree(folderWorktree.id, {
                sidebarRevealBehavior: 'auto',
                ...(executionHostId ? { executionHostId } : {}),
                ...(launch.fallbackStartup ? { startup: launch.fallbackStartup } : {})
              })
            })
            try {
              await structured.launchResult
            } catch (error) {
              if (error instanceof StructuredAgentSessionCreateRefusalError) {
                await fallback
              }
            }
          }
        }
        return repo
      } catch (err) {
        console.error('Failed to add folder:', err)
        const message = err instanceof Error ? err.message : String(err)
        toast.error(translate('auto.store.slices.repos.b7e14472ae', 'Failed to add folder'), {
          description: message,
          duration: ERROR_TOAST_DURATION
        })
        return null
      }
    }
  }
}
