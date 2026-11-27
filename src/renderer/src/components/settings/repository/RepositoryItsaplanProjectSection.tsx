import { useEffect, useMemo, useState } from 'react'
import type { Repo } from '../../../../../shared/repo-types'
import type { ItsaplanProjectReference } from '../../../../../shared/itsaplan/itsaplan-project-reference'
import type { ItsaplanProject } from '../../../../../shared/itsaplan/itsaplan-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import { WorkItemScopePicker, type WorkItemScopeOption } from '../../work-item-scope-picker'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../search/settings-search-keywords'

export function getRepositoryItsaplanSearchEntry(repo: Repo, t: Translate = translate) {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return {
    title: t('components.RepositoryItsaplanProjectSection.title', "Default It's a Plan project"),
    description: t(
      'components.RepositoryItsaplanProjectSection.description',
      "Default the It's a Plan issue list to this project. You can change it for each worktree."
    ),
    keywords: [
      repo.displayName,
      ...translateSearchKeyword(
        'components.RepositoryItsaplanProjectSection.keywordItsaplan',
        'itsaplan'
      ),
      ...translateSearchKeyword(
        'components.RepositoryItsaplanProjectSection.keywordDefaultProject',
        'default project'
      )
    ]
  }
}

export function RepositoryItsaplanProjectSection({
  repo,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  updateRepo: (
    id: string,
    updates: { defaultItsaplanProject: ItsaplanProjectReference | null }
  ) => unknown
  forceVisible?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const instanceId = useAppStore((s) => s.itsaplanStatus?.instance?.id ?? null)
  const loadItsaplanProjects = useAppStore((s) => s.loadItsaplanProjects)
  const [projects, setProjects] = useState<ItsaplanProject[]>([])
  const [loading, setLoading] = useState(instanceId !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (instanceId === null) {
      return
    }
    let cancelled = false
    loadItsaplanProjects()
      .then((loaded) => {
        if (!cancelled) {
          setProjects(loaded)
          setError(null)
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [instanceId, loadItsaplanProjects])

  const options = useMemo<WorkItemScopeOption<ItsaplanProjectReference>[]>(
    () =>
      instanceId === null
        ? []
        : projects.map((project) => ({
            key: project.ref,
            value: { instanceId, projectRef: project.ref, projectKey: project.key },
            label: `${project.key} — ${project.name}`,
            searchText: `${project.key} ${project.name}`
          })),
    [instanceId, projects]
  )
  const saved = repo.defaultItsaplanProject ?? null
  const savedProject = saved ? projects.find((project) => project.ref === saved.projectRef) : null

  const applyProject = async (project: ItsaplanProjectReference | null) => {
    setSaving(true)
    setError(null)
    try {
      const result = await updateRepo(repo.id, { defaultItsaplanProject: project })
      if (result === false) {
        throw new Error(
          t(
            'components.RepositoryItsaplanProjectSection.saveFailed',
            "Could not save the default It's a Plan project."
          )
        )
      }
      const echoed = useAppStore
        .getState()
        .repos.find(
          (entry) =>
            entry.id === repo.id && getRepoExecutionHostId(entry) === getRepoExecutionHostId(repo)
        )?.defaultItsaplanProject
      if (
        (echoed?.projectRef ?? null) !== (project?.projectRef ?? null) ||
        (echoed?.instanceId ?? null) !== (project?.instanceId ?? null)
      ) {
        throw new Error(
          t(
            'components.RepositoryItsaplanProjectSection.runtimeUpdate',
            "Update this runtime to save a default It's a Plan project."
          )
        )
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  const entry = getRepositoryItsaplanSearchEntry(repo, t)
  const label = entry.title
  return (
    <SearchableSetting
      title={label}
      description={entry.description}
      keywords={entry.keywords}
      forceVisible={forceVisible}
      className="space-y-2 py-3"
    >
      <p className="text-sm font-semibold">{label}</p>
      <WorkItemScopePicker
        options={options}
        selectedKey={saved?.projectRef ?? null}
        selectedLabel={
          saved ? `${saved.projectKey} — ${savedProject?.name ?? ''}`.trim() : undefined
        }
        onChange={(project) => void applyProject(project)}
        label={label}
        allLabel={t('components.RepositoryItsaplanProjectSection.none', 'No default project')}
        searchPlaceholder={t(
          'components.RepositoryItsaplanProjectSection.search',
          "Search It's a Plan projects"
        )}
        emptyLabel={t('components.RepositoryItsaplanProjectSection.empty', 'No projects found.')}
        disabled={loading || saving || instanceId === null}
      />
      {instanceId === null ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'components.RepositoryItsaplanProjectSection.connect',
            "Connect It's a Plan in Integrations to choose a project."
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
