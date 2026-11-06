// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import type { JiraProjectReference } from '../../../../../shared/jira/jira-project-reference'
import TaskPage from '../TaskPage'
import { TaskPageJiraFilters } from './Filters'

const fixture = vi.hoisted(() => ({ loading: false }))
vi.mock('../Surface', () => ({
  TaskPageSurface: ({ model }: { model: TaskPageComposerActionsModel }) => (
    <FiltersFixture baseModel={model} loading={fixture.loading} />
  )
}))

const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
const setJiraProjectFilter = vi.fn()
const initialStore = useAppStore.getState()
const initialApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

function FiltersFixture({
  baseModel,
  loading
}: {
  baseModel: TaskPageComposerActionsModel
  loading: boolean
}) {
  const [jiraHasWorkspace, setJiraHasWorkspace] = useState(false)
  const [jiraProjectFilter, setProject] = useState<JiraProjectReference | null>(project)
  const model = {
    ...baseModel,
    jiraHasWorkspace,
    setJiraHasWorkspace,
    jiraProjectFilter,
    setJiraProjectFilter: (value: JiraProjectReference | null) => {
      setJiraProjectFilter(value)
      setProject(value)
    },
    setTaskResumeState: vi.fn(),
    jiraPresets: [{ id: 'all', label: 'All' }],
    jiraLoading: false,
    jiraSearchInput: '',
    setJiraSearchInput: vi.fn(),
    setAppliedJiraSearch: vi.fn(),
    activeJiraPreset: 'all',
    setActiveJiraPreset: vi.fn(),
    setJiraRefreshNonce: vi.fn(),
    jiraSavedFilters: [],
    jiraActiveSavedFilterId: null,
    jiraSavedFiltersReady: true,
    jiraSavedFiltersLoading: false,
    jiraSavedFiltersPending: false,
    jiraSavedFiltersError: null,
    retryJiraSavedFilters: vi.fn(),
    applyJiraSavedFilter: vi.fn().mockResolvedValue(true),
    createJiraSavedFilter: vi.fn().mockResolvedValue(undefined),
    updateJiraSavedFilter: vi.fn().mockResolvedValue(undefined),
    deleteJiraSavedFilter: vi.fn().mockResolvedValue(undefined),
    clearJiraSavedFilterSelection: vi.fn().mockResolvedValue(undefined),
    selectedJiraStatuses: [],
    selectJiraStatuses: vi.fn().mockResolvedValue(undefined),
    jiraQuickFiltersReady: true,
    jiraQuickFiltersLoading: false,
    jiraQuickFiltersPending: false,
    jiraQuickFiltersError: null,
    retryJiraQuickFilters: vi.fn(),
    jiraStatusCatalog: null,
    jiraTaskSourceScopeKey: 'fixture',
    selectedJiraSiteId: 'all',
    jiraProjectsLoading: loading,
    setNewJiraIssueOpen: vi.fn(),
    setNewJiraIssueTitle: vi.fn(),
    setNewJiraIssueBody: vi.fn(),
    setNewJiraIssueProjectId: vi.fn(),
    setNewJiraIssueProjectQuery: vi.fn(),
    setNewJiraIssueProjectCommandValue: vi.fn(),
    setNewJiraIssueTypeId: vi.fn(),
    sortedAvailableJiraProjects: [project]
  } satisfies TaskPageComposerActionsModel

  return (
    <TooltipProvider>
      <TaskPageJiraFilters model={model} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  fixture.loading = false
  useAppStore.setState(
    {
      ...initialStore,
      settings: null,
      persistedUIReady: false,
      repos: [],
      taskPageData: {},
      checkLinearConnection: vi
        .fn<typeof initialStore.checkLinearConnection>()
        .mockResolvedValue(undefined),
      checkJiraConnection: vi
        .fn<typeof initialStore.checkJiraConnection>()
        .mockResolvedValue(undefined),
      refreshPreflightStatus: vi
        .fn<typeof initialStore.refreshPreflightStatus>()
        .mockResolvedValue(undefined)
    },
    true
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: { viewer: vi.fn<typeof window.api.gh.viewer>().mockResolvedValue(null) }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  if (initialApiDescriptor) {
    Object.defineProperty(window, 'api', initialApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  vi.clearAllMocks()
})

describe('Jira project filters in Has Workspace mode', () => {
  it('disables project changes while linked and restores the existing choice on a preset', async () => {
    render(<TaskPage />)
    const picker = screen.getByRole('combobox', { name: 'Jira project' })
    expect(picker).toBeEnabled()
    expect(picker).toHaveTextContent('ALP · Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Has Workspace' }))
    expect(picker).toBeDisabled()
    fireEvent.click(picker)
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(setJiraProjectFilter).not.toHaveBeenCalled()
    expect(picker).toHaveTextContent('ALP · Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(picker).toBeEnabled()
    expect(picker).toHaveTextContent('ALP · Alpha')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: 'All Jira projects' }))
    expect(picker).toHaveTextContent('All Jira projects')

    fireEvent.click(screen.getByRole('button', { name: 'Has Workspace' }))
    expect(picker).toBeDisabled()
    expect(picker).toHaveTextContent('All Jira projects')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(picker).toBeEnabled()
    expect(picker).toHaveTextContent('All Jira projects')
    expect(setJiraProjectFilter).toHaveBeenCalledExactlyOnceWith(null)
  })
})
