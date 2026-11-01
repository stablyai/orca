import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectPanePty } from './pty-connection'
import { restoreScrollbackBuffers } from './layout-serialization'
import { createDeferred } from './pty-connection-test-async'
import { createManager, createPane, leafIdForPane } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import {
  buildActiveRuntimeEnvironmentState,
  createInitialStoreState
} from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

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
let storeSubscribers: ((state: StoreState) => void)[] = []
let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'

const layoutOwner = vi.hoisted(() => ({ isMain: false }))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

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

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))

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

async function connectNewRemotePane() {
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
  const connectArgs = [pane, createManager(1), buildPaneConnectionDeps(() => mockStoreState)]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared pane fixtures implement the members connectPanePty touches.
  const binding = connectPanePty(...(connectArgs as unknown as Parameters<typeof connectPanePty>))
  await vi.waitFor(() =>
    expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'terminal.create' }))
  )
  return {
    pane,
    created,
    binding,
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

describe('a brand-new remote pane through connectPanePty', () => {
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
    await restoreTerminalTestGlobals()
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
