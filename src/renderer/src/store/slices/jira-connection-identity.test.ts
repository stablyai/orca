import { create } from 'zustand'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { JiraConnectionStatus } from '../../../../shared/jira-types'
import { createJiraSlice } from './jira'

const jiraStatus = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-jira-client', () => ({ jiraStatus }))

function createTestStore() {
  return create<AppState>()((...args) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Connection reads use only settings and the fully initialized Jira slice.
    return { settings: null, ...createJiraSlice(...args) } as AppState
  })
}

function status(accountId: string): JiraConnectionStatus {
  return {
    connected: true,
    viewer: { accountId, email: 'same@example.com', displayName: 'Same name' },
    selectedSiteId: 'all',
    activeSiteId: 'site-a',
    sites: [
      {
        id: 'site-a',
        accountId,
        email: 'same@example.com',
        displayName: 'Same name',
        siteUrl: 'https://jira.example'
      }
    ]
  }
}

beforeEach(() => jiraStatus.mockReset())

it('replaces status when the provider context changes even if its visible values are identical', async () => {
  const store = createTestStore()
  const previous = status('account-a')
  const next = status('account-a')
  store.setState({
    jiraStatus: previous,
    jiraStatusChecked: true,
    jiraStatusContextKey: 'old-host'
  })
  jiraStatus.mockResolvedValue(next)
  await store.getState().checkJiraConnection()
  expect(store.getState().jiraStatus).toBe(next)
  expect(store.getState().jiraStatusContextKey).toBe('local#0')
})

it.each(['viewer', 'site', 'active site'] as const)(
  'refreshes a changed %s identity on the same host',
  async (change) => {
    const store = createTestStore()
    jiraStatus.mockResolvedValueOnce(status('account-a'))
    await store.getState().checkJiraConnection()
    const next = status('account-a')
    if (change === 'viewer') {
      next.viewer = { accountId: 'account-b', email: 'same@example.com', displayName: 'Same name' }
    }
    if (change === 'site') {
      next.sites = status('account-b').sites
    }
    if (change === 'active site') {
      next.activeSiteId = 'site-b'
    }
    jiraStatus.mockResolvedValueOnce(next)
    await store.getState().checkJiraConnection()
    expect(store.getState().jiraStatus).toBe(next)
  }
)

it('preserves the status reference for an unchanged identity on the same host', async () => {
  const store = createTestStore()
  const initial = status('account-a')
  jiraStatus.mockResolvedValueOnce(initial).mockResolvedValueOnce(status('account-a'))
  await store.getState().checkJiraConnection()
  await store.getState().checkJiraConnection()
  expect(store.getState().jiraStatus).toBe(initial)
})
