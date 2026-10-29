// @vitest-environment happy-dom

import { useState } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraProjectStatusOrder } from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { TaskPageLinearBoardModel } from '../linear/use-task-page-linear-board'
import type { TaskPageLinearCollectionEffectsModel } from '../linear/use-task-page-linear-collection-effects'
import { useTaskPageJiraListProjection } from '@/components/use-task-page-jira-list-projection'
import { useTaskPageJiraListEffects } from '@/components/use-task-page-jira-list-effects'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import { getJiraRuntimeTarget } from '@/runtime/runtime-jira-target'
import { bumpProviderRuntimeSessionGeneration } from '@/lib/provider-runtime-context'

const runtime = vi.hoisted(() => ({
  getProjectStatusOrder:
    vi.fn<
      (
        source: RuntimeJiraSettings,
        key: string,
        siteId?: string | null
      ) => Promise<JiraProjectStatusOrder>
    >()
}))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetProjectStatusOrder: runtime.getProjectStatusOrder
}))

let source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'session-project',
  hostId: 'runtime:jira-column-owner'
}
const issue: JiraIssue = {
  id: 'session-issue',
  key: 'SESSION-1',
  siteId: 'session-site',
  title: 'Keep the current column map',
  url: 'https://jira.invalid/browse/SESSION-1',
  project: { id: 'session-project', key: 'SESSION', name: 'Session' },
  issueType: { id: 'task', name: 'Task' },
  status: {
    id: 'review',
    name: 'Review',
    categoryKey: 'indeterminate',
    categoryName: 'In Progress'
  },
  labels: [],
  updatedAt: '2026-10-14T12:00:00Z',
  createdAt: '2026-10-14T12:00:00Z'
}
const issues = [issue]
const oldOrder: JiraProjectStatusOrder = {
  statusIdsByColumn: [['review']],
  columns: [{ name: 'Previous session lane', statusIds: ['review'] }]
}
const newOrder: JiraProjectStatusOrder = {
  statusIdsByColumn: [['review']],
  columns: [{ name: 'Current session lane', statusIds: ['review'] }]
}
let visit = 0
const listJiraIssues = vi.fn().mockResolvedValue(issues)
const statuses: string[] = []
const savedFilters: { id: string; name: string; jql: string }[] = []

function useStatusOrderFixture(focusedEnvironmentId: string) {
  const [jiraProjectStatusOrder, setJiraProjectStatusOrder] = useState<{
    order: JiraProjectStatusOrder
    scopeKey: string
  } | null>(null)
  const model = {
    settings: { activeRuntimeEnvironmentId: focusedEnvironmentId },
    accountBackedTaskSourceHostId: 'runtime:unrelated-fallback-owner',
    setTaskResumeState: vi.fn(),
    searchJiraIssues: vi.fn(),
    listJiraIssues,
    jiraConnected: true,
    selectedJiraSiteId: issue.siteId,
    taskSource: 'jira',
    jiraTaskSourceContext: source,
    jiraTaskSourceScopeKey: getTaskSourceCacheScope(source),
    jiraSearchPersistReadyRef: { current: true },
    taskResumeApplied: true,
    selectedJiraIssueKey: null,
    setSelectedJiraIssueKey: vi.fn(),
    selectedJiraIssueFallback: null,
    setSelectedJiraIssueFallback: vi.fn(),
    setJiraIssues: vi.fn(),
    setJiraLoading: vi.fn(),
    setJiraError: vi.fn(),
    setJiraErrorDetailsOpen: vi.fn(),
    setJiraJqlRejection: vi.fn(),
    jiraSearchInput: '',
    appliedJiraSearch: '',
    jiraRemoteSearch: '',
    setAppliedJiraSearch: vi.fn(),
    activeJiraPreset: 'assigned',
    jiraCurrentSprint: false,
    jiraHasWorkspace: false,
    linearAttachmentWorkspaces: [],
    jiraStatus: { sites: [] },
    linkedJiraIssueRefs: [],
    linkedJiraIssueRefsSignature: '',
    jiraRefreshNonce: 0,
    jiraActiveSavedFilterId: null,
    jiraSavedFilters: savedFilters,
    jiraSavedFiltersLoading: false,
    selectedJiraStatuses: statuses,
    jiraQuickFiltersLoading: false,
    setJiraStatusCatalog: vi.fn(),
    jiraIssues: issues,
    jiraCacheSnapshot: { issueCache: {}, searchCache: {} },
    jiraProjectStatusOrder,
    setJiraProjectStatusOrder,
    jiraOrderBy: 'status',
    jiraOrderDirection: 'asc',
    jiraPrioritiesBySite: new Map()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the Jira projection, without constructing unrelated provider pipelines.
  const projected = useTaskPageJiraListProjection(model as unknown as TaskPageLinearBoardModel)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the Jira collection effects and the real projection adds its displayed issue fields.
  useTaskPageJiraListEffects(projected as unknown as TaskPageLinearCollectionEffectsModel)
  return projected.displayedJiraStatusOrder
}

describe('Jira board column metadata across provider sessions', () => {
  afterEach(cleanup)
  beforeEach(() => {
    source = { ...source, projectId: `session-project-${++visit}` }
    runtime.getProjectStatusOrder.mockReset()
    listJiraIssues.mockClear()
    listJiraIssues.mockResolvedValue(issues)
    bumpProviderRuntimeSessionGeneration()
  })

  it('hides the previous lane map immediately and refetches for the same explicit source', async () => {
    let resolveNewOrder: (order: JiraProjectStatusOrder) => void = () => {}
    const pendingOrder = new Promise<JiraProjectStatusOrder>((resolve) => {
      resolveNewOrder = resolve
    })
    runtime.getProjectStatusOrder.mockResolvedValueOnce(oldOrder).mockReturnValueOnce(pendingOrder)
    const { result, rerender } = renderHook(({ focus }) => useStatusOrderFixture(focus), {
      initialProps: { focus: 'unrelated-ui-host-a' }
    })
    await waitFor(() => expect(result.current).toEqual(oldOrder))
    expect(runtime.getProjectStatusOrder).toHaveBeenCalledTimes(1)

    await act(async () => {
      bumpProviderRuntimeSessionGeneration()
      rerender({ focus: 'unrelated-ui-host-a' })
    })
    expect(result.current).toBeNull()
    await waitFor(() => expect(runtime.getProjectStatusOrder).toHaveBeenCalledTimes(2))
    expect(listJiraIssues).toHaveBeenCalledTimes(2)
    expect(
      runtime.getProjectStatusOrder.mock.calls.map(([owner]) => getJiraRuntimeTarget(owner))
    ).toEqual([
      { kind: 'environment', environmentId: 'jira-column-owner' },
      { kind: 'environment', environmentId: 'jira-column-owner' }
    ])

    await act(async () => resolveNewOrder(newOrder))
    await waitFor(() => expect(result.current).toEqual(newOrder))
  })

  it('keeps the Jira owner column map when focus moves to an unrelated host', async () => {
    runtime.getProjectStatusOrder.mockResolvedValue(oldOrder)
    const { result, rerender } = renderHook(({ focus }) => useStatusOrderFixture(focus), {
      initialProps: { focus: 'unrelated-ui-host-a' }
    })
    await waitFor(() => expect(result.current).toEqual(oldOrder))
    await act(async () => rerender({ focus: 'unrelated-ui-host-b' }))
    expect(result.current).toEqual(oldOrder)
    expect(runtime.getProjectStatusOrder).toHaveBeenCalledTimes(1)
    expect(listJiraIssues).toHaveBeenCalledTimes(1)
    expect(getJiraRuntimeTarget(runtime.getProjectStatusOrder.mock.calls[0][0])).toEqual({
      kind: 'environment',
      environmentId: 'jira-column-owner'
    })
  })
})
