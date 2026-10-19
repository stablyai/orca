// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import type * as RuntimeRpcClient from '../../src/renderer/src/runtime/runtime-rpc-client'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { useAppStore } from '../../src/renderer/src/store'
import { applyStructuredSessionTabSnapshots } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../../src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle'
import { registerSessionTabIpcBridge } from '../../src/renderer/src/hooks/ipc-events/session-tab-ipc-bridge'
import { registerTerminalUiRoutingIpcBridge } from '../../src/renderer/src/hooks/ipc-events/terminal-ui-routing-ipc-bridge'
import type { RuntimeClientTarget } from '../../src/shared/runtime-client-target'
import { applyWebSessionTabsSnapshot } from '../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api'
import {
  acceptPairedHostStructuredSessions,
  retireStructuredAgentSessionTab
} from '../../src/renderer/src/runtime/structured-agent-session-tab-retirement'
import { isLocalSessionTabCloseOwned } from '../../src/renderer/src/runtime/local-session-tab-close-owner'
import { clearHostSessionMirrorHydration } from '../../src/renderer/src/runtime/host-session-mirror-hydration'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../../src/renderer/src/runtime/local-structured-session-owner'
import {
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests
} from '../../src/renderer/src/runtime/web-session-close-intent'

type CloseRequest = { requestId: string; tabId: string; worktreeId: string; expiresAt?: number }

type ProcessBoundary = {
  scenario: 'reopened' | 'stale-frame'
  runtime: Pick<OrcaRuntimeService, 'closeMobileSessionTab' | 'listMobileSessionTabs'> | null
  rendererSessionCloses: string[]
  closeHeld: Promise<void> | null
  pairedClose: Promise<void> | null
}

const bridge = vi.hoisted((): ProcessBoundary => ({
  scenario: 'reopened',
  runtime: null,
  rendererSessionCloses: [],
  closeHeld: null,
  pairedClose: null
}))

vi.mock('../../src/renderer/src/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClient>()
  return {
    ...actual,
    callRuntimeRpc: async (
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
  }
})

vi.mock('../../src/renderer/src/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: async (_target: unknown, sessionId: string) => {
    if (bridge.scenario === 'reopened') {
      bridge.rendererSessionCloses.push(sessionId)
    }
    return 'closed'
  }
}))

/**
 * After /clear the current chat keeps the tab id derived from its first session, so reopening that
 * first session from history lands in a suffixed tab. Closing or focusing the reopened tab from
 * main must reach that tab, not the current chat. Runs the real main close/focus path against the
 * real window store, mirror and IPC bridges; only the process boundary is stubbed.
 */
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
    bridge.scenario = 'reopened'
    bridge.rendererSessionCloses = []
  })

  afterEach(() => {
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
})

/**
 * Closing a chat tab removes it from the window at once, while the host is still handling the close.
 * A tab-list frame the host publishes in that gap (a working chat's status update, for one) still
 * lists the chat, and must not put it back at the end of the strip. Runs the real main close path
 * against the real window store and session-tabs mirror; only the process boundary is stubbed.
 */
describe('in-flight structured session close', () => {
  const WORKTREE = 'repo-1::/tmp/wt-stale-frame'
  const SESSIONS = ['chat-a', 'chat-b', 'chat-c'] as const
  const tabIdOf = (sessionId: string): string => `structured-agent-session-${sessionId}`

  async function setup(options: { hostFailsClose?: boolean } = {}) {
    let closeRequest: ((request: CloseRequest) => void) | undefined
    const pendingResponses = new Map<string, (error?: string) => void>()
    const runtime = new OrcaRuntimeService()
    bridge.runtime = runtime
    vi.stubGlobal('api', {
      ui: {
        onCloseSessionTab: () => () => {},
        onSessionTabCloseRequest: (listener: (request: CloseRequest) => void) => {
          closeRequest = listener
          return () => {}
        },
        onMoveSessionTab: () => () => {},
        respondSessionTabClose: ({ requestId, error }: { requestId: string; error?: string }) =>
          pendingResponses.get(requestId)?.(error)
      }
    })
    registerSessionTabIpcBridge([])

    let nextRequest = 0
    runtime.setNotifier(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat close path calls only this notifier member.
      {
        closeSessionTab: (tabId: string, worktreeId: string) =>
          new Promise<void>((resolve, reject) => {
            if (options.hostFailsClose) {
              reject(new Error('window relay failed'))
              return
            }
            const requestId = `close-${++nextRequest}`
            pendingResponses.set(requestId, (error) =>
              error ? reject(new Error(error)) : resolve()
            )
            closeRequest!({ requestId, tabId, worktreeId })
          })
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
    const hostSessionCloses: string[] = []
    const hostTabs = new Set<string>(SESSIONS)
    setStructuredAgentSessionHost(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore and tab close call only these host members.
      {
        reconcileRestartLeases: async () => undefined,
        restoreReadableSessions: async () => undefined,
        close: async (sessionId: string) => {
          hostSessionCloses.push(sessionId)
        },
        setSessionTabVisibility: async (sessionId: string, visible: boolean) => {
          if (!visible) {
            hostTabs.delete(sessionId)
          }
        },
        listSessionTabs: () =>
          [...hostTabs].map((sessionId) => ({ sessionId, workspaceId: WORKTREE, agent: 'claude' }))
      } as never
    )
    await runtime.restoreStructuredAgentSessionTabs()

    useAppStore.setState({ activeWorktreeId: WORKTREE })
    applyStructuredSessionTabSnapshots([await runtime.listMobileSessionTabs(`id:${WORKTREE}`)])
    // The window's live subscription to the host's tab list.
    runtime.onMobileSessionTabsChanged((snapshot) => applyStructuredSessionTabSnapshots([snapshot]))

    const strip = (): string[] =>
      (useAppStore.getState().groupsByWorktree[WORKTREE] ?? []).flatMap((group) => group.tabOrder)
    return { runtime, strip, hostSessionCloses }
  }

  const initialStoreState = useAppStore.getState()

  beforeEach(() => {
    bridge.scenario = 'stale-frame'
  })

  afterEach(() => {
    setStructuredAgentSessionHost(null)
    bridge.runtime = null
    bridge.rendererSessionCloses = []
    bridge.closeHeld = null
    bridge.pairedClose = null
    useAppStore.setState(initialStoreState, true)
    resetLocalStructuredSessionVersionForTests()
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebSessionCloseIntentForTests()
    vi.unstubAllGlobals()
  })

  describe('a host frame published while a chat tab close is in flight', () => {
    it('does not bring the closed chat back at the end of the strip', async () => {
      const { runtime, strip, hostSessionCloses } = await setup()
      expect(strip()).toEqual(SESSIONS.map(tabIdOf))
      let handleClose!: () => void
      bridge.closeHeld = new Promise((resolve) => {
        handleClose = resolve
      })
      // A close left in flight would be joined by the next test's close of the same chat.
      onTestFinished(() => handleClose())

      const captureRetirement = (): Promise<boolean> | null =>
        isLocalSessionTabCloseOwned(WORKTREE, 'agent-session:chat-b')
          ? retireStructuredAgentSessionTab({
              target: { kind: 'local' },
              worktreeId: WORKTREE,
              sessionId: 'chat-b'
            })
          : null
      let retirement: Promise<boolean> | null = null
      try {
        useAppStore.getState().closeUnifiedTab(tabIdOf('chat-b'))
        retirement = captureRetirement()
        expect(strip()).toEqual([tabIdOf('chat-a'), tabIdOf('chat-c')])

        // The host has not handled the close yet, so its next frame still lists chat-b.
        runtime.touchMobileSessionTabsForWorktree(WORKTREE, { immediate: true })
        expect(strip()).toEqual([tabIdOf('chat-a'), tabIdOf('chat-c')])

        handleClose()
        await vi.waitFor(() => expect(hostSessionCloses).toEqual(['chat-b']))
        // The host published its removal before it stopped the chat, and that frame lifted the hide.
        expect(
          isWebSessionCloseIntentPending(
            { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
            WORKTREE,
            'agent-session:chat-b',
            Date.now()
          )
        ).toBe(false)
        runtime.touchMobileSessionTabsForWorktree(WORKTREE, { immediate: true })
        expect(strip()).toEqual([tabIdOf('chat-a'), tabIdOf('chat-c')])
      } finally {
        retirement ??= captureRetirement()
        handleClose()
        await retirement
      }
    })

    it('shows the chat again when the host could not close it', async () => {
      const { strip } = await setup({ hostFailsClose: true })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      useAppStore.getState().closeUnifiedTab(tabIdOf('chat-b'))
      expect(strip()).toEqual([tabIdOf('chat-a'), tabIdOf('chat-c')])

      // The host still has the chat, so once the close fails the window re-reads and shows it.
      await vi.waitFor(() => expect(strip()).toContain(tabIdOf('chat-b')))
      expect(strip()).toHaveLength(3)
      warn.mockRestore()
    })

    it("does not bring a paired server's closed chat back either", async () => {
      const SERVER = 'server-1'
      const frame = (snapshotVersion: number): RuntimeMobileSessionTabsResult => ({
        worktree: WORKTREE,
        publicationEpoch: 'server-epoch',
        snapshotVersion,
        activeGroupId: 'group-1',
        activeTabId: null,
        activeTabType: null,
        tabs: SESSIONS.map((sessionId) => ({
          type: 'agent-session' as const,
          id: `agent-session:${sessionId}`,
          title: sessionId,
          sessionId,
          agent: 'claude' as const,
          isActive: false
        })),
        tabGroups: [
          {
            id: 'group-1',
            tabOrder: SESSIONS.map((sessionId) => `agent-session:${sessionId}`),
            activeTabId: null
          }
        ]
      })
      const applyServerFrame = (snapshot: RuntimeMobileSessionTabsResult): void =>
        useAppStore.setState((state) =>
          applyWebSessionTabsSnapshot(
            state,
            acceptPairedHostStructuredSessions(snapshot, SERVER),
            SERVER
          )
        )
      const strip = (): string[] =>
        (useAppStore.getState().groupsByWorktree[WORKTREE] ?? []).flatMap((group) => group.tabOrder)
      useAppStore.setState({ activeWorktreeId: WORKTREE })
      applyServerFrame(frame(1))
      const chatB = useAppStore
        .getState()
        .unifiedTabsByWorktree[WORKTREE]?.find((tab) => tab.entityId === 'chat-b')
      expect(chatB?.executionHostId).toBe(`runtime:${SERVER}`)
      const before = strip()
      expect(before).toHaveLength(3)
      let answerClose!: () => void
      bridge.pairedClose = new Promise((resolve) => {
        answerClose = resolve
      })
      onTestFinished(() => answerClose())
      const snapshots = await import('../../src/renderer/src/runtime/web-runtime-session-snapshot')
      const reread = vi.spyOn(snapshots, 'refreshWebRuntimeSessionTabsSnapshot')
      const settledFrame = frame(3)
      settledFrame.tabs = settledFrame.tabs.filter((tab) => tab.id !== 'agent-session:chat-b')
      settledFrame.tabGroups?.forEach((group) => {
        group.tabOrder = group.tabOrder.filter((id) => id !== 'agent-session:chat-b')
      })
      vi.stubGlobal('api', {
        runtimeEnvironments: {
          call: async () => ({ id: 'paired-close-list', ok: true, result: settledFrame })
        }
      })

      try {
        useAppStore.getState().closeUnifiedTab(chatB!.id)
        const after = before.filter((id) => id !== chatB!.id)
        expect(strip()).toEqual(after)

        // The server has not handled the close yet, so its next frame still lists chat-b.
        applyServerFrame(frame(2))
        expect(strip()).toEqual(after)
      } finally {
        answerClose()
        try {
          await vi.waitFor(
            async () => {
              const result = reread.mock.results[0]
              if (result?.type !== 'return') {
                throw new Error('The paired close did not start its follow-up refresh')
              }
              await result.value
            },
            { timeout: 10_000 }
          )
        } finally {
          reread.mockRestore()
          clearHostSessionMirrorHydration(SERVER)
        }
      }
    })
  })
})
