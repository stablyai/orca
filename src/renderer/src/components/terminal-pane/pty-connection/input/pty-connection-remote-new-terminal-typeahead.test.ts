import type * as React from 'react'
import type * as AppStoreModule from '@/store'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectPanePty } from '../connect-pane-pty'
import type { CodexAccountRestart } from '@/store/terminals/terminal-contracts'
import { codexAccountRestartToken } from '@/store/terminals/codex-account-restart-continuation'
import { restoreScrollbackBuffers } from '../../snapshots/saved-terminal-output-replay'
import { createDeferred } from '../test-fixtures/pty-connection-test-async'
import {
  createManager,
  createPane,
  leafIdForPane
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import {
  buildActiveRuntimeEnvironmentState,
  createInitialStoreState
} from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import { createRemoteRuntimeTransportMocks } from '../../pty-transport/remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../../pty-transport/remote/remote-runtime-pty-transport-stream-fixtures'

// Real options builder and real remote transport: the fresh create's own layout binding must not
// read as an old terminal when the held typing settles.

const {
  notifyCodexPaneBoundForStaleSweep,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo
} = vi.hoisted(() => ({
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn()
}))

let mockStoreState: StoreState
let restartStore: typeof AppStoreModule.useAppStore
let storeSubscribers: ((state: StoreState) => void)[] = []
let callbacks: MultiplexSubscriptionCallbacks = null
let disposeTransports: (() => void)[] = []
let resolvedHandle = 'terminal-1'

const layoutOwner = vi.hoisted(() => ({ isMain: false }))

vi.mock('../../../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/store/index', () => ({
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

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } =
    await import('../test-fixtures/pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('../../titles/cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

const {
  runtimeCall,
  runtimeSubscribe,
  latestSubscribePayload,
  emitSnapshot,
  inputFrameTexts,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (value) => {
    callbacks = value
  },
  getResolvedPaneHandle: () => resolvedHandle,
  setResolvedPaneHandle: (value) => {
    resolvedHandle = value
  }
})

type CreatedTerminal = {
  handle: string
  isReattach?: true
  coldRestore?: { scrollback: string; cwd: string }
}

async function connectNewRemotePane(
  overrides: Record<string, unknown> = {},
  awaitedMethod = 'terminal.create'
) {
  const created = createDeferred<CreatedTerminal | Error>()
  const call = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (request: { method: string }) => {
    if (request.method !== 'terminal.create') {
      return call?.(request)
    }
    const outcome = await created.promise
    if (outcome instanceof Error) {
      throw outcome
    }
    return { ok: true, result: { terminal: outcome } }
  })
  const pane = createPane(1)
  const userInputListeners: (() => void)[] = []
  Object.assign(pane.terminal, {
    _core: {
      coreService: {
        onUserInput: (listener: () => void) => {
          userInputListeners.push(listener)
          return { dispose: vi.fn() }
        }
      }
    }
  })
  const deps = buildPaneConnectionDeps(() => mockStoreState, overrides)
  const connectArgs = [pane, createManager(1), deps]
  const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
    '@/lib/agent-status/aggregation/worktree-agent-status'
  )

  bindPaneAgentTitleMocks(connectArgs[2], agentTitleMocks)

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared pane fixtures implement the members connectPanePty touches.
  const binding = connectPanePty(...(connectArgs as unknown as Parameters<typeof connectPanePty>))
  const transport = deps.paneTransportsRef.current.get(1)
  const disposeTransport = () => {
    if (
      transport &&
      typeof transport === 'object' &&
      'destroy' in transport &&
      typeof transport.destroy === 'function'
    ) {
      transport.destroy()
    }
  }
  disposeTransports.push(disposeTransport)
  await vi.waitFor(() =>
    expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: awaitedMethod }))
  )
  return {
    pane,
    created,
    binding,
    disposeTransport,
    type: (data: string) => {
      for (const listener of userInputListeners) {
        listener()
      }
      for (const [listener] of pane.terminal.onData.mock.calls) {
        listener(data)
      }
    }
  }
}

async function completeAttach(): Promise<void> {
  await vi.waitFor(() => expect(latestSubscribePayload()).toBeDefined())
  const { streamId } = latestSubscribePayload()
  callbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
  emitSnapshot(streamId, 'prompt$ ')
}

async function connectAccountRestart(adoptCommitted = false) {
  const useAppStore = restartStore
  const initial = useAppStore.getInitialState()
  const request: CodexAccountRestart = {
    agent: 'codex',
    requestId: 'account-request',
    attemptId: 'account-attempt',
    executorId: 'mounted-owner',
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    tabCreatedAt: 1,
    leafId: leafIdForPane(1),
    oldPtyId: 'remote:env-1@@terminal-old',
    environmentId: 'env-1',
    hostId: 'runtime:env-1',
    phase: 'dispatched',
    startupInput: null,
    startup: { command: 'codex', startupCommandDelivery: 'shell-ready', launchAgent: 'codex' },
    condition: {
      requestId: 'account-request',
      attemptId: 'account-attempt',
      hostEpoch: 'host-epoch',
      pane: { worktreeId: 'wt-1', tabId: 'tab-1', leafId: leafIdForPane(1), tabCreatedAt: 1 },
      expected: { kind: 'empty', bindingGeneration: 1 }
    }
  }
  if (adoptCommitted) {
    request.resultPtyId = 'remote:env-1@@terminal-new'
    request.resultIncarnationId = 'inc-committed'
    const originalCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'terminal.resolvePane'
        ? {
            ok: true,
            result: {
              terminal: {
                handle: 'terminal-new',
                ptyId: 'physical-committed',
                incarnationId: 'inc-committed',
                connected: true,
                worktreeId: 'wt-1',
                tabId: 'tab-1',
                leafId: leafIdForPane(1)
              }
            }
          }
        : originalCall?.(args)
    )
  }
  const tab = { id: 'tab-1', ptyId: null, createdAt: 1 }
  const data = Object.fromEntries(
    Object.entries(mockStoreState).filter(([, value]) => typeof value !== 'function')
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture data seeds the existing store fields; its action implementations stay real.
  const nextState = {
    ...initial,
    ...data,
    settings: { ...initial.settings, ...mockStoreState.settings },
    tabsByWorktree: { 'wt-1': [tab] },
    paneAccountRestarts: { [`tab-1:${leafIdForPane(1)}`]: request }
  } as unknown as Parameters<typeof useAppStore.setState>[0]
  useAppStore.setState(nextState, true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connection fixtures read a subset of the real store contract.
  mockStoreState = useAppStore.getState() as unknown as StoreState
  const unsubscribe = useAppStore.subscribe((state) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture facade follows the real store after every transition.
    mockStoreState = state as unknown as StoreState
  })
  const pane = await connectNewRemotePane(
    {
      startup: { command: 'codex' },
      accountRestart: request.condition,
      accountRestartToken: codexAccountRestartToken(request),
      invalidateRetainedInlineScrollback: vi.fn(),
      updateTabPtyId: useAppStore.getState().updateTabPtyId
    },
    adoptCommitted ? 'terminal.resolvePane' : 'terminal.create'
  )
  pane.created.resolve({ handle: 'terminal-new' })
  await completeAttach()
  await vi.waitFor(() => expect(useAppStore.getState().paneAccountRestarts).toEqual({}))
  return {
    ...pane,
    store: useAppStore,
    unsubscribe: () => {
      useAppStore.setState(initial, true)
      unsubscribe()
    }
  }
}

describe('a brand-new remote pane through connectPanePty', () => {
  beforeAll(async () => {
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
    restartStore = (await vi.importActual<typeof AppStoreModule>('@/store/index')).useAppStore
    await restoreTerminalTestGlobals()
  })

  beforeEach(async () => {
    resetRemoteRuntimeTransport()
    storeSubscribers = []
    mockStoreState = buildActiveRuntimeEnvironmentState(
      createInitialStoreState(() => mockStoreState),
      'env-1'
    )
    mockStoreState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
    mockStoreState.ptyIdsByTabId = {}
    const layout = mockStoreState.terminalLayoutsByTabId?.['tab-1']
    if (layout) {
      layout.ptyIdsByLeafId = {}
    }
    await installTerminalTestGlobals()
    Object.assign(window.api, {
      runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe }
    })
  })

  afterEach(async () => {
    for (const dispose of disposeTransports) {
      dispose()
    }
    disposeTransports = []
    await restoreTerminalTestGlobals()
  })

  it('attaches a reconciled account result without creating or replacing the host process', async () => {
    const pane = await connectAccountRestart(true)
    try {
      expect(runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.create')).toEqual(
        []
      )
      expect(pane.store.getState().tabsByWorktree['wt-1'][0].ptyId).toBe(
        'remote:env-1@@terminal-new'
      )
      pane.type('reconciled conversation\r')
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('reconciled conversation\r'))
    } finally {
      pane.disposeTransport()
      pane.binding.dispose()
      pane.unsubscribe()
    }
  })

  it('keeps a completed account restart recoverable through the real remote transport', async () => {
    const pane = await connectAccountRestart()
    try {
      const oldStream = latestSubscribePayload().streamId
      const originalCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation(async (request: { method: string }) =>
        request.method === 'terminal.recoverPane'
          ? {
              ok: true,
              result: {
                terminal: {
                  handle: 'terminal-recovered',
                  tabId: 'tab-1',
                  leafId: leafIdForPane(1),
                  worktreeId: 'wt-1'
                }
              }
            }
          : originalCall?.(request)
      )
      callbacks?.onResponse({
        ok: true,
        result: { type: 'error', streamId: oldStream, message: 'SSH_SESSION_EXPIRED' }
      })
      await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-recovered'))
      await completeAttach()
      expect(pane.store.getState().tabsByWorktree['wt-1'][0].ptyId).toBe(
        'remote:env-1@@terminal-recovered'
      )
      expect(
        pane.store.getState().terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId?.[leafIdForPane(1)]
      ).toBe('remote:env-1@@terminal-recovered')
      pane.type('after recovery\r')
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('after recovery\r'))
      callbacks?.onResponse({
        ok: true,
        result: { type: 'error', streamId: oldStream, message: 'terminal_handle_stale' }
      })
      expect(pane.store.getState().tabsByWorktree['wt-1'][0].ptyId).toBe(
        'remote:env-1@@terminal-recovered'
      )
    } finally {
      vi.useRealTimers()
      pane.disposeTransport()
      pane.binding.dispose()
      pane.unsubscribe()
    }
  })

  it('ignores an obsolete remote recovery after the completed restart pane is replaced', async () => {
    const pane = await connectAccountRestart()
    try {
      const recovery = createDeferred<unknown>()
      const originalCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation(async (request: { method: string }) =>
        request.method === 'terminal.recoverPane' ? recovery.promise : originalCall?.(request)
      )
      callbacks?.onResponse({
        ok: true,
        result: {
          type: 'error',
          streamId: latestSubscribePayload().streamId,
          message: 'SSH_SESSION_EXPIRED'
        }
      })
      await vi.waitFor(() =>
        expect(runtimeCall).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'terminal.recoverPane' })
        )
      )
      pane.binding.dispose()
      pane.store
        .getState()
        .updateTabPtyId('tab-1', 'remote:env-1@@terminal-successor', 'remote:env-1@@terminal-new')
      const layout = pane.store.getState().terminalLayoutsByTabId['tab-1']
      pane.store.getState().setTabLayout('tab-1', {
        ...layout,
        ptyIdsByLeafId: { [leafIdForPane(1)]: 'remote:env-1@@terminal-successor' }
      })
      vi.useFakeTimers()
      recovery.resolve({
        ok: true,
        result: {
          terminal: {
            handle: 'terminal-obsolete',
            tabId: 'tab-1',
            leafId: leafIdForPane(1),
            worktreeId: 'wt-1'
          }
        }
      })
      await recovery.promise
      await vi.advanceTimersByTimeAsync(0)
      expect(pane.store.getState().tabsByWorktree['wt-1'][0].ptyId).toBe(
        'remote:env-1@@terminal-successor'
      )
      expect(
        pane.store.getState().terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId?.[leafIdForPane(1)]
      ).toBe('remote:env-1@@terminal-successor')
    } finally {
      vi.useRealTimers()
      pane.disposeTransport()
      pane.binding.dispose()
      pane.unsubscribe()
    }
  })

  it('sends typing from before the create to the terminal the create makes', async () => {
    const pane = await connectNewRemotePane()
    pane.type('echo hi')
    pane.type('\r')
    pane.created.resolve({ handle: 'terminal-new' })
    await completeAttach()

    await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('echo hi\r'))
    // The create bound the leaf itself; that binding is not an old terminal.
    expect(
      mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId?.[leafIdForPane(1)]
    ).toBe('remote:env-1@@terminal-new')
    pane.binding.dispose()
  })

  it.each([
    ['an adopted terminal', { handle: 'terminal-live', isReattach: true as const }],
    [
      'a cold-restored terminal',
      { handle: 'terminal-restored', coldRestore: { scrollback: 'old$ ', cwd: '/w' } }
    ]
  ])('drops the typing when the create returns %s', async (_label, terminal) => {
    const pane = await connectNewRemotePane()
    pane.type('rm -rf build\r')
    pane.created.resolve(terminal)
    await completeAttach()
    pane.type('live')
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))

    expect(inputFrameTexts().join('')).toBe('live')
    pane.binding.dispose()
  })

  it('drops the typing when saved history is replayed into the pane before it binds', async () => {
    const pane = await connectNewRemotePane()
    pane.type('typed on old history\r')
    // The real restore path: saved scrollback for this leaf lands in the new pane.
    const manager = { getPanes: () => [pane.pane], hasWebglRenderer: () => false }
    restoreScrollbackBuffers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restoreScrollbackBuffers reads only getPanes and hasWebglRenderer.
      manager as unknown as Parameters<typeof restoreScrollbackBuffers>[0],
      { [leafIdForPane(1)]: 'old$ make\r\n' },
      new Map([[leafIdForPane(1), pane.pane.id]]),
      { current: new Map<number, number>() }
    )
    pane.created.resolve({ handle: 'terminal-new' })
    await completeAttach()
    // A key typed after the bind proves anything held ahead of it has settled.
    pane.type('live')
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))

    expect(inputFrameTexts().join('')).toBe('live')
    pane.binding.dispose()
  })
})
