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
  resetting: boolean
  applyGitHubAvatar: () => Promise<void>
  resetToDefault: () => Promise<void>
}

export function useRepositoryIconActions(
  repo: Repo,
  updateRepo: (repoId: string, updates: RepoAppearanceUpdate) => void
): RepositoryIconActions {
  const t = useTranslate()
  const [loadingGitHub, setLoadingGitHub] = useState(false)
  const [resetting, setResetting] = useState(false)
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
    try {
      const resolution = await resolveGitHubAvatar({ forceLive: true })
      if (!mountedRef.current) {
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
    } catch {
      if (mountedRef.current) {
        toast.error(
          t(
            'auto.components.settings.RepositoryIconPicker.d71df44587',
            'Failed to resolve the GitHub repo.'
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setLoadingGitHub(false)
      }
    }
  }

  // The default mark is the project's letters, so resetting just clears the chosen icon.
  const resetToDefault = async (): Promise<void> => {
    setResetting(true)
    try {
      updateRepo(repo.id, { repoIcon: null })
    } finally {
      setResetting(false)
    }
  }

  return { loadingGitHub, resetting, applyGitHubAvatar, resetToDefault }
}
