import { useMemo, useState } from 'react'
import type { Repo } from '../../../../../shared/repo-types'
import type { JiraProjectReference } from '../../../../../shared/jira-project-reference'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
import { useAppStore } from '@/store/index'
import { useJiraProjectInventory } from '../../use-jira-project-inventory'
import { JiraProjectPicker } from '../../jira-project-picker'
import { SearchableSetting } from '../SearchableSetting'
import { translate } from '@/i18n/i18n'

export function RepositoryJiraProjectSection({
  repo,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  updateRepo: (id: string, updates: { defaultJiraProject: JiraProjectReference | null }) => unknown
  forceVisible?: boolean
}): React.JSX.Element {
  const hostId = getRepoExecutionHostId(repo)
  const source = useMemo(() => taskSourceRuntimeTarget({ hostId }), [hostId])
  const inventory = useJiraProjectInventory(source, true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const applyProject = async (project: JiraProjectReference | null) => {
    setSaving(true)
    setError(null)
    try {
      const result = await updateRepo(repo.id, { defaultJiraProject: project })
      if (result === false) {
        throw new Error(
          translate(
            'components.RepositoryJiraProjectSection.saveFailed',
            'Could not save the default Jira project.'
          )
        )
      }
      const echoed = useAppStore
        .getState()
        .repos.find(
          (entry) => entry.id === repo.id && getRepoExecutionHostId(entry) === hostId
        )?.defaultJiraProject
      if (
        (echoed?.id ?? null) !== (project?.id ?? null) ||
        (echoed?.siteId ?? null) !== (project?.siteId ?? null)
      ) {
        throw new Error(
          translate(
            'components.RepositoryJiraProjectSection.runtimeUpdate',
            'Update this runtime to save a default Jira project.'
          )
        )
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }
  const label = translate('components.RepositoryJiraProjectSection.title', 'Default Jira project')
  return (
    <SearchableSetting
      title={label}
      description={translate(
        'components.RepositoryJiraProjectSection.description',
        'Default the Jira issue picker and Tasks list to this project. You can change it for each worktree.'
      )}
      keywords={['jira', 'project', repo.displayName]}
      forceVisible={forceVisible}
      className="space-y-2"
    >
      <p className="text-sm font-semibold">{label}</p>
      <JiraProjectPicker
        projects={inventory.projects}
        value={repo.defaultJiraProject ?? null}
        onChange={(project) => void applyProject(project)}
        label={label}
        emptyLabel={translate('components.RepositoryJiraProjectSection.none', 'No default project')}
        disabled={inventory.loading || saving}
      />
      {!inventory.loading && !inventory.connected && !inventory.error ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'components.RepositoryJiraProjectSection.connect',
            'Connect Jira in Integrations to choose a project.'
          )}
        </p>
      ) : null}
      {error || inventory.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? inventory.error}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
