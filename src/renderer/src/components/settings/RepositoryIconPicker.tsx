import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import type { Repo } from '../../../../shared/types'
import { githubAvatarIcon, type RepoIcon } from '../../../../shared/repo-icon'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { RepoIconGlyph, getRepoLucideIconOptions } from '../repo/repo-icon'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useMountedRef } from '@/hooks/useMountedRef'
import { RepositoryIconColorSection } from './RepositoryIconColorSection'
import { RepositoryIconTabs } from './RepositoryIconTabs'
import {
  resolveRepositoryGitHubAvatarIcon,
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
  const activeRuntimeEnvironmentId = useAppStore(
    (state) => state.settings?.activeRuntimeEnvironmentId ?? null
  )
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

  const resolveGitHubAvatarIcon = useCallback(
    () => resolveRepositoryGitHubAvatarIcon(runtimeTarget, repo),
    [runtimeTarget, repo]
  )

  const handleUseGitHubAvatar = async () => {
    setLoadingGitHub(true)
    try {
      const icon = await resolveGitHubAvatarIcon()
      if (!mountedRef.current) {
        return
      }
      if (!icon) {
        toast.error(
          translate(
            'auto.components.settings.RepositoryIconPicker.f79972271a',
            'No GitHub remote found for this repo.'
          )
        )
        return
      }
      setIcon(icon)
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
      const icon = await resolveGitHubAvatarIcon().catch(() => null)
      if (!mountedRef.current) {
        return
      }
      setIcon(icon)
    } finally {
      if (mountedRef.current) {
        setResetting(false)
      }
    }
  }

  const upstreamBackfilledRef = useRef<string | null>(null)
  useEffect(() => {
    if (repo.upstream !== undefined || upstreamBackfilledRef.current === repo.id) {
      return
    }
    upstreamBackfilledRef.current = repo.id
    let cancelled = false
    void (async () => {
      let upstream
      try {
        upstream = await resolveUpstreamLive()
      } catch {
        return
      }
      if (cancelled || !mountedRef.current) {
        return
      }
      const updates: Partial<Repo> = { upstream: upstream ?? null }
      if (upstream && repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github') {
        updates.repoIcon = githubAvatarIcon(upstream)
      }
      updateRepo(repo.id, updates)
    })()
    return () => {
      cancelled = true
    }
  }, [repo.id, repo.upstream, repo.repoIcon, resolveUpstreamLive, updateRepo, mountedRef])

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
