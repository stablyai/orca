import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  VISIBLE_PTY_SETTLE_MS,
  WRAPPER_RESOLVE_RETRY_MS,
  SECOND_WRAPPER_RETRY_MS
} from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import {
  resolveMockPaneWindowsShiftEnterEncoding,
  type StoreState
} from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleImagePasteWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleImagePasteWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleImagePasteWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

describe('connectPanePty', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  describe('foreground routing confirmation authority', () => {
    // Why: bindings share the tab-1/LEAF_1 pane key; give each case its own tabId so no other test's publish pollutes it.
    async function connectRestoredPaneForForegroundSampling(
      args: {
        ptyId?: string
        tabId?: string
        isVisibleRef?: { current: boolean }
        launchConfig?: {
          agentCommand?: string
          agentArgs: string
          agentEnv: Record<string, string>
        }
        launchAgent?: TuiAgent
      } = {}
    ): Promise<{
      binding: {
        noteVisibilityResume: () => void
        sampleForegroundAgentOnFocus: () => void
        requestWindowsShiftEnterReconfirmation: () => void
      }
      deps: ReturnType<typeof createDeps>
      transport: MockTransport
      cacheKey: string
    }> {
      const { connectPanePty } = await import('./pty-connection')
      const ptyId = args.ptyId ?? 'tab-pty'
      const tabId = args.tabId ?? `tab-${ptyId}`
      const hasReattachMetadata = args.launchConfig !== undefined || args.launchAgent !== undefined
      const transport = createMockTransport(hasReattachMetadata ? null : ptyId)
      let connectedPtyId: string | null = hasReattachMetadata ? null : ptyId
      transport.getPtyId.mockImplementation(() => connectedPtyId)
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        connectedPtyId = sessionId ?? null
        return sessionId
          ? {
              id: sessionId,
              ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
              ...(args.launchAgent ? { launchAgent: args.launchAgent } : {})
            }
          : null
      })
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        tabId,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: ptyId },
        ...(args.isVisibleRef ? { isVisibleRef: args.isVisibleRef } : {})
      })
      const binding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        deps as never
      ) as unknown as {
        noteVisibilityResume: () => void
        sampleForegroundAgentOnFocus: () => void
        requestWindowsShiftEnterReconfirmation: () => void
      }
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)
      return { binding, deps, transport, cacheKey: makePaneKey(tabId, LEAF_1) }
    }

    async function advanceVisibleForegroundRead(): Promise<void> {
      await vi.advanceTimersByTimeAsync(VISIBLE_PTY_SETTLE_MS)
      await flushAsyncTicks()
    }

    it('does not retain routing capability when no confirmation read is scheduled', async () => {
      vi.useFakeTimers()
      const isVisibleRef = { current: false }
      const ptyId = 'pty-pi-hidden-no-read'
      const tabId = `tab-${ptyId}`
      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        isVisibleRef
      })
      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: 'pi',
        routingTrusted: true,
        shellForeground: false
      }

      // Hidden pane: sampleVisiblePaneForegroundAgent bails, so nothing would ever
      // clear a pending flag. It must fail closed to the legacy encoding instead.
      binding.requestWindowsShiftEnterReconfirmation()
      await vi.advanceTimersByTimeAsync(350)
      await flushAsyncTicks()

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'pi',
        routingRevoked: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
    })

    it('does not let a pending confirmation re-arm itself', async () => {
      vi.useFakeTimers()
      // Never resolves: the confirmation stays in flight for the whole test.
      vi.mocked(window.api.pty.confirmForegroundProcess).mockReturnValue(new Promise(() => {}))
      const ptyId = 'pty-pi-no-remint'
      const tabId = `tab-${ptyId}`
      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: 'pi',
        routingTrusted: true,
        shellForeground: false
      }

      binding.requestWindowsShiftEnterReconfirmation()
      await vi.advanceTimersByTimeAsync(350)
      await flushAsyncTicks()
      expect(
        mockStoreState.paneForegroundAgentByPaneKey[cacheKey]?.routingConfirmationPending
      ).toBe(true)
      const publishesAfterFirst = mockStoreState.setPaneForegroundAgent.mock.calls.length

      // A pending entry is not trusted evidence: further requests must not republish it.
      binding.requestWindowsShiftEnterReconfirmation()
      binding.requestWindowsShiftEnterReconfirmation()
      await vi.advanceTimersByTimeAsync(1_000)
      await flushAsyncTicks()

      expect(mockStoreState.setPaneForegroundAgent.mock.calls.length).toBe(publishesAfterFirst)
    })

    it('does not reauthorize explicitly revoked routing before confirmation', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-pi-revoked-focus'
      const tabId = `tab-${ptyId}`
      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: 'pi',
        routingRevoked: true,
        shellForeground: false
      }

      binding.sampleForegroundAgentOnFocus()

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'pi',
        routingRevoked: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
    })

    it.each(['null result', 'provider rejection'] as const)(
      'drops pending routing after an inconclusive %s',
      async (outcome) => {
        vi.useFakeTimers()
        if (outcome === 'provider rejection') {
          vi.mocked(window.api.pty.confirmForegroundProcess).mockRejectedValue(
            new Error('inspection unavailable')
          )
        } else {
          vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue(null)
        }
        const ptyId = `pty-pi-reconfirm-${outcome.replace(' ', '-')}`
        const tabId = `tab-${ptyId}`
        const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
          ptyId,
          tabId
        })
        mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
          agent: 'pi',
          routingTrusted: true,
          shellForeground: false
        }

        binding.sampleForegroundAgentOnFocus()
        expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('csi-u')

        await vi.advanceTimersByTimeAsync(
          VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
        )
        await flushAsyncTicks()

        expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
          agent: 'pi',
          routingRevoked: true,
          shellForeground: false
        })
        expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
      }
    )

    it('replaces pending Pi routing when confirmation finds another agent', async () => {
      vi.useFakeTimers()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('codex')
      const ptyId = 'pty-pi-reconfirm-codex'
      const tabId = `tab-${ptyId}`
      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: 'pi',
        routingTrusted: true,
        shellForeground: false
      }

      binding.sampleForegroundAgentOnFocus()
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('csi-u')

      await advanceVisibleForegroundRead()

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'codex',
        routingTrusted: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
    })
  })
})
