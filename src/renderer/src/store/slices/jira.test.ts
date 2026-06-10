import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { JiraIssue } from '../../../../shared/types'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import { createJiraSlice } from './jira'

const jiraGetIssue = vi.fn()
const jiraListIssues = vi.fn()
const jiraSearchIssues = vi.fn()
const jiraStatus = vi.fn()

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraConnect: vi.fn(),
  jiraDisconnect: vi.fn(),
  jiraGetIssue: (...args: unknown[]) => jiraGetIssue(...args),
  jiraListIssues: (...args: unknown[]) => jiraListIssues(...args),
  jiraSearchIssues: (...args: unknown[]) => jiraSearchIssues(...args),
  jiraSelectSite: vi.fn(),
  jiraStatus: (...args: unknown[]) => jiraStatus(...args),
  jiraTestConnection: vi.fn()
}))

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: null,
        ...createJiraSlice(...a)
      }) as AppState
  )
}

function issue(key: string): JiraIssue {
  return {
    id: key,
    key,
    title: key,
    url: `https://example.atlassian.net/browse/${key}`,
    siteId: 'site-1',
    siteName: 'Example Jira',
    project: { id: '10000', key: 'ALP', name: 'Alpha', siteId: 'site-1' },
    issueType: { id: '10001', name: 'Bug' },
    status: { id: '1', name: 'Todo', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('createJiraSlice credential errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serves fresh Jira cache without reading credentials', async () => {
    const store = createTestStore()
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' },
      jiraSearchCache: {
        'site-1::list::assigned::30': { data: [issue('ALP-1')], fetchedAt: Date.now() }
      }
    })

    await expect(store.getState().listJiraIssues('assigned', 30)).resolves.toMatchObject([
      { key: 'ALP-1' }
    ])

    expect(jiraListIssues).not.toHaveBeenCalled()
  })

  it('returns an empty list and surfaces the credential error in status on Jira decrypt errors', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('Jira'))
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    jiraStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      selectedSiteId: 'site-1',
      credentialError: error.message
    })
    jiraSearchIssues.mockRejectedValueOnce(error)

    await expect(store.getState().searchJiraIssues('project = ALP', 30)).resolves.toEqual([])
    await vi.waitFor(() => {
      expect(store.getState().jiraStatus.credentialError).toBe(error.message)
    })
  })

  it('returns null and refreshes status on Jira decrypt errors during detail refresh', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('Jira'))
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' },
      jiraIssueCache: {
        'site-1::ALP-1': { data: issue('ALP-1'), fetchedAt: 1 }
      }
    })
    jiraStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      selectedSiteId: 'site-1',
      credentialError: error.message
    })
    jiraGetIssue.mockRejectedValueOnce(error)

    await expect(store.getState().fetchJiraIssue('ALP-1', 'site-1')).resolves.toBeNull()
    expect(jiraStatus).toHaveBeenCalled()
  })
})
