import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeUnifiedTab } from '../tabs/tab-group.test-fixture'
import { withWorktreeTabEntry } from '@/runtime/web-session-tabs-sync/presentation-record-drafts'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { acceptedAgentStatuses, AcceptedAgentStatuses } from './accepted-agent-statuses'

afterEach(() => vi.restoreAllMocks())

it.each([100, 1000])('addresses tab changes beside %i unrelated recognized chats', (count) => {
  const now = 1000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const store = createTestStore()
  const visits: string[] = []
  const chats = Array.from({ length: count }, (_, index) => {
    const id = `native-${index}`
    const tab = makeUnifiedTab({
      id,
      worktreeId: `workspace-${index}`,
      groupId: 'group',
      contentType: 'agent-session',
      entityId: `session-${index}`,
      agentSessionAgent: 'claude'
    })
    Object.defineProperty(tab, 'id', {
      enumerable: true,
      get: () => {
        visits.push(id)
        return id
      }
    })
    return tab
  })
  const key = structuredAgentSessionPaneKey('native-0', 'session-0')
  const terminal = makeUnifiedTab({
    id: 'target',
    worktreeId: 'target-workspace',
    groupId: 'group'
  })
  store.setState({
    unifiedTabsByWorktree: {
      ...Object.fromEntries(chats.map((tab) => [tab.worktreeId, [tab]])),
      'target-workspace': [terminal]
    },
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        key,
        {
          paneKey: key,
          worktreeId: 'workspace-0',
          state: 'working',
          agentType: 'claude',
          prompt: 'Native task',
          updatedAt: now,
          stateStartedAt: now,
          stateHistory: []
        }
      ]
    ])
  })
  const reads = vi.spyOn(AcceptedAgentStatuses.prototype, 'get')
  visits.length = 0
  store.setState((state) => ({
    unifiedTabsByWorktree: withWorktreeTabEntry(
      state,
      'unifiedTabsByWorktree',
      'target-workspace',
      [{ ...terminal, label: 'Updated shell' }],
      (previous, next) => previous === next
    )
  }))
  expect(visits).toEqual([])
  expect(reads).not.toHaveBeenCalled()
  expect(store.getState().unifiedTabsByWorktree['target-workspace'][0].label).toBe('Updated shell')

  const changed = { ...chats[0], label: 'Updated chat' }
  visits.length = 0
  reads.mockClear()
  store.setState((state) => ({
    unifiedTabsByWorktree: withWorktreeTabEntry(
      state,
      'unifiedTabsByWorktree',
      'workspace-0',
      [changed],
      (previous, next) => previous === next
    )
  }))
  expect(visits.filter((id) => id !== 'native-0')).toEqual([])
  expect(new Set(reads.mock.calls.map(([paneKey]) => paneKey))).toEqual(new Set([key]))
  expect(
    store
      .getState()
      .agentStatusByPaneKey.projection.list('workspace-0')
      .map((row) => row.entry.prompt)
  ).toEqual(['Native task'])
})
