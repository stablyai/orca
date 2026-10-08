// @vitest-environment happy-dom

/**
 * After /clear the current chat keeps the tab id derived from its first session, so reopening that
 * first session from history lands in a suffixed tab. Closing or focusing the reopened tab from
 * main must reach that tab, not the current chat. Runs the real main close/focus path against the
 * real window store, mirror and IPC bridges; only the process boundary is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import type * as RuntimeRpcClient from '../../src/renderer/src/runtime/runtime-rpc-client'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { useAppStore } from '../../src/renderer/src/store'
import { applyStructuredSessionTabSnapshots } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../../src/renderer/src/runtime/web-session-tabs-sync'
import { registerSessionTabIpcBridge } from '../../src/renderer/src/hooks/ipc-events/session-tab-ipc-bridge'
import { registerTerminalUiRoutingIpcBridge } from '../../src/renderer/src/hooks/ipc-events/terminal-ui-routing-ipc-bridge'

const WORKTREE = 'repo-1::/tmp/wt-reopen'
const CURRENT_SESSION = 'clear-x'
const REOPENED_SESSION = 'session-s'
const CURRENT_TAB = `structured-agent-session-${REOPENED_SESSION}`
const REOPENED_TAB = `${CURRENT_TAB}:history-1`

type CloseRequest = { requestId: string; tabId: string; worktreeId: string; expiresAt?: number }
type Listener<T> = (payload: T) => void

type ProcessBoundary = {
  runtime: Pick<OrcaRuntimeService, 'closeMobileSessionTab'> | null
  rendererSessionCloses: string[]
}

const bridge = vi.hoisted((): ProcessBoundary => ({
  runtime: null,
  rendererSessionCloses: []
}))

vi.mock('../../src/renderer/src/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClient>()
  return {
    ...actual,
    callRuntimeRpc: async (
      _target: unknown,
      method: string,
      params: { worktree: string; tabId: string; reason?: 'user' }
    ) => {
      if (method !== 'session.tabs.close') {
        throw new Error(`unexpected rpc ${method}`)
      }
      return bridge.runtime!.closeMobileSessionTab(params.worktree, params.tabId, {
        reason: params.reason
      })
    }
  }
})

vi.mock('../../src/renderer/src/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: async (_target: unknown, sessionId: string) => {
    bridge.rendererSessionCloses.push(sessionId)
    return 'closed'
  }
}))

async function setup() {
  const listeners: {
    closeSessionTab?: Listener<{ tabId: string; worktreeId: string }>
    closeRequest?: Listener<CloseRequest>
    focusEditorTab?: Listener<{ tabId: string; worktreeId: string; userInitiated?: boolean }>
  } = {}
  const pendingResponses = new Map<string, (error?: string) => void>()
  const register =
    <T>(assign: (listener: Listener<T>) => void) =>
    (listener: Listener<T>) => {
      assign(listener)
      return () => {}
    }
  const noop = () => () => {}
  vi.stubGlobal('api', {
    ui: {
      onCloseSessionTab: register((l) => (listeners.closeSessionTab = l)),
      onSessionTabCloseRequest: register((l) => (listeners.closeRequest = l)),
      onFocusEditorTab: register((l) => (listeners.focusEditorTab = l)),
      onMoveSessionTab: noop,
      onSplitTerminal: noop,
      onRenameTerminal: noop,
      onFocusTerminal: noop,
      respondSessionTabClose: ({ requestId, error }: { requestId: string; error?: string }) =>
        pendingResponses.get(requestId)?.(error)
    }
  })
  registerSessionTabIpcBridge([])
  registerTerminalUiRoutingIpcBridge([])

  const hostSessionCloses: string[] = []
  const closeResponses: (string | undefined)[] = []
  const runtime = new OrcaRuntimeService()
  bridge.runtime = runtime
  let nextRequest = 0
  runtime.setNotifier(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat close and focus paths call only these two notifier members.
    {
      // Same contract as the window relay: a request the renderer answers with an optional error.
      closeSessionTab: (tabId: string, worktreeId: string) =>
        new Promise<void>((resolve, reject) => {
          const requestId = `close-${++nextRequest}`
          pendingResponses.set(requestId, (error) => {
            closeResponses.push(error)
            return error ? reject(new Error(error)) : resolve()
          })
          listeners.closeRequest!({ requestId, tabId, worktreeId })
        }),
      focusEditorTab: (tabId: string, worktreeId: string) =>
        listeners.focusEditorTab!({ tabId, worktreeId })
    } as never
  )
  // No durable store, PTYs or workspace session on disk: the host tab list below is the whole state.
  Object.assign(runtime, {
    hasPersistedStructuredAgentSessionStore: () => true,
    getKnownWorkspaceSessionWorktreeIds: () => new Set(),
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => new Set(),
    refreshMobileSessionPtyRecords: async () => new Set(),
    ensureStructuredAgentSessionHost: async () => undefined
  })
  setStructuredAgentSessionHost(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore and tab close call only these host members.
    {
      reconcileRestartLeases: async () => undefined,
      restoreReadableSessions: async () => undefined,
      close: async (sessionId: string) => {
        hostSessionCloses.push(sessionId)
      },
      setSessionTabVisibility: async () => undefined,
      listSessionTabs: () => [
        { sessionId: CURRENT_SESSION, workspaceId: WORKTREE, agent: 'claude' },
        { sessionId: REOPENED_SESSION, workspaceId: WORKTREE, agent: 'claude' }
      ]
    } as never
  )
  await runtime.restoreStructuredAgentSessionTabs()
  const hostSnapshot: RuntimeMobileSessionTabsResult = await runtime.listMobileSessionTabs(
    `id:${WORKTREE}`
  )

  // The current chat after /clear: first session's tab id, new session's entity.
  useAppStore.setState({ activeWorktreeId: WORKTREE })
  useAppStore.getState().createUnifiedTab(WORKTREE, 'agent-session', {
    id: CURRENT_TAB,
    entityId: CURRENT_SESSION,
    label: 'Claude Chat'
  })
  applyStructuredSessionTabSnapshots([hostSnapshot])

  const agentTabs = () =>
    (useAppStore.getState().unifiedTabsByWorktree[WORKTREE] ?? [])
      .filter((tab) => tab.contentType === 'agent-session')
      .map((tab) => ({ id: tab.id, entityId: tab.entityId }))
  return { runtime, agentTabs, hostSessionCloses, closeResponses }
}

const initialStoreState = useAppStore.getState()

beforeEach(() => {
  bridge.rendererSessionCloses = []
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  bridge.runtime = null
  useAppStore.setState(initialStoreState, true)
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  vi.unstubAllGlobals()
})

describe('closing a chat reopened from history after /clear', () => {
  it('mirrors the reopened session into a suffixed tab beside the current chat', async () => {
    const { agentTabs } = await setup()

    expect(agentTabs()).toEqual(
      expect.arrayContaining([
        { id: CURRENT_TAB, entityId: CURRENT_SESSION },
        { id: REOPENED_TAB, entityId: REOPENED_SESSION }
      ])
    )
  })

  it('closes only the reopened tab when the user closes it on the desktop', async () => {
    const { agentTabs, hostSessionCloses, closeResponses } = await setup()

    useAppStore.getState().closeUnifiedTab(REOPENED_TAB)

    await vi.waitFor(() => expect(hostSessionCloses).toEqual([REOPENED_SESSION]))
    // Let any stray echo reach the window before asserting the current chat survived.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(agentTabs()).toEqual([{ id: CURRENT_TAB, entityId: CURRENT_SESSION }])
    expect(bridge.rendererSessionCloses).toEqual([REOPENED_SESSION])
    expect(hostSessionCloses).toEqual([REOPENED_SESSION])
    // The window already removed the tab, so main's relay is acknowledged, not reported missing.
    expect(closeResponses).toEqual([undefined])
  })

  it('closes only the reopened tab when a phone closes it through the runtime', async () => {
    const { runtime, agentTabs, hostSessionCloses } = await setup()

    await runtime.closeMobileSessionTab(`id:${WORKTREE}`, `agent-session:${REOPENED_SESSION}`, {
      reason: 'user'
    })

    await vi.waitFor(() =>
      expect(agentTabs()).toEqual([{ id: CURRENT_TAB, entityId: CURRENT_SESSION }])
    )
    expect(bridge.rendererSessionCloses).not.toContain(CURRENT_SESSION)
    expect(hostSessionCloses).not.toContain(CURRENT_SESSION)
  })

  it('focuses the reopened tab when a phone activates it through the runtime', async () => {
    const { runtime } = await setup()
    useAppStore.getState().activateTab(CURRENT_TAB, { worktreeId: WORKTREE })

    await runtime.activateMobileSessionTab(`id:${WORKTREE}`, `agent-session:${REOPENED_SESSION}`)

    const state = useAppStore.getState()
    const group = state.groupsByWorktree[WORKTREE]?.find((candidate) =>
      candidate.tabOrder.includes(REOPENED_TAB)
    )
    expect(group?.activeTabId).toBe(REOPENED_TAB)
  })
})
