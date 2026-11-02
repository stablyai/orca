// @vitest-environment happy-dom

// The window follows the host's derived per-workspace frames; it never infers a move across workspaces.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'

// The shipped layout owner: the window saves what it shows, so its tabs must converge.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

import { useAppStore } from '@/store'
import { applyStructuredSessionTabSnapshots } from './snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './inventory-generation-fence'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../web-session-tabs-sync/tracking-lifecycle'

const OLD = 'retired::/project'
const NEW = 'current::/project'
const FOREIGN = 'foreign-retired::/elsewhere'
// Chat tab IDs derive from the session alone, so they repeat across workspaces and hosts.
const MOVED = structuredAgentSessionTabId('moved')
const KEPT = structuredAgentSessionTabId('kept')

function chat(sessionId: string, worktreeId: string, executionHostId = 'local'): Tab {
  return {
    id: structuredAgentSessionTabId(sessionId),
    entityId: sessionId,
    groupId: `group-${worktreeId}`,
    worktreeId,
    executionHostId,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function frame(
  worktree: string,
  version: number,
  sessions: string[]
): RuntimeMobileSessionTabsResult {
  const ids = sessions.map(structuredAgentSessionTabId)
  return {
    worktree,
    publicationEpoch: 'host',
    snapshotVersion: version,
    activeGroupId: 'host-group',
    activeTabId: ids[0] ?? null,
    activeTabType: ids.length ? 'agent-session' : null,
    tabGroups: [{ id: 'host-group', activeTabId: ids[0] ?? null, tabOrder: ids }],
    tabs: sessions.map((sessionId, index) => ({
      type: 'agent-session' as const,
      id: ids[index],
      title: 'Chat',
      sessionId,
      agent: 'codex' as const,
      isActive: index === 0
    }))
  }
}

const repo = (id: string) => ({
  id,
  path: '/project',
  displayName: id,
  badgeColor: '#000',
  addedAt: 0
})
const sessionsAt = (worktreeId: string) =>
  useAppStore.getState().unifiedTabsByWorktree[worktreeId]?.map((tab) => tab.entityId)

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const old = [chat('moved', OLD), chat('kept', OLD)]
  useAppStore.setState({
    // The old registration has returned and the destination tab already exists.
    repos: [repo('current'), repo('retired')],
    unifiedTabsByWorktree: {
      [OLD]: old,
      [NEW]: [chat('moved', NEW)],
      [FOREIGN]: [chat('moved', FOREIGN, 'runtime:foreign')]
    },
    groupsByWorktree: {
      [OLD]: [{ id: `group-${OLD}`, worktreeId: OLD, activeTabId: MOVED, tabOrder: [MOVED, KEPT] }]
    },
    tabBarOrderByWorktree: { [OLD]: [MOVED, KEPT] }
  })
})

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

it('drops a moved chat only from the workspace whose newer host frame omits it', () => {
  applyStructuredSessionTabSnapshots([frame(NEW, 1, ['moved'])])
  applyStructuredSessionTabSnapshots([frame(NEW, 2, ['moved'])])
  // Another workspace's frame is not evidence about this one.
  expect(sessionsAt(OLD)).toEqual(['moved', 'kept'])

  applyStructuredSessionTabSnapshots([frame(OLD, 2, ['kept'])])

  const state = useAppStore.getState()
  expect(sessionsAt(OLD)).toEqual(['kept'])
  expect(state.groupsByWorktree[OLD]?.[0]).toMatchObject({ tabOrder: [KEPT], activeTabId: KEPT })
  expect(state.tabBarOrderByWorktree[OLD]).toEqual([KEPT])
  expect(sessionsAt(NEW)).toEqual(['moved'])
  expect(state.unifiedTabsByWorktree[FOREIGN]?.map((tab) => tab.executionHostId)).toEqual([
    'runtime:foreign'
  ])
})

it('keeps the published destination and a foreign same-ID tab while the catalog knows neither registration', () => {
  useAppStore.setState({
    repos: [],
    unifiedTabsByWorktree: {
      [OLD]: [chat('moved', OLD)],
      [FOREIGN]: [chat('moved', FOREIGN, 'runtime:foreign')]
    }
  })

  applyStructuredSessionTabSnapshots([frame(NEW, 1, ['moved'])])

  expect(sessionsAt(NEW)).toEqual(['moved'])
  expect(
    useAppStore.getState().unifiedTabsByWorktree[FOREIGN]?.map((tab) => tab.executionHostId)
  ).toEqual(['runtime:foreign'])
})
