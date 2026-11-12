import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { setProjectHidden } from '@/components/sidebar/hidden-projects/set-project-hidden'
import { isRepoHidden } from '../../../../../shared/hidden-projects'
import type { Repo } from '../../../../../shared/repo-types'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import type { SettingsSearchEntry } from '../search/settings-search'

export function RepositorySidebarVisibilitySection({
  repo,
  searchEntry,
  forceVisible
}: {
  repo: Repo
  searchEntry: SettingsSearchEntry
  forceVisible: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      title={searchEntry.title}
      description={searchEntry.description}
      keywords={searchEntry.keywords}
      forceVisible={forceVisible}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold">{searchEntry.title}</div>
          <p className="text-xs text-muted-foreground">{searchEntry.description}</p>
        </div>
        <Switch
          checked={isRepoHidden(repo)}
          onCheckedChange={(checked) => void setProjectHidden(repo, checked)}
          aria-label={t(
            'sidebar.hiddenProjects.settingsToggleLabel',
            'Hide {{name}} from the sidebar',
            {
              name: repo.displayName
            }
          )}
        />
      </div>
    </SearchableSetting>
  )
}
