import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session/workspace-session-state-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { getStructuredAgentSessionTabs } from './structured-agent-session-tabs'

function chat(id: string, worktreeId: string): Tab {
  return {
    id,
    entityId: 'session-shared',
    groupId: `group-${worktreeId}`,
    worktreeId,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function session(worktreeIds: readonly string[]): WorkspaceSessionState {
  const entries = <V>(value: (worktreeId: string) => V): Record<string, V> =>
    Object.fromEntries(worktreeIds.map((worktreeId) => [worktreeId, value(worktreeId)]))
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: entries((worktreeId) => [chat(`chat-${worktreeId}`, worktreeId)]),
    tabGroups: entries((worktreeId) => [
      {
        id: `group-${worktreeId}`,
        worktreeId,
        activeTabId: `chat-${worktreeId}`,
        tabOrder: [`chat-${worktreeId}`],
        recentTabIds: [`chat-${worktreeId}`]
      }
    ]),
    activeGroupIdByWorktree: entries((worktreeId) => `group-${worktreeId}`)
  }
}

const ids = (tabs: readonly Tab[]) => tabs.map((tab) => tab.id)
// Folder workspace keys are real tab-map keys and valid hydration workspace keys.
const EARLY = folderWorkspaceKey('early')
const LATER = folderWorkspaceKey('later')

// Scoped hydration rebuilds the workspaces it names; the warm chat list must match a cold read.
describe('chat-tab list after scoped session hydration', () => {
  it('follows the hydrated source order for the shared session first match', () => {
    const store = createTestStore()
    const keys = [EARLY, LATER]
    store.getState().hydrateTabsSession(session(keys), { additionalValidWorkspaceKeys: keys })
    expect(ids(getStructuredAgentSessionTabs(store.getState().unifiedTabsByWorktree))).toEqual([
      `chat-${EARLY}`,
      `chat-${LATER}`
    ])

    store.getState().hydrateTabsSession(session([EARLY]), {
      additionalValidWorkspaceKeys: keys,
      replaceWorkspaceKeys: [EARLY]
    })
    const source = store.getState().unifiedTabsByWorktree
    expect(Object.keys(source)).toEqual([LATER, EARLY])
    const warm = getStructuredAgentSessionTabs(source)
    expect(ids(warm)).toEqual([`chat-${LATER}`, `chat-${EARLY}`])
    expect(ids(getStructuredAgentSessionTabs({ ...source }))).toEqual(ids(warm))
    expect(warm.find((tab) => tab.entityId === 'session-shared')?.worktreeId).toBe(LATER)
  })

  it('takes hydrated record order over the selection order', () => {
    const store = createTestStore()
    const keys = [EARLY, LATER]
    store.getState().hydrateTabsSession(session([LATER, EARLY]), {
      additionalValidWorkspaceKeys: keys
    })
    expect(ids(getStructuredAgentSessionTabs(store.getState().unifiedTabsByWorktree))).toEqual([
      `chat-${LATER}`,
      `chat-${EARLY}`
    ])

    store.getState().hydrateTabsSession(session([EARLY, LATER]), {
      additionalValidWorkspaceKeys: keys,
      replaceWorkspaceKeys: [LATER, EARLY]
    })
    const source = store.getState().unifiedTabsByWorktree
    expect(Object.keys(source)).toEqual([EARLY, LATER])
    const warm = getStructuredAgentSessionTabs(source)
    expect(ids(warm)).toEqual([`chat-${EARLY}`, `chat-${LATER}`])
    expect(ids(getStructuredAgentSessionTabs({ ...source }))).toEqual(ids(warm))
  })
})
