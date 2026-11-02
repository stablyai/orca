import { afterEach, expect, it, vi } from 'vitest'
import { withFallback } from '@/web/preload-api/web-fallback-api'
import { createTestStore } from './store-test-helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('keeps the paired web client disconnected when its unwired Jira preload resolves undefined', async () => {
  // The web client's window.api has no `jira` namespace, so jira.status() hits this fallback.
  vi.stubGlobal('window', { api: withFallback({}, []) })
  const store = createTestStore()

  await expect(store.getState().checkJiraConnection()).resolves.toBeUndefined()

  expect(store.getState().jiraStatus).toEqual({ connected: false, viewer: null })
  expect(store.getState().jiraStatusChecked).toBe(true)
  expect(store.getState().jiraStatusContextKey).toBe('local#0')
})
