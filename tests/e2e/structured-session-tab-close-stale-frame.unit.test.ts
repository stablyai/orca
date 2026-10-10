// @vitest-environment happy-dom

/**
 * Closing a chat tab removes it from the window at once, while the host is still handling the close.
 * A tab-list frame the host publishes in that gap (a working chat's status update, for one) still
 * lists the chat, and must not put it back at the end of the strip. Runs the real main close path
 * against the real window store and session-tabs mirror; only the process boundary is stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClient from '../../src/renderer/src/runtime/runtime-rpc-client'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { useAppStore } from '../../src/renderer/src/store'
import { applyStructuredSessionTabSnapshots } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../../src/renderer/src/runtime/web-session-tabs-sync'
import { registerSessionTabIpcBridge } from '../../src/renderer/src/hooks/ipc-events/session-tab-ipc-bridge'

const WORKTREE = 'repo-1::/tmp/wt-stale-frame'
const SESSIONS = ['chat-a', 'chat-b', 'chat-c'] as const
const tabIdOf = (sessionId: string): string => `structured-agent-session-${sessionId}`

type CloseRequest = { requestId: string; tabId: string; worktreeId: string; expiresAt?: number }

type ProcessBoundary = {
  runtime: Pick<OrcaRuntimeService, 'closeMobileSessionTab'> | null
  // The host has received the close but not handled it yet.
  closeHeld: Promise<void> | null
}

const bridge = vi.hoisted((): ProcessBoundary => ({ runtime: null, closeHeld: null }))

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
      await bridge.closeHeld
      return bridge.runtime!.closeMobileSessionTab(params.worktree, params.tabId, {
        reason: params.reason
      })
    }
  }
})

vi.mock('../../src/renderer/src/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: async () => 'closed'
}))

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
    },
    runtime: {
      // The window's re-read of the host's tab list after its close settled.
      call: async ({ method }: { method: string }) => {
        if (method !== 'session.tabs.listAll') {
          throw new Error(`unexpected runtime call ${method}`)
        }
        return {
          ok: true,
          result: { snapshots: [await runtime.listMobileSessionTabs(`id:${WORKTREE}`)] }
        }
      }
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
          pendingResponses.set(requestId, (error) => (error ? reject(new Error(error)) : resolve()))
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

afterEach(() => {
  setStructuredAgentSessionHost(null)
  bridge.runtime = null
  bridge.closeHeld = null
  useAppStore.setState(initialStoreState, true)
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
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

    useAppStore.getState().closeUnifiedTab(tabIdOf('chat-b'))
    expect(strip()).toEqual([tabIdOf('chat-a'), tabIdOf('chat-c')])

    // The host has not handled the close yet, so its next frame still lists chat-b.
    runtime.touchMobileSessionTabsForWorktree(WORKTREE, { immediate: true })
    expect(strip()).toEqual([tabIdOf('chat-a'), tabIdOf('chat-c')])

    handleClose()
    await vi.waitFor(() => expect(hostSessionCloses).toEqual(['chat-b']))
    runtime.touchMobileSessionTabsForWorktree(WORKTREE, { immediate: true })
    expect(strip()).toEqual([tabIdOf('chat-a'), tabIdOf('chat-c')])
  })

  it('shows the chat again when the host could not close it', async () => {
    const { strip } = await setup({ hostFailsClose: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useAppStore.getState().closeUnifiedTab(tabIdOf('chat-b'))
    expect(strip()).toEqual([tabIdOf('chat-a'), tabIdOf('chat-c')])

    // The host still has the chat, so once the close settles the window re-reads and shows it.
    await vi.waitFor(() => expect(strip()).toContain(tabIdOf('chat-b')))
    expect(strip()).toHaveLength(3)
    warn.mockRestore()
  })
})
