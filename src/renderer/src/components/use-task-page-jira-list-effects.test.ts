// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPageLinearCollectionEffectsModel } from './task-page/linear/use-task-page-linear-collection-effects'
import { useTaskPageJiraListEffects } from './use-task-page-jira-list-effects'
import { restrictJiraQueryToProject } from '../../../shared/jira/jira-project-reference'
import { buildJiraPresetJql } from '../../../shared/jira/jira-preset-jql'
import { buildJiraTextMatchJql } from '../../../shared/jira/jira-search-input-jql'

const listJiraIssues = vi.fn().mockResolvedValue([])
const searchJiraIssues = vi.fn().mockResolvedValue([])

function createModel(): TaskPageLinearCollectionEffectsModel {
  const model = {
    settings: null,
    setTaskResumeState: vi.fn(),
    searchJiraIssues,
    listJiraIssues,
    jiraConnected: true,
    selectedJiraSiteId: 'site-1',
    taskSource: 'jira',
    jiraTaskSourceContext: null,
    jiraHasWorkspace: false,
    linkedJiraIssueRefs: [],
    linkedJiraIssueRefsSignature: '[]',
    jiraTaskSourceScopeKey: 'fixture',
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
    setAppliedJiraSearch: vi.fn(),
    activeJiraPreset: 'assigned',
    jiraCurrentSprint: false,
    jiraProjectFilter: null,
    jiraRefreshNonce: 0,
    jiraActiveSavedFilterId: null,
    jiraSavedFilters: [],
    jiraSavedFiltersLoading: false,
    selectedJiraStatuses: [],
    jiraQuickFiltersLoading: false,
    setJiraStatusCatalog: vi.fn(),
    setJiraProjectStatusOrder: vi.fn(),
    displayedJiraIssues: []
  }
  // SAFETY: the hook only reads the Jira fields above; the preceding pipeline model is intentionally not constructed in this isolated wiring test.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the partial fixture intentionally models only fields read by this hook.
  return model as unknown as TaskPageLinearCollectionEffectsModel
}

describe('useTaskPageJiraListEffects refresh wiring', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    listJiraIssues.mockResolvedValue([])
    searchJiraIssues.mockResolvedValue([])
  })
  it('keeps sprint presets on the host list path and composes text queries after classification', async () => {
    const model = createModel()
    model.activeJiraPreset = 'all'
    model.jiraCurrentSprint = true
    model.selectedJiraStatuses = ['Blocked']
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(listJiraIssues).toHaveBeenCalledWith('all', 50, {
        sourceContext: null,
        force: false,
        filters: { statuses: ['Blocked'], currentSprint: true }
      })
    )
    expect(searchJiraIssues).not.toHaveBeenCalled()
    await act(async () => {
      model.appliedJiraSearch = 'fix login'
      rerender()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(searchJiraIssues).toHaveBeenCalledWith(
        '(text ~ "fix login*") AND sprint in openSprints()',
        50,
        { sourceContext: null, force: false }
      )
    )
  })

  it('adds sprint filtering to exact saved JQL without retrying invalid syntax as text', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'saved-query ORDER BY updated DESC'
    model.jiraActiveSavedFilterId = 'saved'
    model.jiraSavedFilters = [{ id: 'saved', name: 'Saved', jql: model.appliedJiraSearch }]
    model.jiraCurrentSprint = true
    searchJiraIssues.mockRejectedValue(new Error('Error 400: Invalid saved query'))
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(model.setJiraError).toHaveBeenCalledWith(
        expect.objectContaining({ details: 'Invalid saved query' })
      )
    )
    expect(searchJiraIssues).toHaveBeenCalledExactlyOnceWith(
      '(saved-query) AND sprint in openSprints() ORDER BY updated DESC',
      50,
      { sourceContext: null, force: false }
    )
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it('keeps mapped saved JQL exact with sprint filtering and ignores persisted statuses', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'filter = 12345 ORDER BY created ASC'
    model.jiraActiveSavedFilterId = 'saved'
    model.jiraSavedFilters = [{ id: 'saved', name: 'Saved', jql: model.appliedJiraSearch }]
    model.jiraCurrentSprint = true
    model.selectedJiraStatuses = ['Blocked']
    model.jiraProjectFilter = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
    searchJiraIssues.mockRejectedValue(new Error('Error 400: Invalid saved query'))
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(model.setJiraError).toHaveBeenCalledWith(
        expect.objectContaining({ details: 'Invalid saved query' })
      )
    )
    expect(searchJiraIssues).toHaveBeenCalledExactlyOnceWith(
      'project = "10" AND ((filter = 12345) AND sprint in openSprints()) ORDER BY created ASC',
      50,
      { sourceContext: null, siteId: 'site-a', force: false }
    )
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it('classifies mapped text before adding sprint filtering without persisted statuses', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'fix login'
    model.jiraCurrentSprint = true
    model.selectedJiraStatuses = ['Blocked']
    model.jiraProjectFilter = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(searchJiraIssues).toHaveBeenCalledExactlyOnceWith(
        'project = "10" AND ((text ~ "fix login*") AND sprint in openSprints())',
        50,
        { sourceContext: null, siteId: 'site-a', force: false }
      )
    )
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it('reports a saved query that exceeds the request limit after sprint composition', async () => {
    const model = createModel()
    model.appliedJiraSearch = `key in (${Array.from({ length: 1030 }, (_, index) => `APP-${index + 1}`).join(',')})`
    model.jiraActiveSavedFilterId = 'large'
    model.jiraSavedFilters = [{ id: 'large', name: 'Large', jql: model.appliedJiraSearch }]
    model.jiraCurrentSprint = true
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(model.setJiraError).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('too long') })
      )
    )
    expect(searchJiraIssues).not.toHaveBeenCalled()
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it('checks the saved query limit after both sprint and project restrictions', async () => {
    const model = createModel()
    model.appliedJiraSearch = `summary ~ "${'x'.repeat(8140)}"`
    model.jiraActiveSavedFilterId = 'large'
    model.jiraSavedFilters = [{ id: 'large', name: 'Large', jql: model.appliedJiraSearch }]
    model.jiraCurrentSprint = true
    model.jiraProjectFilter = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(model.setJiraError).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('too long') })
      )
    )
    expect(searchJiraIssues).not.toHaveBeenCalled()
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'saved JQL',
      query: `summary ~ "${'x'.repeat(8160)}"`,
      validQuery: `summary ~ "${'x'.repeat(8159)}"`,
      saved: true
    },
    {
      name: 'manual JQL',
      query: `summary ~ "${'x'.repeat(8160)}"`,
      validQuery: `summary ~ "${'x'.repeat(8159)}"`,
      saved: false
    },
    { name: 'plain text', query: 'x'.repeat(8162), validQuery: 'x'.repeat(8161), saved: false },
    {
      name: 'UTF-8 JQL',
      query: `summary ~ "${'界'.repeat(2720)}"`,
      validQuery: `summary ~ "${'界'.repeat(2719)}xx"`,
      saved: false
    }
  ])(
    'rejects project-only overflow for $name and recovers at 8192 bytes',
    async ({ query, validQuery, saved }) => {
      const model = createModel()
      const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
      model.appliedJiraSearch = query
      model.jiraProjectFilter = project
      if (saved) {
        model.jiraActiveSavedFilterId = 'large'
        model.jiraSavedFilters = [{ id: 'large', name: 'Large', jql: query }]
      }
      const jql = query.includes('~') ? query : buildJiraTextMatchJql(query)
      expect(new TextEncoder().encode(query).length).toBeLessThan(8192)
      expect(new TextEncoder().encode(restrictJiraQueryToProject(jql, project)).length).toBe(8193)
      const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
      await waitFor(() =>
        expect(model.setJiraError).toHaveBeenLastCalledWith({
          title: 'The Jira query is too long. Shorten the query or clear filters.',
          details: null
        })
      )
      expect(model.setJiraLoading).toHaveBeenLastCalledWith(false)
      expect(model.setJiraIssues).toHaveBeenLastCalledWith([])
      expect(model.setJiraJqlRejection).toHaveBeenCalledExactlyOnceWith(null)
      expect(searchJiraIssues).not.toHaveBeenCalled()
      expect(listJiraIssues).not.toHaveBeenCalled()

      const validJql = query.includes('~') ? validQuery : buildJiraTextMatchJql(validQuery)
      const scopedValidJql = restrictJiraQueryToProject(validJql, project)
      expect(new TextEncoder().encode(scopedValidJql).length).toBe(8192)
      model.appliedJiraSearch = validQuery
      if (saved) {
        model.jiraSavedFilters = [{ id: 'large', name: 'Large', jql: validQuery }]
      }
      rerender()
      await waitFor(() => expect(model.setJiraLoading).toHaveBeenLastCalledWith(false))
      expect(searchJiraIssues).toHaveBeenCalledExactlyOnceWith(scopedValidJql, 50, {
        sourceContext: null,
        siteId: 'site-a',
        force: false
      })
      expect(model.setJiraError).toHaveBeenLastCalledWith(null)
    }
  )

  it.each([
    {
      name: 'escaped',
      statuses: Array.from({ length: 50 }, (_, index) => `${index}${'"'.repeat(124)}`)
    },
    {
      name: 'UTF-8',
      statuses: Array.from({ length: 50 }, (_, index) => `${index}${'界'.repeat(126)}`)
    }
  ])(
    'rejects an oversized mapped preset with $name status names and recovers',
    async ({ statuses }) => {
      const model = createModel()
      const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
      model.activeJiraPreset = 'all'
      model.jiraProjectFilter = project
      model.selectedJiraStatuses = statuses
      expect(statuses.every((status) => status.length <= 128)).toBe(true)
      const query = restrictJiraQueryToProject(buildJiraPresetJql('all', { statuses }), project)
      expect(new TextEncoder().encode(query).length).toBeGreaterThan(8192)
      const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
      await waitFor(() =>
        expect(model.setJiraError).toHaveBeenLastCalledWith({
          title: 'The Jira query is too long. Shorten the query or clear filters.',
          details: null
        })
      )
      expect(model.setJiraLoading).toHaveBeenLastCalledWith(false)
      expect(searchJiraIssues).not.toHaveBeenCalled()
      expect(listJiraIssues).not.toHaveBeenCalled()
      model.selectedJiraStatuses = ['Blocked']
      rerender()
      await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))
      expect(searchJiraIssues).toHaveBeenLastCalledWith(
        'project = "10" AND (statusCategory != Done AND status in ("Blocked")) ORDER BY updated DESC',
        50,
        { sourceContext: null, siteId: 'site-a', force: false }
      )
      await waitFor(() => expect(model.setJiraError).toHaveBeenLastCalledWith(null))
      expect(model.setJiraLoading).toHaveBeenLastCalledWith(false)
    }
  )

  it('reports an oversized manual query without project or sprint filters', async () => {
    const model = createModel()
    model.appliedJiraSearch = `summary ~ "${'x'.repeat(8181)}"`
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(model.setJiraError).toHaveBeenLastCalledWith({
        title: 'The Jira query is too long. Shorten the query or clear filters.',
        details: null
      })
    )
    expect(searchJiraIssues).not.toHaveBeenCalled()
    expect(listJiraIssues).not.toHaveBeenCalled()
    expect(model.setJiraLoading).toHaveBeenLastCalledWith(false)
  })

  it('ignores a mapped preset limit rejection after changing the source', async () => {
    const model = createModel()
    model.jiraProjectFilter = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
    model.selectedJiraStatuses = Array.from(
      { length: 50 },
      (_, index) => `${index}${'"'.repeat(124)}`
    )
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    model.taskSource = 'linear'
    rerender()
    await act(async () => {
      await Promise.resolve()
    })
    expect(model.setJiraError).toHaveBeenCalledExactlyOnceWith(null)
    expect(model.setJiraIssues).not.toHaveBeenCalled()
    expect(searchJiraIssues).not.toHaveBeenCalled()
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it('loads linked keys directly and does not reread them for local search text', async () => {
    const model = createModel()
    model.jiraHasWorkspace = true
    model.linkedJiraIssueRefs = [{ key: 'APP-1', siteId: 'site-1' }]
    model.linkedJiraIssueRefsSignature = JSON.stringify(model.linkedJiraIssueRefs)
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))
    expect(listJiraIssues).not.toHaveBeenCalled()
    expect(searchJiraIssues).toHaveBeenCalledWith('key = APP-1', 1, {
      sourceContext: null,
      siteId: 'site-1',
      force: false
    })
    model.appliedJiraSearch = 'login'
    rerender()
    await waitFor(() => expect(model.setJiraLoading).toHaveBeenLastCalledWith(false))
    expect(searchJiraIssues).toHaveBeenCalledTimes(1)
    model.jiraRefreshNonce = 1
    rerender()
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(2))
    expect(searchJiraIssues).toHaveBeenLastCalledWith('key = APP-1', 1, {
      sourceContext: null,
      siteId: 'site-1',
      force: true
    })
  })

  it('ignores a linked read that completes after the source changes', async () => {
    const model = createModel()
    model.jiraHasWorkspace = true
    model.linkedJiraIssueRefs = [{ key: 'APP-1', siteId: 'site-1' }]
    model.linkedJiraIssueRefsSignature = JSON.stringify(model.linkedJiraIssueRefs)
    let complete: (value: []) => void = () => {}
    searchJiraIssues.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          complete = resolve
        })
    )
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))
    model.taskSource = 'linear'
    rerender()
    await act(async () => {
      complete([])
      await Promise.resolve()
    })
    expect(model.setJiraIssues).not.toHaveBeenCalled()
  })

  it('passes force only for a refresh nonce change', async () => {
    const model = createModel()
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))

    await waitFor(() => expect(listJiraIssues).toHaveBeenCalledTimes(1))
    expect(listJiraIssues).toHaveBeenNthCalledWith(1, 'assigned', 50, {
      sourceContext: null,
      force: false
    })

    await act(async () => {
      model.jiraRefreshNonce = 1
      rerender()
      await Promise.resolve()
    })
    await waitFor(() => expect(listJiraIssues).toHaveBeenCalledTimes(2))
    expect(listJiraIssues).toHaveBeenNthCalledWith(2, 'assigned', 50, {
      sourceContext: null,
      force: true
    })

    await act(async () => {
      model.activeJiraPreset = 'reported'
      rerender()
      await Promise.resolve()
    })
    await waitFor(() => expect(listJiraIssues).toHaveBeenCalledTimes(3))
    expect(listJiraIssues).toHaveBeenNthCalledWith(3, 'reported', 50, {
      sourceContext: null,
      force: false
    })
  })

  it('uses the preset list path for status filters and restores it after clearing', async () => {
    const model = createModel()
    model.selectedJiraStatuses = ['In Progress', 'Blocked']
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(listJiraIssues).toHaveBeenCalledTimes(1))
    expect(listJiraIssues).toHaveBeenLastCalledWith('assigned', 50, {
      sourceContext: null,
      force: false,
      filters: { statuses: ['In Progress', 'Blocked'] }
    })
    expect(searchJiraIssues).not.toHaveBeenCalled()
    await act(async () => {
      model.selectedJiraStatuses = []
      rerender()
    })
    expect(listJiraIssues).toHaveBeenLastCalledWith('assigned', 50, {
      sourceContext: null,
      force: false
    })
  })

  it('keeps manual JQL independent of a persisted status selection', async () => {
    const model = createModel()
    model.selectedJiraStatuses = ['Blocked']
    model.appliedJiraSearch = 'project = APP ORDER BY created ASC'
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))
    expect(searchJiraIssues).toHaveBeenCalledWith('project = APP ORDER BY created ASC', 50, {
      sourceContext: null,
      force: false
    })
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it('passes force through the text-search wrapper on refresh', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'fix login'
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))

    await act(async () => {
      model.jiraRefreshNonce = 1
      rerender()
      await Promise.resolve()
    })
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(2))
    expect(searchJiraIssues).toHaveBeenNthCalledWith(2, 'text ~ "fix login*"', 50, {
      sourceContext: null,
      force: true
    })
  })

  it.each([
    {
      statuses: [],
      currentSprint: false,
      query: 'project = "10" AND (statusCategory != Done) ORDER BY updated DESC'
    },
    {
      statuses: ['In Progress', 'Blocked'],
      currentSprint: false,
      query:
        'project = "10" AND (statusCategory != Done AND status in ("In Progress", "Blocked")) ORDER BY updated DESC'
    },
    {
      statuses: [],
      currentSprint: true,
      query:
        'project = "10" AND (statusCategory != Done AND sprint in openSprints()) ORDER BY updated DESC'
    },
    {
      statuses: ['Blocked'],
      currentSprint: true,
      query:
        'project = "10" AND (statusCategory != Done AND status in ("Blocked") AND sprint in openSprints()) ORDER BY updated DESC'
    }
  ])(
    'scopes statuses $statuses and sprint $currentSprint to the mapped project and owner',
    async ({ statuses, currentSprint, query }) => {
      const model = createModel()
      model.jiraTaskSourceContext = {
        kind: 'task-source',
        provider: 'jira',
        projectId: 'source-project',
        hostId: 'runtime:owner'
      }
      model.activeJiraPreset = 'all'
      model.selectedJiraStatuses = statuses
      model.jiraCurrentSprint = currentSprint
      model.jiraProjectFilter = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
      renderHook(() => useTaskPageJiraListEffects(model))
      await waitFor(() =>
        expect(searchJiraIssues).toHaveBeenCalledWith(query, 50, {
          sourceContext: model.jiraTaskSourceContext,
          siteId: 'site-a',
          force: false
        })
      )
      expect(listJiraIssues).not.toHaveBeenCalled()
      await waitFor(() => expect(model.setJiraLoading).toHaveBeenLastCalledWith(false))
      if (statuses.length === 0) {
        expect(model.setJiraStatusCatalog).toHaveBeenCalledWith({
          scopeKey: 'fixture::site-1::all::site-a:10',
          items: []
        })
      } else {
        expect(model.setJiraStatusCatalog).not.toHaveBeenCalled()
      }
    }
  )

  it('ignores the project mapping for linked issues and restores it when leaving linked mode', async () => {
    const model = createModel()
    model.activeJiraPreset = 'all'
    model.jiraProjectFilter = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
    model.selectedJiraStatuses = ['Blocked']
    model.jiraCurrentSprint = true
    model.jiraHasWorkspace = true
    model.linkedJiraIssueRefs = [{ key: 'APP-1', siteId: 'site-1' }]
    model.linkedJiraIssueRefsSignature = JSON.stringify(model.linkedJiraIssueRefs)
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))
    expect(searchJiraIssues).toHaveBeenLastCalledWith('key = APP-1', 1, {
      sourceContext: null,
      siteId: 'site-1',
      force: false
    })
    expect(listJiraIssues).not.toHaveBeenCalled()
    expect(model.setJiraStatusCatalog).not.toHaveBeenCalled()
    expect(model.selectedJiraStatuses).toEqual(['Blocked'])
    expect(model.jiraCurrentSprint).toBe(true)
    model.jiraHasWorkspace = false
    rerender()
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(2))
    expect(searchJiraIssues).toHaveBeenLastCalledWith(
      'project = "10" AND (statusCategory != Done AND status in ("Blocked") AND sprint in openSprints()) ORDER BY updated DESC',
      50,
      { sourceContext: null, siteId: 'site-a', force: false }
    )
    expect(model.setJiraError).toHaveBeenLastCalledWith(null)
    expect(model.setJiraStatusCatalog).not.toHaveBeenCalled()
  })

  it.each([
    ['release candidate', 'project = "10" AND (release candidate)'],
    [
      'filter = 12345 ORDER BY created ASC',
      'project = "10" AND (filter = 12345) ORDER BY created ASC'
    ]
  ])(
    'keeps saved JQL exact in the mapped project and restores its preset after exit: %s',
    async (query, scopedQuery) => {
      const model = createModel()
      const filter = { id: 'saved', name: 'Saved work', jql: query }
      model.jiraTaskSourceContext = {
        kind: 'task-source',
        provider: 'jira',
        projectId: 'source-project',
        hostId: 'runtime:owner'
      }
      model.activeJiraPreset = 'all'
      model.jiraProjectFilter = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
      model.selectedJiraStatuses = ['Blocked']
      model.jiraSavedFilters = [filter]
      model.jiraActiveSavedFilterId = filter.id
      model.appliedJiraSearch = query
      searchJiraIssues.mockRejectedValueOnce(new Error('Error 400: JQL syntax invalid'))
      const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
      await waitFor(() =>
        expect(model.setJiraError).toHaveBeenLastCalledWith(
          expect.objectContaining({ details: 'JQL syntax invalid' })
        )
      )
      expect(searchJiraIssues).toHaveBeenCalledExactlyOnceWith(scopedQuery, 50, {
        sourceContext: model.jiraTaskSourceContext,
        siteId: 'site-a',
        force: false
      })
      expect(model.setJiraJqlRejection).toHaveBeenCalledExactlyOnceWith(null)

      model.jiraActiveSavedFilterId = null
      model.appliedJiraSearch = ''
      rerender()
      await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(2))
      expect(searchJiraIssues).toHaveBeenLastCalledWith(
        'project = "10" AND (statusCategory != Done AND status in ("Blocked")) ORDER BY updated DESC',
        50,
        { sourceContext: model.jiraTaskSourceContext, siteId: 'site-a', force: false }
      )
      expect(listJiraIssues).not.toHaveBeenCalled()
      expect(model.setJiraError).toHaveBeenLastCalledWith(null)
    }
  )

  it('shows the JQL rejection with its text matches and clears it for the next search', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'project = NOPE'
    searchJiraIssues
      .mockRejectedValueOnce(new Error("Error 400: The value 'NOPE' does not exist."))
      .mockResolvedValueOnce([])
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    const rejection = { reason: "The value 'NOPE' does not exist.", likelyTypo: true }
    await waitFor(() => expect(model.setJiraJqlRejection).toHaveBeenLastCalledWith(rejection))

    // The next search never settles, so only the reset at its start can clear the notice.
    searchJiraIssues.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => {
      model.appliedJiraSearch = 'fix login'
      rerender()
      await Promise.resolve()
    })
    expect(model.setJiraJqlRejection).toHaveBeenLastCalledWith(null)
  })

  it('drops the rejection of a search that was replaced before it finished', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'project = NOPE'
    let rejectJql: (error: Error) => void = () => {}
    searchJiraIssues
      .mockReturnValueOnce(new Promise((_, reject) => (rejectJql = reject)))
      .mockResolvedValue([])
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))

    await act(async () => {
      model.appliedJiraSearch = 'fix login'
      rerender()
      await Promise.resolve()
    })
    await act(async () => {
      rejectJql(new Error("Error 400: The value 'NOPE' does not exist."))
      await Promise.resolve()
    })
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(3))
    await act(async () => {
      await Promise.resolve()
    })
    expect(model.setJiraJqlRejection).not.toHaveBeenCalledWith(
      expect.objectContaining({ likelyTypo: true })
    )
  })
})
