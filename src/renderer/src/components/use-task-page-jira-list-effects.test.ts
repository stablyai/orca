// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPageLinearCollectionEffectsModel } from './use-task-page-linear-collection-effects'
import { useTaskPageJiraListEffects } from './use-task-page-jira-list-effects'

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
    jiraSearchInput: '',
    appliedJiraSearch: '',
    setAppliedJiraSearch: vi.fn(),
    activeJiraPreset: 'assigned',
    jiraRefreshNonce: 0,
    setJiraProjectStatusOrder: vi.fn(),
    displayedJiraIssues: []
  }
  // SAFETY: the hook only reads the Jira fields above; the preceding pipeline model is intentionally not constructed in this isolated wiring test.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the partial fixture intentionally models only fields read by this hook.
  return model as unknown as TaskPageLinearCollectionEffectsModel
}

describe('useTaskPageJiraListEffects refresh wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listJiraIssues.mockResolvedValue([])
    searchJiraIssues.mockResolvedValue([])
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
})
