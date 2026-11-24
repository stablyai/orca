import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RepoIcon } from '../../../../../../shared/repository/appearance/repo-icon'
import { RotateCcw } from 'lucide-react'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { getRepoLucideIconOptions } from '../../../repo/repo-icon'
import { RepoMarkTile, useRepoMarkAppearance } from '../../../repo/RepoMark'
import { RepositoryIconColorSection } from './RepositoryIconColorSection'
import { RepositoryIconTabs } from './RepositoryIconTabs'
import { LettersPanel } from '../../../repo/project-peek/ProjectIconStylePanels'
import { useRepositoryIconActions, type RepoAppearanceUpdate } from './use-repository-icon-actions'
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
  if (repoIcon?.type === 'letters') {
    return t(
      'auto.components.settings.RepositoryIconPicker.lettersDescription',
      'Letters “{{text}}”',
      {
        text: repoIcon.text
      }
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
  updateRepo
}: {
  repo: Repo
  updateRepo: (repoId: string, updates: RepoAppearanceUpdate) => void
}): React.JSX.Element {
  const t = useTranslate()
  const actions = useRepositoryIconActions(repo, updateRepo)
  const appearance = useRepoMarkAppearance(repo)
  const selectedLucideName = repo.repoIcon?.type === 'lucide' ? repo.repoIcon.name : null
  const selectedEmoji = repo.repoIcon?.type === 'emoji' ? repo.repoIcon.emoji : ''
  const initialTab =
    repo.repoIcon == null || repo.repoIcon.type === 'letters'
      ? 'letters'
      : repo.repoIcon?.type === 'emoji'
        ? 'emoji'
        : repo.repoIcon?.type === 'lucide'
          ? 'icon'
          : 'avatar'
  const currentIconLabel = getRepositoryIconLabel(appearance.icon, t)

  const setIcon = (repoIcon: RepoIcon | null) => updateRepo(repo.id, { repoIcon })
  const setBadgeColor = (badgeColor: string) => updateRepo(repo.id, { badgeColor })

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {/* Preview the resolved sidebar mark so auto colors and clash boxes match the cards. */}
        <RepoMarkTile appearance={appearance} />
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
          disabled={actions.resetting}
          onClick={() => void actions.resetToDefault()}
        >
          <RotateCcw className="size-3.5" />
          {t('auto.components.settings.RepositoryIconPicker.549d126081', 'Reset')}
        </Button>
      </div>

      <RepositoryIconColorSection badgeColor={repo.badgeColor} onBadgeColorChange={setBadgeColor} />

      <RepositoryIconTabs
        initialTab={initialTab}
        lettersPanel={<LettersPanel repo={repo} color={appearance.color} onSetIcon={setIcon} />}
        selectedLucideName={selectedLucideName}
        selectedEmoji={selectedEmoji}
        loadingGitHub={actions.loadingGitHub}
        onSetIcon={setIcon}
        onUseGitHubAvatar={() => void actions.applyGitHubAvatar()}
      />
    </div>
  )
}
