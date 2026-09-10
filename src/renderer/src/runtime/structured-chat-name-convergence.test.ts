// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import { buildPersistedUnifiedTabSessionData } from '../lib/workspace-session-unified-tabs'
import {
  applyWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'

const WORKTREE_ID = 'repo-1::worktree-1'
const GROUP_ID = 'group-1'
const LOCAL_TAB_ID = 'structured-agent-session-codex-1'
const HOST_TAB_ID = 'agent-session:codex-1'
const OWNER = 'local-structured-session'

afterEach(() => resetWebSessionTabsSnapshotFreshnessForTests())

function stateWithLocalName(customLabel: string | null): WebSessionTabsSyncState {
  const tab: Tab = {
    id: LOCAL_TAB_ID,
    entityId: 'codex-1',
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    activeTabId: LOCAL_TAB_ID,
    activeTabIdByWorktree: { [WORKTREE_ID]: LOCAL_TAB_ID },
    activeTabType: 'agent-session',
    activeTabTypeByWorktree: { [WORKTREE_ID]: 'agent-session' },
    activeWorktreeId: WORKTREE_ID,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: GROUP_ID,
          worktreeId: WORKTREE_ID,
          activeTabId: LOCAL_TAB_ID,
          tabOrder: [LOCAL_TAB_ID]
        }
      ]
    },
    layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf', groupId: GROUP_ID } },
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: { [WORKTREE_ID]: [LOCAL_TAB_ID] },
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { [WORKTREE_ID]: [tab] },
    unreadTerminalTabs: {},
    sortEpoch: 0
  } as unknown as WebSessionTabsSyncState
}

/** A host frame carrying the chat. `customTitle` omitted models a host that predates the field. */
function hostFrame(agentTab: Record<string, unknown>): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'host:1',
    snapshotVersion: 1,
    activeGroupId: GROUP_ID,
    activeTabId: HOST_TAB_ID,
    activeTabType: 'agent-session',
    tabGroups: [{ id: GROUP_ID, activeTabId: HOST_TAB_ID, tabOrder: [HOST_TAB_ID] }],
    tabs: [
      {
        type: 'agent-session',
        id: HOST_TAB_ID,
        sessionId: 'codex-1',
        agent: 'codex',
        isActive: true,
        ...agentTab
      }
    ]
  } as unknown as RuntimeMobileSessionTabsResult
}

function ingest(
  state: WebSessionTabsSyncState,
  frame: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(state, frame, OWNER, Date.now(), {
    contentScope: 'agent-session',
    preserveLocalLayout: true,
    terminalPtyMode: 'local'
  })
  return { ...state, ...patch } as WebSessionTabsSyncState
}

function chatTab(state: WebSessionTabsSyncState): Tab | undefined {
  return state.unifiedTabsByWorktree[WORKTREE_ID]?.find(
    (tab) => tab.contentType === 'agent-session'
  )
}

/** What the tab bar actually paints. */
function renderedLabel(state: WebSessionTabsSyncState): string {
  return resolveUnifiedTabLabel(chatTab(state), false)
}

describe('a chat name converging across clients', () => {
  it('renders another client rename instead of pinning this client stale one', () => {
    // This client renamed to Alpha; someone else has since renamed it to Beta on the host.
    const before = stateWithLocalName('Alpha')
    expect(renderedLabel(before)).toBe('Alpha')

    const after = ingest(before, hostFrame({ title: 'Beta', customTitle: 'Beta' }))

    expect(renderedLabel(after)).toBe('Beta')
    expect(chatTab(after)?.customLabel).toBe('Beta')
  })

  it('keeps a local rename when the host predates host-owned chat names', () => {
    const before = stateWithLocalName('Alpha')

    // No customTitle key at all: this host cannot report a name, and its placeholder title
    // must not be read as "the user cleared it".
    const after = ingest(before, hostFrame({ title: 'Codex Chat' }))

    expect(renderedLabel(after)).toBe('Alpha')
    expect(chatTab(after)?.customLabel).toBe('Alpha')
  })

  it('drops the local name when the host reports the chat as unnamed', () => {
    const before = stateWithLocalName('Alpha')

    const after = ingest(before, hostFrame({ title: 'Codex Chat', customTitle: null }))

    expect(renderedLabel(after)).toBe('Codex Chat')
    expect(chatTab(after)?.customLabel).toBeNull()
  })

  it('keeps a chat the user deliberately named after its own placeholder', () => {
    // The two fields exist for exactly this pair. Both frames carry the identical rendered
    // `title`, so a client with only that field cannot tell them apart and has to guess by
    // comparing against the placeholder — which discards this user's real name.
    const named = ingest(
      stateWithLocalName(null),
      hostFrame({ title: 'Codex Chat', customTitle: 'Codex Chat' })
    )
    const neverNamed = ingest(
      stateWithLocalName(null),
      hostFrame({ title: 'Codex Chat', customTitle: null })
    )

    expect(renderedLabel(named)).toBe('Codex Chat')
    expect(renderedLabel(neverNamed)).toBe('Codex Chat')
    // Identical on screen, and they must stay distinct underneath: the named one keeps a real
    // name that survives a restore, the other must not acquire one it was never given.
    expect(chatTab(named)?.customLabel).toBe('Codex Chat')
    expect(chatTab(neverNamed)?.customLabel).toBeNull()

    const persistedNamed = buildPersistedUnifiedTabSessionData(named).unifiedTabs?.[
      WORKTREE_ID
    ]?.find((tab) => tab.contentType === 'agent-session')
    expect(persistedNamed?.customLabel).toBe('Codex Chat')
  })

  it('persists the host name, so the desktop session write cannot revert it to the placeholder', () => {
    // The renderer rewrites the whole persisted unifiedTabs array on any tab action, and the
    // host seeds a restarted chat's name from that same customLabel. If ingestion left it null
    // the next desktop tab action would erase the host's copy and the name would come back as
    // the placeholder after a restart, with no error anywhere.
    const after = ingest(
      stateWithLocalName(null),
      hostFrame({ title: 'Beta', customTitle: 'Beta' })
    )

    const persisted = buildPersistedUnifiedTabSessionData(after)
    const persistedChat = persisted.unifiedTabs?.[WORKTREE_ID]?.find(
      (tab) => tab.contentType === 'agent-session'
    )
    expect(persistedChat?.customLabel).toBe('Beta')
  })
})
