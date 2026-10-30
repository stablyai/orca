import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import {
  sendTerminalInputThroughPane,
  temporarilySetNavigatorUserAgent
} from './pty-connection-test-dom'
import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'
import { flushAsyncTicks } from './pty-connection-test-async'

const MARKER = 'too many consoles in use, max consoles is 128'
let state: StoreState
let queue: MockTransport[] = []
let options: Record<string, unknown>[] = []
let subscribers: ((state: StoreState) => void)[] = []
let restoreUserAgent: (() => void) | undefined

async function startPane({ windows = true, handler = true, startup = { command: 'codex' } } = {}) {
  restoreUserAgent = temporarilySetNavigatorUserAgent(
    windows ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' : 'Mozilla/5.0 (X11; Linux x86_64)'
  )
  let callbacks: ConnectCallbacks | undefined
  const transport = createMockTransport('tab-pty')
  transport.connect.mockImplementation(async (args: { callbacks: ConnectCallbacks }) => {
    callbacks = args.callbacks
    return { id: 'tab-pty' }
  })
  queue.push(transport)
  const pane = createPane(1)
  const manager = createManager(1)
  const deps = buildPaneConnectionDeps(() => state, {
    onPaneProcessDied: handler ? vi.fn() : undefined,
    startup
  })
  await connectMockPanePty(pane, manager, deps)
  await flushAsyncTicks()
  const captured = options[0]
  expect(captured).toBeDefined()
  // SAFETY: the mock transport captures the production lifecycle callbacks at construction.
  const lifecycle = captured as {
    onPtySpawn: (id: string) => void
    onPtyExit: (id: string, code: number) => void
  }
  return {
    pane,
    manager,
    deps,
    transport,
    spawn: () => lifecycle.onPtySpawn('tab-pty'),
    output: (data: string) => callbacks?.onData?.(data),
    exit: (code = 1) => lifecycle.onPtyExit('tab-pty', code)
  }
}

describe('Git Bash console-capacity pane retention', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    queue = []
    options = []
    subscribers = []
    state = createInitialStoreState(() => state)
    bindPtyConnectionTestMocks({
      getState: () => state,
      getTransportQueue: () => queue,
      getTransportOptions: () => options,
      getStoreSubscribers: () => subscribers,
      setStoreSubscribers: (next) => {
        subscribers = next
      }
    })
    await installTerminalTestGlobals()
  })
  afterEach(async () => {
    restoreUserAgent?.()
    await restoreTerminalTestGlobals()
  })

  it('keeps a fresh Windows capacity failure and its startup command visible', async () => {
    const started = await startPane()
    started.spawn()
    started.output('console allocation failure: too many consoles ')
    started.output('in use, max consoles is 128')
    started.exit()
    expect(started.deps.onPaneProcessDied).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 1, exitCode: 1, reason: 'git-bash-console-capacity' })
    )
    expect(started.deps.onPtyExitRef.current).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'ordinary failure',
      windows: true,
      fresh: true,
      marker: 'bash: missing command',
      code: 1
    },
    {
      name: 'near match',
      windows: true,
      fresh: true,
      marker: 'too many consoles in use, max consoles is 127',
      code: 1
    },
    { name: 'Linux output', windows: false, fresh: true, marker: MARKER, code: 1 },
    { name: 'clean exit', windows: true, fresh: true, marker: MARKER, code: 0 },
    { name: 'reattached process', windows: true, fresh: false, marker: MARKER, code: 1 }
  ])('leaves $name to existing exit handling', async ({ windows, fresh, marker, code }) => {
    const started = await startPane({ windows })
    if (fresh) {
      started.spawn()
    }
    started.output(marker)
    started.exit(code)
    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
  })

  it('records an input attempt before its acknowledgement and does not claim a capacity overlay', async () => {
    const started = await startPane()
    started.transport.sendInputAccepted?.mockImplementation(() => new Promise<boolean>(() => {}))
    started.spawn()
    sendTerminalInputThroughPane(started.pane, '\u0003')
    started.output(MARKER)
    started.exit()
    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
    // The existing sole-newborn guard still owns an unacknowledged first input.
    expect(started.manager.closePane).not.toHaveBeenCalled()
  })

  it('tears down an ordinary failed shell after acknowledged input', async () => {
    const started = await startPane()
    started.spawn()
    sendTerminalInputThroughPane(started.pane, 'exit\r')
    await flushAsyncTicks()
    started.output('bash: missing command')
    started.exit()
    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
    expect(started.deps.onPtyExitRef.current).toHaveBeenCalled()
  })

  it('uses existing newborn handling when no overlay handler is installed', async () => {
    const started = await startPane({ handler: false })
    started.spawn()
    started.output(MARKER)
    expect(() => started.exit()).not.toThrow()
    expect(started.manager.closePane).not.toHaveBeenCalled()
  })

  it('keys an input attempt to the bound process rather than its incoming replacement', async () => {
    const { installPtyExitHibernate } = await import('./pty-connection/pty-exit-hibernate')
    // SAFETY: installation writes callbacks; this test invokes only its isolated per-process bookkeeping.
    const session = { paneStartup: {} } as Parameters<typeof installPtyExitHibernate>[0]
    installPtyExitHibernate(session)
    const outgoing = session.currentProcessExitState
    session.bindProcessExitState('outgoing')
    const incoming = session.createProcessExitState({})
    session.currentProcessExitState = incoming
    session.noteTerminalInputForPty('outgoing')
    expect(outgoing.userInteracted).toBe(true)
    expect(incoming.userInteracted).toBe(false)
    expect(incoming.detector.detected()).toBe(false)
  })
})
