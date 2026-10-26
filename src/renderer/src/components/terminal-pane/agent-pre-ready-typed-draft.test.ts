import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectPanePty } from './pty-connection'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createManager,
  createMockTransport,
  createPane,
  leafIdForPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type * as TerminalWorktreeRouteModule from '@/lib/terminal-worktree-route'
import { appendTypedDraftText } from './pty-connection/agent-pre-ready-typed-draft'

const {
  notifyCodexPaneBoundForStaleSweep,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  waitForAgentDraftInputReady,
  sendAgentDraftPasteContent,
  onPasteTimeout
} = vi.hoisted(() => ({
  waitForAgentDraftInputReady: vi.fn(),
  sendAgentDraftPasteContent: vi.fn(async () => true),
  onPasteTimeout: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

const layoutOwner = vi.hoisted(() => ({ isMain: false }))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/lib/agent-draft-readiness', () => ({ waitForAgentDraftInputReady }))

const pairedRoute = vi.hoisted(() => {
  const route: { runtimeEnvironmentId: string | null } = { runtimeEnvironmentId: null }
  return route
})

vi.mock('@/lib/terminal-worktree-route', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalWorktreeRouteModule>()
  return {
    ...actual,
    resolveTerminalWorktreeRoute: (
      ...args: Parameters<typeof actual.resolveTerminalWorktreeRoute>
    ) =>
      pairedRoute.runtimeEnvironmentId
        ? { runtimeEnvironmentId: pairedRoute.runtimeEnvironmentId }
        : actual.resolveTerminalWorktreeRoute(...args)
  }
})

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

vi.mock('@/lib/agent-draft-paste-content', () => ({ sendAgentDraftPasteContent }))

vi.mock('@/lib/launch-agent-paste-timeout-notice', () => ({
  createPasteReadinessTimeoutNotice: () => ({ onTimeout: onPasteTimeout, wasNotified: () => false })
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

type ConnectedAgentPane = {
  paneKey: string
  transport: MockTransport
  type: (data: string) => void
  bind: (ptyId: string) => void
  bindAttached: (ptyId: string) => void
  unbind: () => void
  resolveConnect: (result: unknown) => void
  dispose: () => void
}

function connectAgentPane(overrides: Record<string, unknown> = {}): ConnectedAgentPane {
  const transport = createMockTransport()
  let ptyId: string | null = null
  transport.getPtyId.mockImplementation(() => ptyId)
  transport.sendInput.mockImplementation(() => ptyId !== null)
  let resolveConnect: (result: unknown) => void = () => {}
  transport.connect.mockImplementation(() => new Promise((resolve) => (resolveConnect = resolve)))
  transportFactoryQueue.push(transport)
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
  const connectArgs = [
    pane,
    createManager(1),
    buildPaneConnectionDeps(() => mockStoreState, {
      startup: { command: 'claude', launchAgent: 'claude' },
      ...overrides
    })
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared pane fixtures implement the members connectPanePty touches.
  const binding = connectPanePty(...(connectArgs as unknown as Parameters<typeof connectPanePty>))
  return {
    paneKey: makePaneKey('tab-1', leafIdForPane(1)),
    transport,
    type: (data) => {
      for (const listener of userInputListeners) {
        listener()
      }
      for (const [listener] of pane.terminal.onData.mock.calls) {
        listener(data)
      }
    },
    bind: (id) => {
      ptyId = id
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn
      if (typeof onPtySpawn === 'function') {
        onPtySpawn(id)
      }
    },
    bindAttached: (id) => {
      ptyId = id
      const onPtyRebind = createdTransportOptions[0]?.onPtyRebind
      if (typeof onPtyRebind === 'function') {
        onPtyRebind(id, 'pty-previous')
      }
    },
    unbind: () => {
      ptyId = null
    },
    resolveConnect: (result) => {
      if (result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') {
        ptyId = result.id
      }
      resolveConnect(result)
    },
    dispose: () => binding.dispose()
  }
}

describe('appendTypedDraftText', () => {
  it('turns line breaks inside a pasted chunk into one space', () => {
    expect(appendTypedDraftText('', 'first line\r\nsecond', 100)).toBe('first line second')
    expect(appendTypedDraftText('typed', '\r', 100)).toBe('typed')
  })

  it('keeps printable text and drops Enter, Tab and control keys', () => {
    expect(appendTypedDraftText('', 'make\tthe tests\x03 pass\r', 100)).toBe('makethe tests pass')
  })

  it('applies Backspace and drops escape sequences', () => {
    expect(appendTypedDraftText('fixx', '\x7f', 100)).toBe('fix')
    expect(appendTypedDraftText('fix', '\x1b[A', 100)).toBe('fix')
  })

  it('stops at the bound', () => {
    expect(appendTypedDraftText('ab', 'cdef', 4)).toBe('abcd')
  })
})

describe('agent pane keys typed before its PTY binds', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    pairedRoute.runtimeEnvironmentId = null
    await restoreTerminalTestGlobals()
  })

  it('pastes them as an unsubmitted draft once the agent is ready', async () => {
    waitForAgentDraftInputReady.mockResolvedValue(true)
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    pane.type('make the tests pass')
    pane.type('\r')
    expect(pane.transport.sendInput).not.toHaveBeenCalled()

    pane.bind('pty-1')
    await flushAsyncTicks(20)

    expect(waitForAgentDraftInputReady).toHaveBeenCalledWith(
      'pty-1',
      expect.any(Number),
      expect.any(String)
    )
    expect(sendAgentDraftPasteContent).toHaveBeenCalledWith(
      'pty-1',
      'make the tests pass',
      'driving',
      expect.any(Function)
    )
    pane.dispose()
  })

  it('drops them with a notice when the agent never reports ready', async () => {
    waitForAgentDraftInputReady.mockResolvedValue(false)
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    pane.type('hello')
    pane.bind('pty-1')
    await flushAsyncTicks(20)

    expect(sendAgentDraftPasteContent).not.toHaveBeenCalled()
    expect(onPasteTimeout).toHaveBeenCalledOnce()
    pane.dispose()
  })

  it('leaves input typed after the bind on today’s path when nothing was held', async () => {
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    pane.bind('pty-1')
    pane.type('y')

    expect(waitForAgentDraftInputReady).not.toHaveBeenCalled()
    expect(pane.transport.sendInput).toHaveBeenCalledWith('y', 'driving')
    pane.dispose()
  })

  it('sends keys typed after the bind live and drops the draft rather than pasting over them', async () => {
    let ready!: (value: boolean) => void
    waitForAgentDraftInputReady.mockReturnValue(
      new Promise<boolean>((resolve) => (ready = resolve))
    )
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    pane.type('fix it')
    pane.bind('pty-1')
    pane.type('y')
    expect(pane.transport.sendInput).toHaveBeenCalledWith('y', 'driving')

    ready(true)
    await flushAsyncTicks(20)

    expect(sendAgentDraftPasteContent).not.toHaveBeenCalled()
    expect(onPasteTimeout).toHaveBeenCalledOnce()
    pane.dispose()
  })

  // Why: a trust prompt during startup must take the user's answer, never trap it in the draft.
  it('lets the user answer a startup trust prompt and never pastes the draft into it', async () => {
    let ready!: (value: boolean) => void
    waitForAgentDraftInputReady.mockReturnValue(
      new Promise<boolean>((resolve) => (ready = resolve))
    )
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    pane.type('make the tests pass')
    pane.bind('pty-1')
    mockStoreState.agentStatusByPaneKey[pane.paneKey] = {
      state: 'blocked',
      prompt: 'Do you trust the files in this folder?',
      agentType: 'claude',
      paneKey: pane.paneKey,
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      stateHistory: []
    }
    pane.type('1')
    pane.type('\r')

    expect(pane.transport.sendInput).toHaveBeenCalledWith('1', 'driving')
    expect(pane.transport.sendInput).toHaveBeenCalledWith('\r', 'driving')
    ready(true)
    await flushAsyncTicks(20)
    expect(sendAgentDraftPasteContent).not.toHaveBeenCalled()
    pane.dispose()
  })

  it('drops the draft when the agent is blocked on a prompt at ready time', async () => {
    waitForAgentDraftInputReady.mockResolvedValue(true)
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    pane.type('later')
    mockStoreState.agentStatusByPaneKey[pane.paneKey] = {
      state: 'waiting',
      prompt: '',
      agentType: 'claude',
      paneKey: pane.paneKey,
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      stateHistory: []
    }
    pane.bind('pty-1')
    await flushAsyncTicks(20)

    expect(sendAgentDraftPasteContent).not.toHaveBeenCalled()
    expect(onPasteTimeout).toHaveBeenCalledOnce()
    pane.dispose()
  })

  it('drops the held draft when the pane closes before the bind', async () => {
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    pane.type('lost on close')
    pane.dispose()
    pane.bind('pty-1')
    await flushAsyncTicks(20)

    expect(waitForAgentDraftInputReady).not.toHaveBeenCalled()
    expect(sendAgentDraftPasteContent).not.toHaveBeenCalled()
  })

  it('turns keys handed off to a remounted agent split into the draft', async () => {
    waitForAgentDraftInputReady.mockResolvedValue(true)
    const pane = connectAgentPane({
      cwdPromise: Promise.resolve('/split'),
      preconnectInput: [{ data: 'handed off', kind: 'ordinary', inputKind: 'driving' }]
    })
    await flushAsyncTicks(20)

    pane.bind('pty-1')
    await flushAsyncTicks(20)

    expect(createdTransportOptions[0]?.bufferInputUntilConnect).toBeUndefined()
    expect(createdTransportOptions[0]?.preconnectInput).toBeUndefined()
    expect(sendAgentDraftPasteContent).toHaveBeenCalledWith(
      'pty-1',
      'handed off',
      'driving',
      expect.any(Function)
    )
    pane.dispose()
  })

  // Why: after the first bind an unbind (exit, hibernation, remote re-attach) must not trap keys.
  it('never captures keys again after the first bind, even while unbound', async () => {
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    pane.bind('pty-1')
    pane.unbind()
    pane.type('abc')
    expect(pane.transport.sendInput).toHaveBeenCalledWith('abc', 'driving')

    pane.bind('pty-2')
    await flushAsyncTicks(20)
    expect(waitForAgentDraftInputReady).not.toHaveBeenCalled()
    expect(sendAgentDraftPasteContent).not.toHaveBeenCalled()
    pane.dispose()
  })

  it('discards the draft when the first bind is a reattach result, then sends keys live', async () => {
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    waitForAgentDraftInputReady.mockResolvedValue(true)
    pane.type('held')
    pane.resolveConnect({ id: 'pty-1', isReattach: true })
    await flushAsyncTicks(40)
    // A later fresh spawn (the cold-restore resume) must not receive the old draft either.
    pane.unbind()
    pane.bind('pty-2')
    await flushAsyncTicks(20)
    pane.type('z')

    expect(waitForAgentDraftInputReady).not.toHaveBeenCalled()
    expect(sendAgentDraftPasteContent).not.toHaveBeenCalled()
    expect(pane.transport.sendInput).toHaveBeenCalledWith('z', 'driving')
    pane.dispose()
  })

  // Why: an attach can land on a shell before main types the launch line; a paste would prefix it.
  it('drops the draft with a notice when the first bind is not a fresh spawn', async () => {
    const pane = connectAgentPane()
    await flushAsyncTicks(20)

    pane.type('held')
    pane.bindAttached('pty-1')
    await flushAsyncTicks(20)

    expect(waitForAgentDraftInputReady).not.toHaveBeenCalled()
    expect(sendAgentDraftPasteContent).not.toHaveBeenCalled()
    expect(onPasteTimeout).toHaveBeenCalledOnce()
    pane.dispose()
  })

  // Why: the paired-server transport holds and delivers type-ahead itself, Ctrl+C included.
  it('leaves a paired-server agent pane resuming a live entry on its own transport', async () => {
    pairedRoute.runtimeEnvironmentId = 'env-1'
    const paneKey = makePaneKey('tab-1', leafIdForPane(1))
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: '',
      agentType: 'claude',
      paneKey,
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      stateHistory: [],
      providerSession: { key: 'session_id', id: 'session-1' }
    }
    const pane = connectAgentPane({ startup: undefined })
    await flushAsyncTicks(20)

    pane.type('before reattach')
    pane.type('\x03')

    expect(pane.transport.sendInput).toHaveBeenCalledWith('before reattach', 'driving')
    // Ctrl+C takes the acknowledged-write path.
    expect(pane.transport.sendInputAccepted).toHaveBeenCalledWith('\x03', 'driving')
    pane.bind('pty-1')
    await flushAsyncTicks(20)
    expect(waitForAgentDraftInputReady).not.toHaveBeenCalled()
    expect(sendAgentDraftPasteContent).not.toHaveBeenCalled()
    pane.dispose()
  })

  it('keeps a startup-command pane that runs no agent on today’s drop', async () => {
    const pane = connectAgentPane({ startup: { command: 'pnpm install' } })
    await flushAsyncTicks(20)

    pane.type('x')

    expect(pane.transport.sendInput).toHaveBeenCalledWith('x', 'driving')
    pane.dispose()
  })
})
