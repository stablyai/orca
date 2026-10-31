import { afterEach, expect, it } from 'vitest'
import {
  isThreadTab,
  publishStructuredSessionSummaries,
  useStructuredSessionSummaries
} from './structured-session-summary-store'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
const ordinary: AgentSessionStatusSummary = {
  sessionId: 'chat',
  workspaceId: 'main',
  agent: 'codex',
  status: null,
  latestPrompt: '',
  updatedAt: 1
}
const thread: AgentSessionStatusSummary = { ...ordinary, sessionId: 'thread', surface: 'thread' }
afterEach(() =>
  publishStructuredSessionSummaries(
    [...useStructuredSessionSummaries.getState().threadTabIds].map((tabId) => ({
      tabId,
      summary: null
    }))
  )
)
it('filters host strips and card rows only for classified sessions while Threads is enabled', () => {
  publishStructuredSessionSummaries([
    { tabId: 'chat-tab', summary: ordinary },
    { tabId: 'thread-tab', summary: thread }
  ])
  const threadTabIds = useStructuredSessionSummaries.getState().threadTabIds
  const tabs = ['chat-tab', 'thread-tab', 'unknown-tab']
  expect(tabs.filter((id) => !isThreadTab(false, id, threadTabIds))).toEqual(tabs)
  expect(tabs.filter((id) => !isThreadTab(true, id, threadTabIds))).toEqual([
    'chat-tab',
    'unknown-tab'
  ])
  publishStructuredSessionSummaries([{ tabId: 'thread-tab', summary: { ...thread, updatedAt: 2 } }])
  expect(useStructuredSessionSummaries.getState().threadTabIds).toBe(threadTabIds)
  publishStructuredSessionSummaries([{ tabId: 'thread-tab', summary: null }])
  expect(useStructuredSessionSummaries.getState().threadTabIds.has('thread-tab')).toBe(false)
  expect(useStructuredSessionSummaries.getState().orderedIds).toEqual([])
})
