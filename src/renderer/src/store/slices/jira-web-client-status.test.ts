import { create } from 'zustand'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { withFallback } from '@/web/preload-api/web-fallback-api'
import { createJiraSlice } from './jira'

function createTestStore() {
  return create<AppState>()((...args) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Connection reads use only settings and the fully initialized Jira slice.
    return { settings: null, ...createJiraSlice(...args) } as AppState
  })
}

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
