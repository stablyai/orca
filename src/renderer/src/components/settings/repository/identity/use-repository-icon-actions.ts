import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  buildRepositoryGitHubAvatarUpdate,
  resolveRepositoryGitHubAvatar
} from '../../../../runtime/repository-github/repository-icon-github'
import { useTranslate } from '@/i18n/use-translate'

export type RepoAppearanceUpdate = Partial<Pick<Repo, 'repoIcon' | 'badgeColor' | 'upstream'>>

export type RepositoryIconActions = {
  loadingGitHub: boolean
  applyGitHubAvatar: () => Promise<void>
  resetToDefault: () => void
}

export function useRepositoryIconActions(
  repo: Repo,
  updateRepo: (repoId: string, updates: RepoAppearanceUpdate) => void
): RepositoryIconActions {
  const t = useTranslate()
  const [loadingGitHub, setLoadingGitHub] = useState(false)
  const mountedRef = useMountedRef()
  // Resolve avatars/upstream on the selected repo owner, independent of focused host.
  const selectedHost = parseExecutionHostId(getRepoExecutionHostId(repo))
  const ownerEnvironmentId = selectedHost?.kind === 'runtime' ? selectedHost.environmentId : null
  const runtimeTarget = useMemo(
    () => runtimeTargetForOwnerEnvironment(ownerEnvironmentId),
    [ownerEnvironmentId]
  )

  const resolveGitHubAvatar = useCallback(
    (options?: { forceLive?: boolean }) =>
      resolveRepositoryGitHubAvatar(runtimeTarget, repo, options),
    [runtimeTarget, repo]
  )

  const applyGitHubAvatar = async (): Promise<void> => {
    setLoadingGitHub(true)
    // Why: settle into a value instead of try/finally, which the React Compiler can't lower.
    const resolution = await resolveGitHubAvatar({ forceLive: true }).catch(() => null)
    if (!mountedRef.current) {
      return
    }
    setLoadingGitHub(false)
    if (!resolution) {
      toast.error(
        t(
          'auto.components.settings.RepositoryIconPicker.d71df44587',
          'Failed to resolve the GitHub repo.'
        )
      )
      return
    }
    if (!resolution.repoIcon) {
      toast.error(
        t(
          'auto.components.settings.RepositoryIconPicker.f79972271a',
          'No GitHub remote found for this repo.'
        )
      )
      return
    }
    const updates = buildRepositoryGitHubAvatarUpdate(repo, resolution)
    if (updates) {
      updateRepo(repo.id, updates)
    }
  }

  // The default mark is the project's letters, so resetting just clears the chosen icon.
  const resetToDefault = (): void => {
    updateRepo(repo.id, { repoIcon: null })
  }

  return { loadingGitHub, applyGitHubAvatar, resetToDefault }
}
