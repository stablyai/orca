import { getRepoHostIdentity } from '../../../../shared/repo-host-identity'
import { useAppStore } from '@/store'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import type { TaskPageStoreBindingsModel } from './use-task-page-store-bindings'
import { useMemo, useState, useEffect, useCallback } from 'react'
import {
  getTaskEligibleRepos,
  normalizeTaskRepoSelection,
  getDefaultTaskRepoSelection,
  getTaskProjectPickerGroups
} from '@/components/task-page/task-page-default-repo-selection'
import { buildSelectedReposKey } from '@/components/task-page/task-page-work-item-pagination'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider,
  resolveVisibleTaskProvider,
  type TaskProvider
} from '../../../../shared/task-providers'
import {
  getSourceOptions,
  getGitHubModeButtons,
  getLinearModeOptions,
  getJiraPresets,
  getGitLabIssueFilters,
  getGitLabMRFilters,
  getLinearViewOptions,
  getLinearGroupOptions,
  getLinearOrderOptions,
  getLinearDisplayProperties
} from '@/components/task-page/task-page-localized-options'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
export function useTaskPageRepoSelection(model: TaskPageStoreBindingsModel) {
  const {
    settings,
    pageData,
    repos,
    updateSettings,
    linearStatus,
    preflightStatus,
    jiraStatus,
    preflightStatusCurrent,
    linearConnected
  } = model
  const grouping = useAppStore(getProjectGroupingIndexFromState)
  const eligibleRepos = useMemo(() => getTaskEligibleRepos(repos), [repos])

  const persistedSelection = settings?.defaultRepoSelection
  const sourceIntent = useMemo<ReadonlySet<string> | null>(() => {
    const preferred = pageData.preselectedRepoId
    const source = pageData.openGitHubSourceContext
    if (preferred) {
      return new Set([
        source?.repoId === preferred ? `${source.hostId}\0${source.repoId}` : preferred
      ])
    }
    return Array.isArray(persistedSelection) ? new Set(persistedSelection) : null
  }, [pageData.preselectedRepoId, pageData.openGitHubSourceContext, persistedSelection])
  const [selectionIntent, setRepoSelection] = useState<ReadonlySet<string> | null>(sourceIntent)
  useEffect(() => {
    setRepoSelection(sourceIntent)
  }, [sourceIntent])
  const repoSelection = useMemo(
    () =>
      selectionIntent === null
        ? getDefaultTaskRepoSelection(eligibleRepos, undefined, grouping)
        : normalizeTaskRepoSelection(eligibleRepos, selectionIntent, undefined, grouping),
    [eligibleRepos, selectionIntent, grouping]
  )
  const taskPickerGroups = useMemo(
    () => getTaskProjectPickerGroups(eligibleRepos, repoSelection, undefined, grouping),
    [eligibleRepos, repoSelection, grouping]
  )
  const taskPickerRepos = useMemo(
    () => taskPickerGroups.map((group) => group.repo),
    [taskPickerGroups]
  )

  const selectedRepos = useMemo(
    () => eligibleRepos.filter((repo) => repoSelection.has(getRepoHostIdentity(repo))),
    [eligibleRepos, repoSelection]
  )

  // Reuse this provider-independent key while GitLab supplies no projectRef; adding one requires GitLab provider identity in the key.
  const selectedReposKey = useMemo(
    () => buildSelectedReposKey(selectedRepos, (r) => getTaskPageRepoSourceContext(r, 'github')),
    [selectedRepos]
  )

  const primaryRepo = selectedRepos[0] ?? null
  const linearWorkspaces = linearStatus.workspaces ?? []
  const selectedLinearWorkspaceId =
    linearStatus.selectedWorkspaceId ??
    linearStatus.activeWorkspaceId ??
    linearWorkspaces[0]?.id ??
    null
  const selectedLinearWorkspace =
    selectedLinearWorkspaceId && selectedLinearWorkspaceId !== 'all'
      ? (linearWorkspaces.find((workspace) => workspace.id === selectedLinearWorkspaceId) ?? null)
      : null
  const jiraSites = useMemo(() => jiraStatus.sites ?? [], [jiraStatus.sites])
  const selectedJiraSiteId =
    jiraStatus.selectedSiteId ?? jiraStatus.activeSiteId ?? jiraSites[0]?.id ?? null
  const selectedJiraSite =
    selectedJiraSiteId && selectedJiraSiteId !== 'all'
      ? (jiraSites.find((site) => site.id === selectedJiraSiteId) ?? null)
      : null
  const preferredVisibleTaskProviders = useMemo(
    () => normalizeVisibleTaskProviders(settings?.visibleTaskProviders),
    [settings?.visibleTaskProviders]
  )
  const defaultTaskSource = settings?.defaultTaskSource ?? 'github'
  const visibleTaskProviders = useMemo(
    () =>
      restoreAvailableDefaultTaskProvider(
        preferredVisibleTaskProviders,
        {
          gitlabInstalled: preflightStatusCurrent && preflightStatus?.glab?.installed === true,
          linearConnected: linearConnected === true
        },
        defaultTaskSource
      ),
    [
      defaultTaskSource,
      linearConnected,
      preferredVisibleTaskProviders,
      preflightStatusCurrent,
      preflightStatus?.glab?.installed
    ]
  )
  const sourceOptions = getSourceOptions()
  const githubModeButtons = getGitHubModeButtons()
  const linearModeOptions = getLinearModeOptions()
  const jiraPresets = getJiraPresets()
  const gitLabIssueFilters = getGitLabIssueFilters()
  const gitLabMRFilters = getGitLabMRFilters()
  const linearViewOptions = getLinearViewOptions()
  const linearGroupOptions = getLinearGroupOptions()
  const linearOrderOptions = getLinearOrderOptions()
  const linearDisplayPropertyOptions = getLinearDisplayProperties()
  const visibleSourceOptions = useMemo(
    () => sourceOptions.filter((source) => visibleTaskProviders.includes(source.id)),
    [sourceOptions, visibleTaskProviders]
  )
  const hideTaskSource = useCallback(
    (provider: TaskProvider, label: string) => {
      const visibleWithoutProvider = preferredVisibleTaskProviders.filter(
        (visibleProvider) => visibleProvider !== provider
      )
      // Empty provider lists mean all, so hiding one source must leave another selected.
      const nextVisibleTaskProviders: TaskProvider[] =
        visibleWithoutProvider.length > 0 ? visibleWithoutProvider : ['github']
      const nextDefaultTaskSource = resolveVisibleTaskProvider(
        defaultTaskSource,
        nextVisibleTaskProviders
      )
      void updateSettings({
        visibleTaskProviders: nextVisibleTaskProviders,
        defaultTaskSource: nextDefaultTaskSource
      }).catch(() => {
        toast.error(
          translate('auto.components.TaskPage.e9139db03f', 'Failed to hide {{value0}}.', {
            value0: label
          })
        )
      })
    },
    [defaultTaskSource, preferredVisibleTaskProviders, updateSettings]
  )

  // Seed preset/query synchronously to avoid a throwaway initial empty-query request.
  const nextModel = model as typeof model & {
    eligibleRepos: typeof eligibleRepos
    repoSelection: typeof repoSelection
    setRepoSelection: typeof setRepoSelection
    taskPickerGroups: typeof taskPickerGroups
    taskPickerRepos: typeof taskPickerRepos
    selectedRepos: typeof selectedRepos
    selectedReposKey: typeof selectedReposKey
    primaryRepo: typeof primaryRepo
    linearWorkspaces: typeof linearWorkspaces
    selectedLinearWorkspaceId: typeof selectedLinearWorkspaceId
    selectedLinearWorkspace: typeof selectedLinearWorkspace
    jiraSites: typeof jiraSites
    selectedJiraSiteId: typeof selectedJiraSiteId
    selectedJiraSite: typeof selectedJiraSite
    preferredVisibleTaskProviders: typeof preferredVisibleTaskProviders
    defaultTaskSource: typeof defaultTaskSource
    visibleTaskProviders: typeof visibleTaskProviders
    sourceOptions: typeof sourceOptions
    githubModeButtons: typeof githubModeButtons
    linearModeOptions: typeof linearModeOptions
    jiraPresets: typeof jiraPresets
    gitLabIssueFilters: typeof gitLabIssueFilters
    gitLabMRFilters: typeof gitLabMRFilters
    linearViewOptions: typeof linearViewOptions
    linearGroupOptions: typeof linearGroupOptions
    linearOrderOptions: typeof linearOrderOptions
    linearDisplayPropertyOptions: typeof linearDisplayPropertyOptions
    visibleSourceOptions: typeof visibleSourceOptions
    hideTaskSource: typeof hideTaskSource
  }
  nextModel.eligibleRepos = eligibleRepos
  nextModel.repoSelection = repoSelection
  nextModel.setRepoSelection = setRepoSelection
  nextModel.taskPickerGroups = taskPickerGroups
  nextModel.taskPickerRepos = taskPickerRepos
  nextModel.selectedRepos = selectedRepos
  nextModel.selectedReposKey = selectedReposKey
  nextModel.primaryRepo = primaryRepo
  nextModel.linearWorkspaces = linearWorkspaces
  nextModel.selectedLinearWorkspaceId = selectedLinearWorkspaceId
  nextModel.selectedLinearWorkspace = selectedLinearWorkspace
  nextModel.jiraSites = jiraSites
  nextModel.selectedJiraSiteId = selectedJiraSiteId
  nextModel.selectedJiraSite = selectedJiraSite
  nextModel.preferredVisibleTaskProviders = preferredVisibleTaskProviders
  nextModel.defaultTaskSource = defaultTaskSource
  nextModel.visibleTaskProviders = visibleTaskProviders
  nextModel.sourceOptions = sourceOptions
  nextModel.githubModeButtons = githubModeButtons
  nextModel.linearModeOptions = linearModeOptions
  nextModel.jiraPresets = jiraPresets
  nextModel.gitLabIssueFilters = gitLabIssueFilters
  nextModel.gitLabMRFilters = gitLabMRFilters
  nextModel.linearViewOptions = linearViewOptions
  nextModel.linearGroupOptions = linearGroupOptions
  nextModel.linearOrderOptions = linearOrderOptions
  nextModel.linearDisplayPropertyOptions = linearDisplayPropertyOptions
  nextModel.visibleSourceOptions = visibleSourceOptions
  nextModel.hideTaskSource = hideTaskSource
  return nextModel
}
export type TaskPageRepoSelectionModel = ReturnType<typeof useTaskPageRepoSelection>
