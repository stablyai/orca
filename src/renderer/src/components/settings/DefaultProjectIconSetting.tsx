import type React from 'react'
import { Github } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'
import { Label } from '../ui/label'
import { RepoIconGlyph, getRepoLucideIconOptions } from '../repo/repo-icon'
import { RepositoryIconColorSection } from './RepositoryIconColorSection'
import { RepositoryIconTabs } from './RepositoryIconTabs'
import { translate } from '@/i18n/i18n'

type DefaultProjectIconSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function getDefaultProjectIconLabel(defaultProjectIcon: RepoIcon | null): string {
  if (defaultProjectIcon?.type === 'emoji') {
    return translate(
      'auto.components.settings.DefaultProjectIconSetting.emojiSelection',
      '{{value0}} emoji',
      { value0: defaultProjectIcon.emoji }
    )
  }
  if (defaultProjectIcon?.type === 'lucide') {
    const option = getRepoLucideIconOptions().find(({ name }) => name === defaultProjectIcon.name)
    return translate(
      'auto.components.settings.DefaultProjectIconSetting.iconSelection',
      '{{value0}} icon',
      {
        value0: option?.label ?? translate('auto.components.repo.repo.icon.bed2674f9d', 'Folder')
      }
    )
  }
  if (defaultProjectIcon?.type === 'image') {
    return (
      defaultProjectIcon.label ??
      translate('auto.components.settings.DefaultProjectIconSetting.customImage', 'Custom image')
    )
  }
  return translate(
    'auto.components.settings.DefaultProjectIconSetting.githubAvatar',
    'GitHub owner avatar'
  )
}

/**
 * The global fallback icon. Same tabs as a project's own picker, so the two read as one control:
 * whatever is chosen here fills in for projects that have no icon of their own.
 */
export function DefaultProjectIconSetting({
  settings,
  updateSettings
}: DefaultProjectIconSettingProps): React.JSX.Element {
  const defaultProjectIcon = settings.defaultProjectIcon ?? null
  const title = translate(
    'auto.components.settings.DefaultProjectIconSetting.title',
    'Default Project Icon'
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {defaultProjectIcon ? (
          <RepoIconGlyph
            repoIcon={defaultProjectIcon}
            color={settings.defaultProjectIconColor ?? DEFAULT_REPO_BADGE_COLOR}
            className="size-10 shrink-0 rounded-md border border-border/70 bg-muted/30"
            iconClassName="size-5"
          />
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground">
            <Github className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <Label className="text-sm font-semibold">{title}</Label>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.DefaultProjectIconSetting.description',
              'Shown for projects with no icon of their own. Icons you pick per project still win.'
            )}
          </div>
        </div>
        <div className="shrink-0 text-xs text-muted-foreground">
          {getDefaultProjectIconLabel(defaultProjectIcon)}
        </div>
      </div>

      {defaultProjectIcon?.type === 'lucide' ? (
        <RepositoryIconColorSection
          badgeColor={settings.defaultProjectIconColor}
          onBadgeColorChange={(defaultProjectIconColor) =>
            updateSettings({ defaultProjectIconColor })
          }
        />
      ) : null}

      <RepositoryIconTabs
        initialTab={
          defaultProjectIcon?.type === 'emoji'
            ? 'emoji'
            : defaultProjectIcon?.type === 'lucide'
              ? 'icon'
              : 'avatar'
        }
        selectedLucideName={defaultProjectIcon?.type === 'lucide' ? defaultProjectIcon.name : null}
        selectedEmoji={defaultProjectIcon?.type === 'emoji' ? defaultProjectIcon.emoji : ''}
        loadingGitHub={false}
        onSetIcon={(icon) => updateSettings({ defaultProjectIcon: icon })}
        // Why: there is no global avatar to fetch — the Avatar tab means "leave each project on the
        // GitHub owner avatar auto-detect found", which is exactly an empty default.
        onUseGitHubAvatar={() => updateSettings({ defaultProjectIcon: null })}
      />
    </div>
  )
}
