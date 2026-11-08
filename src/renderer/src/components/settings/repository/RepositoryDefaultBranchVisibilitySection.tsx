import type { DefaultBranchWorkspaceVisibility, Repo } from '../../../../../shared/repo-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

export function RepositoryDefaultBranchVisibilitySection({
  repo,
  updateRepo,
  forceVisible = false
}: {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: Pick<Repo, 'defaultBranchWorkspaceVisibility'>
  ) => void | Promise<boolean>
  forceVisible?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const title = t(
    'auto.components.settings.RepositoryDefaultBranchVisibilitySection.title',
    'Default Branch Workspace'
  )
  const description = t(
    'auto.components.settings.RepositoryDefaultBranchVisibilitySection.description',
    'Show or hide this project’s default branch workspace in the sidebar, regardless of the “Hide default branch” filter.'
  )
  const value = repo.defaultBranchWorkspaceVisibility ?? 'follow'
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[repo.displayName, 'default branch', 'main', 'hide', 'sidebar']}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <div className="space-y-1">
        <div className="text-sm font-semibold">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <SettingsSegmentedControl<DefaultBranchWorkspaceVisibility>
        value={value}
        onChange={(next) => {
          if (next !== value) {
            void updateRepo(repo.id, { defaultBranchWorkspaceVisibility: next })
          }
        }}
        ariaLabel={title}
        size="sm"
        options={[
          {
            value: 'follow',
            label: t(
              'auto.components.settings.RepositoryDefaultBranchVisibilitySection.follow',
              'Follow Sidebar Filter'
            )
          },
          {
            value: 'show',
            label: t(
              'auto.components.settings.RepositoryDefaultBranchVisibilitySection.show',
              'Always Show'
            )
          },
          {
            value: 'hide',
            label: t(
              'auto.components.settings.RepositoryDefaultBranchVisibilitySection.hide',
              'Always Hide'
            )
          }
        ]}
      />
    </SearchableSetting>
  )
}
