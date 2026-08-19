import type { Repo } from '../../../../shared/repo-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

type RepositorySubmoduleChangesSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: Pick<Repo, 'showSubmoduleChanges'>) => void
  forceVisible?: boolean
}

/** Per-repo opt-in for reading submodule rows out of a superproject that hides
 *  them. Git omits every submodule entry when `.gitmodules` sets `ignore = all`,
 *  so Source Control shows nothing for submodule work until this is on. */
export function RepositorySubmoduleChangesSection({
  repo,
  updateRepo,
  forceVisible
}: RepositorySubmoduleChangesSectionProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.RepositorySubmoduleChangesSection.title',
        'Show Submodule Changes'
      )}
      description={translate(
        'auto.components.settings.RepositorySubmoduleChangesSection.description',
        'Read submodule changes in Source Control even when this repo hides them.'
      )}
      keywords={searchKeywords([
        repo.displayName,
        { key: 'auto.components.settings.repository.search.submodule', fallback: 'submodule' },
        { key: 'auto.components.settings.repository.search.submodules', fallback: 'submodules' },
        { key: 'auto.components.settings.repository.search.gitmodules', fallback: 'gitmodules' },
        { key: 'auto.components.settings.repository.search.monorepo', fallback: 'monorepo' },
        { key: 'auto.components.settings.repository.search.gitlink', fallback: 'gitlink' }
      ])}
      forceVisible={forceVisible}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.RepositorySubmoduleChangesSection.title',
          'Show Submodule Changes'
        )}
        description={translate(
          'auto.components.settings.RepositorySubmoduleChangesSection.longDescription',
          'A repo whose .gitmodules sets ignore = all reports no submodule changes at all, so Source Control stays empty while you work inside a submodule. Turn this on to list them anyway. Each changed submodule adds one row you can expand for its per-file changes, including submodules whose recorded commit simply moved.'
        )}
        checked={repo.showSubmoduleChanges === true}
        onChange={() =>
          updateRepo(repo.id, { showSubmoduleChanges: repo.showSubmoduleChanges !== true })
        }
      />
    </SearchableSetting>
  )
}
