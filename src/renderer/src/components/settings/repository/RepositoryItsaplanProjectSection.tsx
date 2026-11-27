import { useEffect, useMemo, useState } from 'react'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { ItsaplanProjectReference } from '../../../../../shared/itsaplan/itsaplan-project-reference'
import type { ItsaplanProject } from '../../../../../shared/itsaplan/itsaplan-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { taskSourceRuntimeTarget } from '@/lib/work-items/task-source-runtime-target'
import { createItsaplanClientForTarget } from '@/runtime/itsaplan/runtime-itsaplan-client'
import { useAppStore } from '@/store/index'
import {
  WorkItemScopePicker,
  type WorkItemScopeOption
} from '../../task-page/source-selection/work-item-scope-picker'
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

type UpdateRepo = (
  id: string,
  updates: { defaultItsaplanProject: ItsaplanProjectReference | null }
) => unknown

// Why: module-level so the try/catch stays out of the React Compiler's component body.
async function saveDefaultProject(
  repo: Repo,
  project: ItsaplanProjectReference | null,
  updateRepo: UpdateRepo,
  t: Translate
): Promise<string | null> {
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
    return null
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught)
  }
}

const NO_PROJECTS: ItsaplanProject[] = []

type HostProjectInventory = {
  source: RuntimeClientTarget
  instanceId: string | null
  projects: ItsaplanProject[]
  error: string | null
}

async function loadHostProjectInventory(
  source: RuntimeClientTarget
): Promise<HostProjectInventory> {
  const client = createItsaplanClientForTarget(source)
  try {
    const status = await client.status()
    const instanceId = status.instance?.id ?? null
    const projects = instanceId === null ? [] : await client.listProjects()
    return { source, instanceId, projects, error: null }
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught)
    return { source, instanceId: null, projects: [], error }
  }
}

export function RepositoryItsaplanProjectSection({
  repo,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  updateRepo: UpdateRepo
  forceVisible?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const hostId = getRepoExecutionHostId(repo)
  const source = useMemo(() => taskSourceRuntimeTarget({ hostId }), [hostId])
  const [inventory, setInventory] = useState<HostProjectInventory | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadHostProjectInventory(source).then((next) => {
      if (!cancelled) {
        setInventory(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [source])

  const current = inventory?.source === source ? inventory : null
  const loading = current === null
  const instanceId = current?.instanceId ?? null
  const projects = current?.projects ?? NO_PROJECTS
  const error = saveError ?? current?.error ?? null

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
    setSaveError(null)
    setSaveError(await saveDefaultProject(repo, project, updateRepo, t))
    setSaving(false)
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
      {!loading && instanceId === null ? (
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
