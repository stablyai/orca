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
import { temporarilySetNavigatorUserAgent } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
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

  describe('visible foreground agent sampling (perf)', () => {
    // Why: bindings share the tab-1/LEAF_1 pane key; give each sampling case its own tabId so no other test's publish pollutes it.
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

    function foregroundReadCallsFor(ptyId: string): unknown[][] {
      return vi
        .mocked(window.api.pty.getForegroundProcess)
        .mock.calls.filter(([calledPtyId]) => calledPtyId === ptyId)
    }

    it('does not inspect foreground process for a fresh visible spawn', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-fresh-visible-no-sample'
      transportFactoryQueue.push(createMockTransport(ptyId))
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_1 },
            activeLeafId: LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        }
      } as StoreState

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)
      const spawnHandler = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      spawnHandler?.(ptyId)
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('samples exactly one visible restored PTY with no stronger identity signal', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-restored-visible-sample'

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({ ptyId })
      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)

      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toEqual([[ptyId]])
      expect(mockStoreState.setPaneForegroundAgent).toHaveBeenCalledWith(cacheKey, {
        agent: 'codex',
        shellForeground: false
      })
    })

    it('does not sample hidden restored PTYs', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-hidden-restored-no-sample'

      await connectRestoredPaneForForegroundSampling({
        ptyId,
        isVisibleRef: { current: false }
      })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('does not confirm foreground routing for a Windows WSL pane', async () => {
      vi.useFakeTimers()
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const ptyId = 'pty-wsl-no-confirm'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = {
        'wt-1': [{ id: tabId, ptyId, shellOverride: 'wsl.exe' }]
      }

      try {
        const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
          ptyId,
          tabId
        })
        mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
          agent: 'droid',
          routingTrusted: true,
          shellForeground: false
        }

        binding.sampleForegroundAgentOnFocus()
        await vi.advanceTimersByTimeAsync(10_000)

        // Scope to this pane's pty id: a delayed confirm for another test's pane can fire during this advance.
        expect(window.api.pty.confirmForegroundProcess).not.toHaveBeenCalledWith(ptyId)
        expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
          agent: 'droid',
          routingRevoked: true,
          shellForeground: false
        })
        expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
      } finally {
        restoreUserAgent()
      }
    })

    it('does not confirm foreground routing for a global Windows WSL shell', async () => {
      vi.useFakeTimers()
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const ptyId = 'pty-global-wsl-no-confirm'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = {
        'wt-1': [{ id: tabId, ptyId }]
      }
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalWindowsShell: 'wsl.exe'
      }

      try {
        const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
          ptyId,
          tabId
        })
        mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
          agent: 'droid',
          routingTrusted: true,
          shellForeground: false
        }

        binding.sampleForegroundAgentOnFocus()
        await vi.advanceTimersByTimeAsync(10_000)

        expect(window.api.pty.confirmForegroundProcess).not.toHaveBeenCalledWith(ptyId)
        expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
          agent: 'droid',
          routingRevoked: true,
          shellForeground: false
        })
        expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
      } finally {
        restoreUserAgent()
      }
    })

    it('keeps trusted Droid routing through a rapid Shift+Enter burst', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-droid-shift-enter-burst'
      const tabId = `tab-${ptyId}`
      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId
      })
      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      }
      mockStoreState.agentStatusByPaneKey[cacheKey] = {
        state: 'working',
        agentType: 'droid'
      }
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('droid')

      binding.requestWindowsShiftEnterReconfirmation()
      await vi.advanceTimersByTimeAsync(200)
      binding.requestWindowsShiftEnterReconfirmation()
      await vi.advanceTimersByTimeAsync(349)

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })

      await vi.advanceTimersByTimeAsync(1)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        routingRevoked: true,
        routingConfirmationPending: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('csi-u')

      await vi.advanceTimersByTimeAsync(350)
      await flushAsyncTicks()
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith(ptyId)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })

      binding.requestWindowsShiftEnterReconfirmation()
      await vi.advanceTimersByTimeAsync(700)
      await flushAsyncTicks()
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })
    })

    it('revokes stale trusted Pi routing on focus before confirming the shell', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-pi-focus-after-exit'
      const tabId = `tab-${ptyId}`
      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: 'pi',
        routingTrusted: true,
        shellForeground: false
      }
      mockStoreState.agentStatusByPaneKey[cacheKey] = {
        state: 'working',
        agentType: 'pi'
      }
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('cmd.exe')

      binding.sampleForegroundAgentOnFocus()

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'pi',
        routingRevoked: true,
        routingConfirmationPending: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('csi-u')

      await vi.advanceTimersByTimeAsync(
        VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
      )
      await flushAsyncTicks()
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: null,
        shellForeground: true
      })
    })

    it('samples once when an identityless hidden pane resumes visible', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const isVisibleRef = { current: false }
      const ptyId = 'pty-hidden-then-visible-sample'
      const { binding } = await connectRestoredPaneForForegroundSampling({ ptyId, isVisibleRef })
      await advanceVisibleForegroundRead()
      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toEqual([[ptyId]])
    })

    it('confirms daemon launch identity before restoring warm-reattach routing', async () => {
      vi.useFakeTimers()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('droid')
      const ptyId = 'pty-launch-identity-no-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = { 'wt-1': [{ id: tabId, ptyId }] }

      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        launchAgent: 'droid'
      })
      expect(mockStoreState.registerAgentLaunchConfig).not.toHaveBeenCalled()
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')

      binding.sampleForegroundAgentOnFocus()
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')

      await advanceVisibleForegroundRead()

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('csi-u')
    })

    it('retires stale daemon launch identity when warm reattach finds the shell', async () => {
      vi.useFakeTimers()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('powershell.exe')
      const ptyId = 'pty-stale-daemon-launch-identity'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = { 'wt-1': [{ id: tabId, ptyId }] }

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        launchAgent: 'droid'
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')

      await vi.advanceTimersByTimeAsync(
        VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
      )
      await flushAsyncTicks()

      // Assert the floor (initial read + two retries), not an exact count: an incidental droid reconfirm can add one more.
      expect(
        vi.mocked(window.api.pty.confirmForegroundProcess).mock.calls.length
      ).toBeGreaterThanOrEqual(3)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: null,
        shellForeground: true
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
    })

    it('fails closed when a warm reattach has no persisted launch identity', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-reattach-missing-launch-identity'
      const tabId = `tab-${ptyId}`

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        isVisibleRef: { current: false }
      })

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toBeUndefined()
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
    })

    it('does not let persisted args spoof pane identity without an allowlisted command', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-unknown-persisted-launch'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = { 'wt-1': [{ id: tabId, ptyId }] }
      mockStoreState.registerAgentLaunchConfig.mockImplementation(
        (key: string, launchConfig: unknown, identity: { agentType?: string }): void => {
          mockStoreState.agentLaunchConfigByPaneKey[key] = { launchConfig, identity }
        }
      )

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        isVisibleRef: { current: false },
        launchConfig: {
          agentCommand: 'custom-wrapper --agent droid',
          agentArgs: 'droid',
          agentEnv: {}
        }
      })
      await vi.advanceTimersByTimeAsync(300)
      await flushAsyncTicks(20)

      expect(
        mockStoreState.agentLaunchConfigByPaneKey[cacheKey]?.identity?.agentType
      ).toBeUndefined()
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
    })

    it('does not re-scan stale launch metadata after the local ladder confirms shell', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('powershell.exe')
      const isVisibleRef = { current: false }
      const ptyId = 'pty-stale-launch-shell-settled'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = {
        'wt-1': [{ id: tabId, ptyId, launchAgent: 'droid' }]
      }
      mockStoreState.registerAgentLaunchConfig.mockImplementation(
        (key: string, launchConfig: unknown, identity: { agentType?: string }): void => {
          mockStoreState.agentLaunchConfigByPaneKey[key] = { launchConfig, identity }
        }
      )
      mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
        delete mockStoreState.agentLaunchConfigByPaneKey[key]
      })

      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        isVisibleRef,
        launchConfig: { agentCommand: 'droid', agentArgs: '', agentEnv: {} }
      })
      await vi.advanceTimersByTimeAsync(300)
      await flushAsyncTicks(20)
      // Launch metadata starts confirmation but is never byte-routing authority.
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await advanceVisibleForegroundRead()
      await vi.advanceTimersByTimeAsync(WRAPPER_RESOLVE_RETRY_MS)
      await vi.advanceTimersByTimeAsync(SECOND_WRAPPER_RETRY_MS)

      expect(foregroundReadCallsFor(ptyId).length).toBeGreaterThanOrEqual(3)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: null,
        shellForeground: true
      })
      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(cacheKey)

      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: null,
        shellForeground: false
      }
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')

      vi.clearAllTimers()
      const settledReadCount = foregroundReadCallsFor(ptyId).length
      binding.sampleForegroundAgentOnFocus()
      await vi.advanceTimersByTimeAsync(
        VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
      )
      expect(foregroundReadCallsFor(ptyId)).toHaveLength(settledReadCount)
    })

    it('does not sample when a live hook row already supplies pane identity', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-hook-identity-no-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.agentStatusByPaneKey[makePaneKey(tabId, LEAF_1)] = {
        state: 'working',
        agentType: 'codex'
      }

      await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('does not sample when process identity is already known', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-process-identity-no-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.paneForegroundAgentByPaneKey[makePaneKey(tabId, LEAF_1)] = {
        agent: 'codex',
        routingTrusted: true,
        shellForeground: false
      }

      await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('does not re-sample once 133;D proved the pane is at a shell prompt', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-shell-foreground-no-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.paneForegroundAgentByPaneKey[makePaneKey(tabId, LEAF_1)] = {
        agent: null,
        shellForeground: true
      }

      await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('does not re-sample a shell-confirmed pane from stale launch metadata', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-shell-foreground-launch-agent-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = {
        'wt-1': [{ id: tabId, ptyId, launchAgent: 'codex' }]
      }
      mockStoreState.paneForegroundAgentByPaneKey[makePaneKey(tabId, LEAF_1)] = {
        agent: null,
        shellForeground: true
      }

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
      expect(mockStoreState.setPaneForegroundAgent).not.toHaveBeenCalledWith(
        cacheKey,
        expect.anything()
      )
    })

    it('fails closed when a leaked 133;D cancels identityless recovery', async () => {
      // Why: a cached visible read has no routing authority; on a racing command boundary, trust the shell marker over stale identity.
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-reattach-idle-codex-leaked-d'
      const tabId = `tab-${ptyId}`
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks?.onData ?? null
          return sessionId ? { id: sessionId } : null
        }
      )
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        tabId,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
      })
      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)

      const cacheKey = makePaneKey(tabId, LEAF_1)
      dataCallbackRef.current?.('\x1b]133;D;0\x07')

      await advanceVisibleForegroundRead()

      expect(mockStoreState.setPaneForegroundAgent).toHaveBeenCalledWith(cacheKey, {
        agent: null,
        shellForeground: true
      })
      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('re-confirms leaked 133;D after detach moved pane-scoped Droid identity', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('droid')
      const ptyId = 'pty-detached-droid-leaked-d'
      const tabId = 'tab-detached-droid'
      const cacheKey = makePaneKey(tabId, LEAF_1)
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks?.onData ?? null
          return sessionId ? { id: sessionId } : null
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: 'droid',
        shellForeground: false
      }
      mockStoreState.agentLaunchConfigByPaneKey[cacheKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'droid' }
      }
      const deps = createDeps({
        tabId,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)
      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toEqual([[ptyId]])
      expect(mockStoreState.setPaneForegroundAgent).not.toHaveBeenCalledWith(cacheKey, {
        agent: null,
        shellForeground: true
      })
      expect(mockStoreState.setPaneForegroundAgent).toHaveBeenCalledWith(cacheKey, {
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })
    })

    it('never probes the foreground for a visible remote/SSH restored pane', async () => {
      // Why: foreground reads are local-only (expensive RPCs); keep remote/SSH panes off the recovery probe.
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'remote:web-env-1@@pty-remote-idle-agent'

      await connectRestoredPaneForForegroundSampling({ ptyId, tabId: 'tab-remote-idle-agent' })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })
  })
})
