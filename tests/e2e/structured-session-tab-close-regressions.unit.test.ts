import type * as RuntimeRpcCallModule from '../../src/renderer/src/runtime/rpc/calls/runtime-rpc-call'
import type { StructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/host/structured-agent-session-host'
import { partialRuntimeStore } from '../../src/main/runtime/orca-runtime-tests/runtime-store-partial-fixture'
import { agentSessionRecordFixture } from '../../src/main/native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../src/shared/agent-session/lifecycle/agent-session-conversation-view'
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'

import type * as RuntimeLayoutClient from '../../src/renderer/src/runtime/workspace-layout/frames/runtime-layout-client'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/host/structured-agent-session-registry'
import { useAppStore } from '../../src/renderer/src/store'
import { applyStructuredSessionTabSnapshots } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../../src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle'
import { registerSessionTabIpcBridge } from '../../src/renderer/src/hooks/ipc-events/session-tab-ipc-bridge'
import { registerTerminalUiRoutingIpcBridge } from '../../src/renderer/src/hooks/ipc-events/terminal-ui-routing-ipc-bridge'
import type { RuntimeClientTarget } from '../../src/shared/runtime-client-target'
import '../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api'
import '../../src/renderer/src/runtime/native-chat/tab-retirement/structured-agent-session-tab-retirement'
import '../../src/renderer/src/runtime/web-session-tabs-sync/closing/local-session-tab-close-owner'
import '../../src/renderer/src/runtime/web-session-tabs-sync/hydration/host-session-mirror-hydration'
import '../../src/renderer/src/runtime/native-chat/local-sessions/local-structured-session-owner'
import { resetWebSessionCloseIntentForTests } from '../../src/renderer/src/runtime/web-session-tabs-sync/closing/web-session-close-intent'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../src/shared/layout-owner-switch'
import '../../src/shared/execution-host'
import '../../src/renderer/src/store/slices/worktrees/worktree.test-fixture'
import { layoutApplyTestTransport } from '../../src/renderer/src/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../src/renderer/src/store/slices/tabs/tabs-drawn-from-main.test-fixture'

type CloseRequest = { requestId: string; tabId: string; worktreeId: string; expiresAt?: number }

type ProcessBoundary = {
  scenario: 'reopened' | 'stale-frame'
  runtime: Pick<OrcaRuntimeService, 'closeMobileSessionTab' | 'listMobileSessionTabs'> | null
  rendererSessionCloses: string[]
  closeHeld: Promise<void> | null
  pairedClose: Promise<void> | null
}

type RestoreCloseHost = Pick<
  StructuredAgentSessionHost,
  | 'reconcileRestartLeases'
  | 'seedSessionTabs'
  | 'getPersistedVisibleSessionTabIndex'
  | 'isSessionTabVisible'
  | 'close'
  | 'setSessionTabVisibility'
  | 'listSessionTabs'
  | 'getSessionTabId'
> & {
  deps: {
    store: Pick<
      StructuredAgentSessionHost['deps']['store'],
      'getConversation' | 'isSessionUnreadable' | 'isSessionTabRetired'
    >
  }
}

const bridge = vi.hoisted((): ProcessBoundary => ({
  scenario: 'reopened',
  runtime: null,
  rendererSessionCloses: [],
  closeHeld: null,
  pairedClose: null
}))

// Switch-on, the window's layout commands reach main's model, which the runtime's own commands share.
vi.mock('../../src/renderer/src/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcCallModule>()
  const { runtimeRpcClientWithLayoutApply } =
    await import('../../src/renderer/src/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  // An untyped mock: the runtime client's generic result type is the caller's to name.
  const callRuntimeRpc = vi.fn()
  callRuntimeRpc.mockImplementation(
    async (
      target: RuntimeClientTarget,
      method: string,
      params: { worktree: string; tabId: string; reason?: 'user' }
    ) => {
      if (
        bridge.scenario === 'stale-frame' &&
        target.kind === 'environment' &&
        method === 'session.tabs.close'
      ) {
        return bridge.pairedClose
      }
      if (method === 'session.tabs.list') {
        return bridge.runtime!.listMobileSessionTabs(params.worktree)
      }
      if (method !== 'session.tabs.close') {
        throw new Error(`unexpected rpc ${method}`)
      }
      if (bridge.scenario === 'stale-frame') {
        await bridge.closeHeld
      }
      return bridge.runtime!.closeMobileSessionTab(params.worktree, params.tabId, {
        reason: params.reason
      })
    }
  )
  return runtimeRpcClientWithLayoutApply({ ...actual, callRuntimeRpc })
})
vi.mock(
  '../../src/renderer/src/runtime/workspace-layout/frames/runtime-layout-client',
  async (importOriginal) =>
    (
      await import('../../src/renderer/src/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
    ).runtimeLayoutClientWithTestFrames(await importOriginal<typeof RuntimeLayoutClient>())
)

let main: TabsDrawnFromMain | undefined

/** Main takes the window's current layout and answers its own layout commands from that model too. */
async function mainHoldsWindowLayout(runtime: OrcaRuntimeService): Promise<void> {
  main?.close()
  main = await drawTabsFromMain(useAppStore)
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    Object.assign(runtime, {
      applyLayoutCommand: (command: unknown) => layoutApplyTestTransport.call({ command })
    })
  }
}

function closeMain(): void {
  main?.close()
  main = undefined
}

vi.mock(
  '../../src/renderer/src/runtime/native-chat/requests/structured-agent-session-close',
  () => ({
    closeStructuredAgentSession: async (_target: unknown, sessionId: string) => {
      if (bridge.scenario === 'reopened') {
        bridge.rendererSessionCloses.push(sessionId)
      }
      return 'closed'
    }
  })
)

// After /clear, history reopens the first conversation under a suffixed tab id; real main close/focus must target that tab.
// Connect real window store/mirror/IPC with only the process boundary stubbed.
describe('reopened structured session close', () => {
  const WORKTREE = 'repo-1::/tmp/wt-reopen'
  const CURRENT_SESSION = 'clear-x'
  const REOPENED_SESSION = 'session-s'
  const CURRENT_TAB = `structured-agent-session-${REOPENED_SESSION}`
  const REOPENED_TAB = `${CURRENT_TAB}:history-1`

  type Listener<T> = (payload: T) => void

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
    const runtime = new OrcaRuntimeService(partialRuntimeStore())
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
    // The adapter owns checked records and current visibility; PTY/profile restoration is excluded.
    Object.assign(runtime, {
      hasPersistedStructuredAgentSessionStore: () => true,
      getKnownWorkspaceSessionWorktreeIds: () => new Set(),
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => new Set(),
      refreshMobileSessionPtyRecords: async () => new Set(),
      ensureStructuredAgentSessionHost: async () => undefined
    })
    const hostTabs = new Set([CURRENT_SESSION, REOPENED_SESSION])
    const records = new Map(
      [...hostTabs].map((sessionId) => [
        sessionId,
        agentSessionConversationView(
          agentSessionRecordFixture({ sessionId, location: { workspaceId: WORKTREE } })
        )
      ])
    )
    setStructuredAgentSessionHost(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adapter supplies current selection/records and the restore/close API used here.
      {
        deps: {
          store: {
            getConversation: (id: string) => records.get(id) ?? null,
            isSessionUnreadable: () => false,
            isSessionTabRetired: (id: string) => !hostTabs.has(id)
          }
        },
        reconcileRestartLeases: async () => undefined,
        seedSessionTabs: async () => undefined,
        getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...hostTabs] }),
        isSessionTabVisible: (id: string) => hostTabs.has(id) && records.has(id),
        close: async (sessionId: string) => {
          hostSessionCloses.push(sessionId)
        },
        setSessionTabVisibility: async (id: string, visible: boolean) => {
          if (visible) {
            hostTabs.add(id)
          } else {
            hostTabs.delete(id)
          }
        },
        // Index the reopened chat separately because the current chat retains its first session’s tab id.
        getSessionTabId: (sessionId: string) =>
          sessionId === CURRENT_SESSION ? CURRENT_TAB : REOPENED_TAB,
        listSessionTabs: () =>
          [...hostTabs].map((sessionId) => ({ sessionId, workspaceId: WORKTREE, agent: 'claude' }))
      } satisfies RestoreCloseHost as never
    )
    // The current chat after /clear: first session's tab id, new session's entity.
    useAppStore.setState({ activeWorktreeId: WORKTREE })
    useAppStore.getState().createUnifiedTab(WORKTREE, 'agent-session', {
      id: CURRENT_TAB,
      entityId: CURRENT_SESSION,
      label: 'Claude Chat'
    })
    await mainHoldsWindowLayout(runtime)
    await runtime.restoreStructuredAgentSessionTabs()
    const hostSnapshot: RuntimeMobileSessionTabsResult = await runtime.listMobileSessionTabs(
      `id:${WORKTREE}`
    )
    applyStructuredSessionTabSnapshots([hostSnapshot])
    await main?.settle()

    const agentTabs = () =>
      (useAppStore.getState().unifiedTabsByWorktree[WORKTREE] ?? [])
        .filter((tab) => tab.contentType === 'agent-session')
        .map((tab) => ({ id: tab.id, entityId: tab.entityId }))
    return { runtime, agentTabs, hostSessionCloses, closeResponses }
  }

  const initialStoreState = useAppStore.getState()

  beforeEach(() => {
    bridge.scenario = 'reopened'
    bridge.rendererSessionCloses = []
  })

  afterEach(() => {
    closeMain()
    setStructuredAgentSessionHost(null)
    bridge.runtime = null
    bridge.closeHeld = null
    bridge.pairedClose = null
    useAppStore.setState(initialStoreState, true)
    resetLocalStructuredSessionVersionForTests()
    resetWebSessionTabsSnapshotFreshnessForTests()
    // A close's follow-up re-read can outlive its test, which tears the host down under it.
    resetWebSessionCloseIntentForTests()
    vi.unstubAllGlobals()
  })

  describe('closing a chat reopened from history after /clear', () => {
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
})
