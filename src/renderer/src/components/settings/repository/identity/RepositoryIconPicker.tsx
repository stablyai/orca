import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import type { Repo } from '../../../../../../shared/repo-types'
import type { RepoIcon } from '../../../../../../shared/repo-icon'
import {
  DEFAULT_REPO_BADGE_COLOR,
  normalizeRepoBadgeColor
} from '../../../../../../shared/repo-badge-color'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { RepoIconGlyph, getRepoLucideIconOptions } from '../../../repo/repo-icon'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { useMountedRef } from '@/hooks/useMountedRef'
import { RepositoryIconColorSection } from './RepositoryIconColorSection'
import { RepositoryIconTabs } from './RepositoryIconTabs'
import {
  buildRepositoryGitHubAvatarUpdate,
  resolveRepositoryGitHubAvatar
} from '../../../../runtime/repository-github/repository-icon-github'
import { useTranslate, type Translate } from '@/i18n/use-translate'

function getRepositoryIconLabel(repoIcon: RepoIcon | null | undefined, t: Translate): string {
  if (repoIcon?.type === 'image') {
    if (repoIcon.source === 'github') {
      return t('auto.components.settings.RepositoryIconPicker.githubAvatar', 'GitHub avatar')
    }
    return (
      repoIcon.label ??
      t('auto.components.settings.RepositoryIconPicker.customImage', 'Custom image')
    )
  }
  if (repoIcon?.type === 'emoji') {
    return t('auto.components.settings.RepositoryIconPicker.emojiDescription', '{{emoji}} emoji', {
      emoji: repoIcon.emoji
    })
  }
  if (repoIcon?.type === 'lucide') {
    const label =
      getRepoLucideIconOptions().find((option) => option.name === repoIcon.name)?.label ??
      t('auto.components.repo.repo.icon.bed2674f9d', 'Folder')
    return t(
      'auto.components.settings.RepositoryIconPicker.lucideDescription',
      '{{label}} icon with repo color',
      { label }
    )
  }
  return t('auto.components.settings.RepositoryIconPicker.defaultIcon', 'Default')
}

export function RepositoryIconPicker({
  repo,
  websiteInput,
  updateRepo
}: {
  repo: Repo
  websiteInput?: { website: string; setWebsite: (value: string) => void }
  updateRepo: (repoId: string, updates: Partial<Repo>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [loadingGitHub, setLoadingGitHub] = useState(false)
  const [resetting, setResetting] = useState(false)
  const mountedRef = useMountedRef()
  // Resolve avatars/upstream on the selected repo owner, independent of focused host.
  const selectedHost = parseExecutionHostId(getRepoExecutionHostId(repo))
  const ownerEnvironmentId = selectedHost?.kind === 'runtime' ? selectedHost.environmentId : null
  const selectedLucideName = repo.repoIcon?.type === 'lucide' ? repo.repoIcon.name : null
  const selectedEmoji = repo.repoIcon?.type === 'emoji' ? repo.repoIcon.emoji : ''
  const selectedBadgeColor = normalizeRepoBadgeColor(repo.badgeColor) ?? DEFAULT_REPO_BADGE_COLOR
  const initialTab =
    repo.repoIcon?.type === 'emoji' ? 'emoji' : repo.repoIcon?.type === 'lucide' ? 'icon' : 'avatar'
  const runtimeTarget = useMemo(
    () => runtimeTargetForOwnerEnvironment(ownerEnvironmentId),
    [ownerEnvironmentId]
  )

  const currentIconLabel = getRepositoryIconLabel(repo.repoIcon, t)

  const setIcon = (repoIcon: RepoIcon | null) => updateRepo(repo.id, { repoIcon })
  const setBadgeColor = (badgeColor: string) => updateRepo(repo.id, { badgeColor })

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
            {t('auto.components.settings.RepositoryIconPicker.43bf3709dd', 'Repo icon')}
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
          {t('auto.components.settings.RepositoryIconPicker.549d126081', 'Reset')}
        </Button>
      </div>

      <RepositoryIconColorSection badgeColor={repo.badgeColor} onBadgeColorChange={setBadgeColor} />

      <RepositoryIconTabs
        websiteInput={websiteInput}
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
