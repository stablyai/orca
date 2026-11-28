import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeStructuredChatTab } from '@/store/slices/tabs/tab-group.test-fixture'
import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import { projectStatus } from './structured-agent-session-status-projection'
import type { StructuredTab } from './structured-agent-session-tabs'

const chatTab = makeStructuredChatTab({
  id: 'chat-tab',
  entityId: 'session-1',
  worktreeId: 'wt-1',
  agentSessionAgent: 'claude',
  label: 'Claude'
})
if (!isStructuredTab(chatTab)) {
  throw new Error('fixture is not a chat tab')
}
const tab: StructuredTab = chatTab
const paneKey = chatPaneKey(tab.entityId)
const openedAt = Date.UTC(2026, 0, 15, 12, 0, 0)

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: tab.entityId,
    workspaceId: tab.worktreeId,
    agent: 'claude',
    status: null,
    latestPrompt: '',
    updatedAt: openedAt,
    ...overrides
  }
}

function project(
  next: AgentSessionStatusSummary | null,
  failedAt: number | null = null
): ReturnType<typeof useAppStore.getState>['agentStatusByPaneKey'] {
  useAppStore
    .getState()
    .transactAgentStatuses((transaction) => projectStatus(transaction, tab, next, 'live', failedAt))
  return useAppStore.getState().agentStatusByPaneKey
}

const sidebarRows = () =>
  useAppStore
    .getState()
    .agentStatusByPaneKey.projection.list(tab.worktreeId)
    .map((row) => row.paneKey)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(openedAt)
  useAppStore.setState({ unifiedTabsByWorktree: { [tab.worktreeId]: [tab] } })
  useAppStore.getState().transactAgentStatuses((transaction) => {
    transaction.getState().removeAgentStatus(paneKey)
  })
})

afterEach(() => {
  vi.useRealTimers()
})

it('shows a chat with no request yet as an idle session-boundary row, updated in place by the first send', () => {
  expect(project(summary()).get(paneKey)).toMatchObject({
    state: 'done',
    prompt: '',
    sessionBoundary: true,
    tabId: tab.id,
    worktreeId: tab.worktreeId
  })
  expect(sidebarRows()).toEqual([paneKey])
  // An unchanged host tick must not write the store.
  const before = useAppStore.getState().agentStatusByPaneKey
  expect(project(summary())).toBe(before)
  const sent = project(
    summary({ status: 'working', latestPrompt: 'hello', updatedAt: openedAt + 1 })
  ).get(paneKey)
  expect(sent).toMatchObject({ state: 'working', prompt: 'hello', sessionBoundary: false })
  expect(sidebarRows()).toEqual([paneKey])
})

it('still removes the row when the host knows no session and publishes a failed launch', () => {
  project(summary())
  expect(project(null).get(paneKey)).toBeUndefined()
  const failed = project(summary(), 500).get(paneKey)
  expect(failed).toMatchObject({ state: 'done', mainAgent: { outcome: 'failure' } })
})

it('keeps the opened time when the host republishes a chat that has no request yet', () => {
  project(summary())
  const republished = project(summary({ model: 'opus', updatedAt: openedAt + 60_000 })).get(paneKey)
  expect(republished).toMatchObject({ model: 'opus', stateStartedAt: openedAt })
})
