import { beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'

const jiraStatus = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-jira-client', () => ({ jiraStatus }))

beforeEach(() => {
  jiraStatus.mockReset()
})

it.each([false, true])(
  'clears the old disconnected host capability when the new status read fails (checked: %s)',
  async (jiraStatusChecked) => {
    const store = createTestStore()
    store.setState({
      jiraStatus: { connected: false, viewer: null, supportsScopedTokens: true },
      jiraStatusChecked,
      jiraStatusContextKey: 'runtime:old-host#0'
    })
    jiraStatus.mockRejectedValueOnce(new Error('Host unavailable'))
    await store.getState().checkJiraConnection()
    expect(store.getState().jiraStatus).toEqual({ connected: false, viewer: null })
    expect(store.getState().jiraStatusChecked).toBe(true)
    expect(store.getState().jiraStatusContextKey).toBe('local#0')
  }
)
