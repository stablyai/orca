// PR 2b: main publishes a structured (native chat) session's row over `agentStatus:set`, and the
// renderer applies it instead of deriving its own. A structured pane key resolves to no terminal
// tab, so before this the applicator held every such row as `pending` forever — removing main's
// two filters on its own would have published rows the renderer then dropped on the floor.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWorktreeAgentRows } from '@/components/sidebar/worktree-agent-rows'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { createTestStore } from '@/store/slices/store-test-helpers'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { AgentStatusSetData } from '../ipc-events-agent-status-store-test-fixtures'
import { buildWindowApi } from '../ipc-events-agent-status-window-test-fixtures'

vi.mock('../agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn(),
  syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
}))

const SESSION_ID = 'session-2b'
const WORKTREE_ID = 'repo-1::/wt-1'
const STRUCTURED_PANE_KEY = structuredAgentSessionPaneKey(SESSION_ID)
const PTY_PANE_KEY = makePaneKey('tab-pty', '11111111-1111-4111-8111-111111111111')

const structuredTab: Tab = {
  id: structuredAgentSessionTabId(SESSION_ID),
  worktreeId: WORKTREE_ID,
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: SESSION_ID,
  label: 'Refactor the store',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex'
}

/** Exactly the shape `main/startup/main-window-agent-status.ts` sends for a structured row. */
function hostRow(over: Partial<AgentStatusIpcPayload> = {}): AgentStatusSetData {
  const now = Date.now()
  return {
    paneKey: STRUCTURED_PANE_KEY,
    tabId: structuredAgentSessionTabId(SESSION_ID),
    worktreeId: WORKTREE_ID,
    connectionId: null,
    state: 'working',
    agentType: 'codex',
    prompt: 'hello',
    receivedAt: now,
    stateStartedAt: now,
    evidenceObservedAt: now,
    structuredHost: 'owned',
    ...over
  } as AgentStatusSetData
}

function ptyRow(over: Partial<AgentStatusIpcPayload> = {}): AgentStatusSetData {
  const now = Date.now()
  return {
    paneKey: PTY_PANE_KEY,
    tabId: 'tab-pty',
    worktreeId: WORKTREE_ID,
    connectionId: null,
    state: 'working',
    agentType: 'claude',
    prompt: 'pty work',
    receivedAt: now,
    stateStartedAt: now,
    ...over
  } as AgentStatusSetData
}

async function withBridge(
  run: (args: {
    store: ReturnType<typeof createTestStore>
    send: (row: AgentStatusSetData) => void
  }) => Promise<void>
): Promise<void> {
  vi.resetModules()
  const store = createTestStore()
  store.setState({
    workspaceSessionReady: true,
    activeWorktreeId: null,
    unifiedTabsByWorktree: { [WORKTREE_ID]: [structuredTab] },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab-pty',
          ptyId: 'pty-1',
          worktreeId: WORKTREE_ID,
          title: 'Claude',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-pty': {
        root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
        activeLeafId: '11111111-1111-4111-8111-111111111111',
        expandedLeafId: null,
        titlesByLeafId: {}
      }
    }
  } as never)
  let onSet: (payload: AgentStatusSetData) => void = () => {
    throw new Error('listener missing')
  }
  vi.doMock('../../store', () => ({ useAppStore: store }))
  vi.stubGlobal(
    'window',
    buildWindowApi({
      getSnapshot: async () => [],
      onSet: (callback) => {
        onSet = callback
        return () => {}
      }
    })
  )
  const { registerAgentStatusIpcBridge } = await import('./agent-status-ipc-bridge')
  const unsubs: (() => void)[] = []
  const bridge = registerAgentStatusIpcBridge(unsubs)
  try {
    await run({ store, send: (row) => onSet(row) })
  } finally {
    bridge.disposeAsyncState()
    bridge.unsubscribeStore()
    unsubs.forEach((unsubscribe) => unsubscribe())
  }
}

afterEach(() => {
  vi.doUnmock('../../store')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a host-published structured session row', () => {
  it('lands as exactly one row, on the key the host and the renderer both derive', async () => {
    await withBridge(async ({ store, send }) => {
      send(hostRow())
      await vi.waitFor(() => {
        expect(store.getState().agentStatusByPaneKey[STRUCTURED_PANE_KEY]).toBeDefined()
      })

      const rows = store.getState().agentStatusByPaneKey
      expect(Object.keys(rows)).toEqual([STRUCTURED_PANE_KEY])
      expect(rows[STRUCTURED_PANE_KEY]).toMatchObject({
        state: 'working',
        prompt: 'hello',
        agentType: 'codex',
        worktreeId: WORKTREE_ID,
        // No terminal to resume into; without this Orca offers to relaunch the chat as a TUI.
        terminalResumeEligible: false,
        structuredHostOwned: true
      })
    })
  })

  it('settles to done on the same key instead of sticking on working', async () => {
    await withBridge(async ({ store, send }) => {
      send(hostRow())
      await vi.waitFor(() => {
        expect(store.getState().agentStatusByPaneKey[STRUCTURED_PANE_KEY]?.state).toBe('working')
      })
      send(hostRow({ state: 'done', receivedAt: Date.now() + 10 }))
      await vi.waitFor(() => {
        expect(store.getState().agentStatusByPaneKey[STRUCTURED_PANE_KEY]?.state).toBe('done')
      })

      expect(Object.keys(store.getState().agentStatusByPaneKey)).toEqual([STRUCTURED_PANE_KEY])
    })
  })

  // The bypass in shared/agent-status-freshness.ts fires on `structuredHostOwned`, which the wire
  // spells `structuredHost: 'owned'`. Lose the mapping and every native chat that works for over
  // half an hour silently decays to idle in the sidebar.
  it('stays fresh past the 30-minute window while the host owns it', async () => {
    await withBridge(async ({ store, send }) => {
      const observedAt = Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1
      send(hostRow({ evidenceObservedAt: observedAt }))
      await vi.waitFor(() => {
        expect(store.getState().agentStatusByPaneKey[STRUCTURED_PANE_KEY]).toBeDefined()
      })

      const entry = store.getState().agentStatusByPaneKey[STRUCTURED_PANE_KEY]
      expect(entry.structuredHostOwned).toBe(true)
      expect(isExplicitAgentStatusFresh(entry, Date.now(), AGENT_STATUS_STALE_AFTER_MS)).toBe(true)
    })
  })

  it('drops the ownership flag once the host revokes live execution', async () => {
    await withBridge(async ({ store, send }) => {
      send(hostRow())
      await vi.waitFor(() => {
        expect(store.getState().agentStatusByPaneKey[STRUCTURED_PANE_KEY]).toBeDefined()
      })
      send(hostRow({ structuredHost: 'held', receivedAt: Date.now() + 10 }))
      await vi.waitFor(() => {
        expect(
          store.getState().agentStatusByPaneKey[STRUCTURED_PANE_KEY]?.structuredHostOwned
        ).toBeUndefined()
      })
    })
  })

  // The wire carries no title (deliberately: naming a structured session is its own lane), so the
  // row's name has to come from this renderer's own tab state. The sidebar synthesizes a tab for a
  // paneless row and would otherwise name it 'Agent'.
  it('names its sidebar row from the session tab, not the wire', async () => {
    await withBridge(async ({ store, send }) => {
      send(hostRow())
      await vi.waitFor(() => {
        expect(store.getState().agentStatusByPaneKey[STRUCTURED_PANE_KEY]).toBeDefined()
      })

      const entry = store.getState().agentStatusByPaneKey[STRUCTURED_PANE_KEY]
      const rows = buildWorktreeAgentRows({
        tabs: [],
        entries: [entry as AgentStatusEntry],
        retained: [],
        now: Date.now()
      })

      expect(rows).toHaveLength(1)
      expect(rows[0].tab.title).toBe('Refactor the store')
      expect(rows[0].paneKey).toBe(STRUCTURED_PANE_KEY)
    })
  })

  // A terminal tab in chat view mode is backed by a structured session too, and its own pane
  // already has a row. Admitting the host's row for that session as well puts two rows in the
  // sidebar for one tab — so the renderer requires an `agent-session` surface, which is narrower
  // than the admission rule `worktree ps` uses and is exactly what the sidebar showed before.
  it('does not admit a session with no agent-session surface in this renderer', async () => {
    await withBridge(async ({ store, send }) => {
      store.setState({ unifiedTabsByWorktree: { [WORKTREE_ID]: [] } } as never)
      send(hostRow())
      send(ptyRow())
      await vi.waitFor(() => {
        expect(store.getState().agentStatusByPaneKey[PTY_PANE_KEY]).toBeDefined()
      })

      expect(Object.keys(store.getState().agentStatusByPaneKey)).toEqual([PTY_PANE_KEY])
    })
  })

  it('leaves a PTY row untouched', async () => {
    await withBridge(async ({ store, send }) => {
      send(ptyRow())
      await vi.waitFor(() => {
        expect(store.getState().agentStatusByPaneKey[PTY_PANE_KEY]).toBeDefined()
      })

      const entry = store.getState().agentStatusByPaneKey[PTY_PANE_KEY]
      expect(entry).toMatchObject({ state: 'working', agentType: 'claude' })
      expect(entry.structuredHostOwned).toBeUndefined()
      expect(entry.terminalResumeEligible).toBeUndefined()
    })
  })
})
