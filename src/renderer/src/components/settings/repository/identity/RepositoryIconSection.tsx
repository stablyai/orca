import type { Repo } from '../../../../../../shared/repository/repo-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { getRepositoryIconSectionId } from '../repository-settings-targets'
import { RepositoryIconPicker } from './RepositoryIconPicker'

export function RepositoryIconSection({
  repo,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  updateRepo: (repoId: string, updates: Partial<Repo>) => void
  forceVisible: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      title={t('auto.components.settings.RepositoryPane.e856e61455', 'Project icon')}
      description={t(
        'auto.components.settings.RepositoryPane.e641c359de',
        'Project icon and color used in the sidebar and tabs.'
      )}
      keywords={[
        repo.displayName,
        repo.path,
        'project icon',
        'repository icon',
        'color',
        'badge',
        'emoji',
        'favicon'
      ]}
      className="space-y-2 py-3"
      id={getRepositoryIconSectionId(repo.id)}
      forceVisible={forceVisible}
    >
      <RepositoryIconPicker repo={repo} updateRepo={updateRepo} />
    </SearchableSetting>
  )
}
