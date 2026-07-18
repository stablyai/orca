import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import type { Repo } from '../../../../shared/types'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { RepoIconGlyph, getRepoLucideIconOptions } from '../repo/repo-icon'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { useMountedRef } from '@/hooks/useMountedRef'
import { RepositoryIconColorSection } from './RepositoryIconColorSection'
import { RepositoryIconTabs } from './RepositoryIconTabs'
import {
  buildRepositoryGitHubAvatarUpdate,
  resolveRepositoryGitHubAvatar,
  resolveRepositoryUpstreamLive
} from './repository-icon-github'
import { translate } from '@/i18n/i18n'

export function RepositoryIconPicker({
  repo,
  updateRepo
}: {
  repo: Repo
  updateRepo: (repoId: string, updates: Partial<Repo>) => void
}): React.JSX.Element {
  const [loadingGitHub, setLoadingGitHub] = useState(false)
  const [resetting, setResetting] = useState(false)
  const mountedRef = useMountedRef()
  // Why: resolve this repo's upstream/avatar on the host that owns it, not the
  // focused runtime.
  const selectedHost = parseExecutionHostId(getRepoExecutionHostId(repo))
  const activeRuntimeEnvironmentId =
    selectedHost?.kind === 'runtime' ? selectedHost.environmentId : null
  const selectedLucideName = repo.repoIcon?.type === 'lucide' ? repo.repoIcon.name : null
  const selectedEmoji = repo.repoIcon?.type === 'emoji' ? repo.repoIcon.emoji : ''
  const selectedBadgeColor = normalizeRepoBadgeColor(repo.badgeColor) ?? DEFAULT_REPO_BADGE_COLOR
  const initialTab =
    repo.repoIcon?.type === 'emoji' ? 'emoji' : repo.repoIcon?.type === 'lucide' ? 'icon' : 'avatar'
  const runtimeTarget = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId }),
    [activeRuntimeEnvironmentId]
  )

  const currentIconLabel = useMemo(() => {
    if (repo.repoIcon?.type === 'image') {
      if (repo.repoIcon.source === 'github') {
        return 'GitHub avatar'
      }
      return repo.repoIcon.label ?? 'Custom image'
    }
    if (repo.repoIcon?.type === 'emoji') {
      return `${repo.repoIcon.emoji} emoji`
    }
    if (repo.repoIcon?.type === 'lucide') {
      const label =
        getRepoLucideIconOptions().find((option) => option.name === selectedLucideName)?.label ??
        'Folder'
      return `${label} icon with repo color`
    }
    return 'Default'
  }, [repo.repoIcon, selectedLucideName])

  const setIcon = (repoIcon: RepoIcon | null) => updateRepo(repo.id, { repoIcon })
  const setBadgeColor = (badgeColor: string) => updateRepo(repo.id, { badgeColor })

  const resolveUpstreamLive = useCallback(
    () => resolveRepositoryUpstreamLive(runtimeTarget, repo),
    [runtimeTarget, repo]
  )

  const resolveGitHubAvatar = useCallback(
    (options?: { forceLive?: boolean }) =>
      resolveRepositoryGitHubAvatar(runtimeTarget, repo, options),
    [runtimeTarget, repo]
  )

  const handleUseGitHubAvatar = async () => {
    setLoadingGitHub(true)
    try {
      const resolution = await resolveGitHubAvatar({ forceLive: true })
      if (!mountedRef.current) {
        return
      }
      if (!resolution.repoIcon) {
        toast.error(
          translate(
            'auto.components.settings.RepositoryIconPicker.f79972271a',
            'No GitHub remote found for this repo.'
          )
        )
        return
      }
      // A null build means the stored icon/upstream already match — nothing to write.
      const updates = buildRepositoryGitHubAvatarUpdate(repo, resolution)
      if (updates) {
        updateRepo(repo.id, updates)
      }
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate(
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

  const handleResetToDefault = async () => {
    setResetting(true)
    try {
      const resolution = await resolveGitHubAvatar({ forceLive: true }).catch(() => null)
      if (!mountedRef.current) {
        return
      }
      const updates = resolution
        ? buildRepositoryGitHubAvatarUpdate(repo, resolution, { clearMissingIcon: true })
        : { repoIcon: null }
      if (updates) {
        updateRepo(repo.id, updates)
      }
    } finally {
      if (mountedRef.current) {
        setResetting(false)
      }
    }
  }

  const githubIdentityRefreshedRef = useRef<string | null>(null)
  useEffect(() => {
    const hasGitHubAvatar = repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github'
    const shouldRefresh = hasGitHubAvatar || repo.upstream === undefined
    if (!shouldRefresh || githubIdentityRefreshedRef.current === repo.id) {
      return
    }
    githubIdentityRefreshedRef.current = repo.id
    let cancelled = false
    void (async () => {
      let updates: Partial<Repo> | null
      try {
        if (hasGitHubAvatar) {
          // Why: stored upstream/icon metadata can outlive a GitHub repo transfer.
          // Refresh only when settings opens for the affected GitHub-avatar repo.
          const resolution = await resolveGitHubAvatar({ forceLive: true })
          updates = buildRepositoryGitHubAvatarUpdate(repo, resolution)
        } else {
          const upstream = await resolveUpstreamLive()
          updates = { upstream: upstream ?? null }
        }
      } catch {
        return
      }
      if (cancelled || !mountedRef.current || !updates) {
        return
      }
      updateRepo(repo.id, updates)
    })()
    return () => {
      cancelled = true
    }
  }, [repo, resolveGitHubAvatar, resolveUpstreamLive, updateRepo, mountedRef])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <RepoIconGlyph
          repoIcon={repo.repoIcon}
          color={selectedBadgeColor}
          className="size-10 shrink-0 rounded-md border border-border/70 bg-muted/30"
          iconClassName="size-5"
        />
        <div className="min-w-0 flex-1">
          <Label className="text-sm font-semibold">
            {translate('auto.components.settings.RepositoryIconPicker.4e2a14f967', 'Repo Icon')}
          </Label>
          <div className="mt-1 truncate text-xs text-muted-foreground">{currentIconLabel}</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={resetting}
          onClick={() => void handleResetToDefault()}
        >
          <RotateCcw className="size-3.5" />
          {translate('auto.components.settings.RepositoryIconPicker.549d126081', 'Reset')}
        </Button>
      </div>

      <RepositoryIconColorSection badgeColor={repo.badgeColor} onBadgeColorChange={setBadgeColor} />

      <RepositoryIconTabs
        initialTab={initialTab}
        selectedLucideName={selectedLucideName}
        selectedEmoji={selectedEmoji}
        loadingGitHub={loadingGitHub}
        onSetIcon={setIcon}
        onUseGitHubAvatar={() => void handleUseGitHubAvatar()}
      />
    </div>
  )
}
