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
import type { PtyPaneStartup } from './pty-connection-types'

const MARKER = 'too many consoles in use, max consoles is 128'
let state: StoreState
let queue: MockTransport[] = []
let options: Record<string, unknown>[] = []
let subscribers: ((state: StoreState) => void)[] = []
let restoreUserAgent: (() => void) | undefined

async function startPane({
  windows = true,
  handler = true,
  startup = { command: 'codex' },
  cwdPromise
}: {
  windows?: boolean
  handler?: boolean
  startup?: PtyPaneStartup
  cwdPromise?: Promise<string>
} = {}) {
  restoreUserAgent = temporarilySetNavigatorUserAgent(
    windows ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' : 'Mozilla/5.0 (X11; Linux x86_64)'
  )
  let callbacks: ConnectCallbacks | undefined
  const transport = createMockTransport('tab-pty')
  transport.connect.mockImplementation(async (args: { callbacks: ConnectCallbacks }) => {
    callbacks = args.callbacks
    transport.getPtyId.mockReturnValue('tab-pty')
    return { id: 'tab-pty' }
  })
  queue.push(transport)
  const pane = createPane(1)
  let signalUserInput = () => {}
  Object.assign(pane.terminal, {
    _core: {
      coreService: {
        onUserInput: (listener: () => void) => {
          signalUserInput = listener
          return { dispose: vi.fn() }
        }
      }
    }
  })
  const manager = createManager(1)
  const deps = buildPaneConnectionDeps(() => state, {
    onPaneProcessDied: handler ? vi.fn() : undefined,
    startup,
    cwdPromise
  })
  await connectMockPanePty(pane, manager, deps)
  await flushAsyncTicks()
  const onPtySpawn = options[0]?.onPtySpawn
  const onPtyExit = options[0]?.onPtyExit
  if (typeof onPtySpawn !== 'function' || typeof onPtyExit !== 'function') {
    throw new Error('Missing production PTY lifecycle callbacks')
  }
  return {
    pane,
    manager,
    deps,
    transport,
    input: (data: string) => {
      signalUserInput()
      sendTerminalInputThroughPane(pane, data)
    },
    spawn: (id = 'tab-pty') => onPtySpawn(id),
    output: (data: string) => callbacks?.onData?.(data),
    exit: (code = 1, id = 'tab-pty') => onPtyExit(id, code)
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

  it('forwards automatic focus reports without disqualifying an untouched capacity failure', async () => {
    const started = await startPane()
    started.spawn()
    started.output('\u001b[?1004h')
    sendTerminalInputThroughPane(started.pane, '\u001b[O')
    sendTerminalInputThroughPane(started.pane, '\u001b[I')
    expect(started.transport.sendInput).toHaveBeenCalledWith('\u001b[O', 'query-reply')
    expect(started.transport.sendInput).toHaveBeenCalledWith('\u001b[I', 'query-reply')
    started.output(MARKER)
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
    started.input('\u0003')
    started.output(MARKER)
    started.exit()
    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
    // The existing sole-newborn guard still owns an unacknowledged first input.
    expect(started.manager.closePane).not.toHaveBeenCalled()
  })

  it('keeps a pre-connect input attempt with the first process while cwd is pending', async () => {
    const cwd = Promise.withResolvers<string>()
    const started = await startPane({ startup: null, cwdPromise: cwd.promise })
    expect(started.transport.connect).not.toHaveBeenCalled()
    started.transport.getPtyId.mockReturnValue(null)
    started.transport.sendInputAccepted?.mockImplementation(() => new Promise<boolean>(() => {}))
    started.input('\u0003')
    expect(started.transport.sendInputAccepted).toHaveBeenCalledWith('\u0003', 'driving')
    cwd.resolve('C:\\repo')
    await flushAsyncTicks(20)
    expect(started.transport.connect).toHaveBeenCalled()
    started.spawn()
    started.output(MARKER)
    started.exit()
    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
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
    const exitModule = await import('./pty-connection/pty-exit-hibernate')
    const install = exitModule.installPtyExitHibernate
    const captured: { session?: Parameters<typeof install>[0] } = {}
    vi.spyOn(exitModule, 'installPtyExitHibernate').mockImplementation((session) => {
      install(session)
      captured.session = session
    })
    const started = await startPane()
    const session = captured.session
    if (!session) {
      throw new Error('Missing production PTY session')
    }
    started.spawn()
    const incoming = session.captureTransportOutputCallbacks(vi.fn(), {})
    started.transport.sendInputAccepted?.mockImplementation(() => new Promise<boolean>(() => {}))
    sendTerminalInputThroughPane(started.pane, '\u0003')
    started.transport.getPtyId.mockReturnValue('incoming')
    started.spawn('incoming')
    incoming.callbacks.onData(MARKER)
    started.exit(1, 'incoming')
    expect(started.deps.onPaneProcessDied).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'git-bash-console-capacity' })
    )
  })
})
