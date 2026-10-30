import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { mockPanePtyArgs, connectMockPanePty } from './pty-connection-test-connect-mock-pane'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  installIpcPtyWindow,
  type PtyStreamPayload,
  type PtyExitPayload
} from './pty-transport-test-harness'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'
import type { PtyPreconnectInputEntry } from './pty-preconnect-input-buffer'
import type { PtyTransport } from './pty-transport-types'
import type { PtyPaneStartup } from './pty-connection-types'
import type * as PtyTransportModule from './pty-transport'
import type * as PtyPreHandlerBufferModule from './pty-pre-handler-buffer'
import type * as PtyDispatcherModule from './pty-dispatcher'

const MARKER = 'too many consoles in use, max consoles is 128'
let state: StoreState
let queue: MockTransport[] = []
let options: Record<string, unknown>[] = []
let subscribers: ((state: StoreState) => void)[] = []
let restoreUserAgent: (() => void) | undefined
let realTransport: typeof PtyTransportModule
let transportBuffers: typeof PtyPreHandlerBufferModule
let transportDispatcher: typeof PtyDispatcherModule

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
    spawn: (id = 'tab-pty') => onPtySpawn(id),
    output: (data: string) => callbacks?.onData?.(data),
    exit: (code = 1, id = 'tab-pty') => onPtyExit(id, code)
  }
}

async function heldLaunch({
  leafBinding = false,
  startup = null
}: { leafBinding?: boolean; startup?: PtyPaneStartup } = {}) {
  restoreUserAgent = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  let liveData: ((payload: PtyStreamPayload) => void) | undefined
  let liveExit: ((payload: PtyExitPayload) => void) | undefined
  installIpcPtyWindow(window, {
    data: (listener) => {
      liveData = listener
    },
    exit: (listener) => {
      liveExit = listener
    }
  })
  window.api.pty.claimViewport = vi.fn().mockResolvedValue(undefined)
  transportBuffers.clearPreHandlerPtyState('pty-1')
  transportDispatcher.ensurePtyDispatcher()
  transportDispatcher.reattachPtyDispatcherPushListeners()
  const handoffs = await import('./deferred-split-pane-handoff')
  const transportModule = await import('./pty-transport')
  const transports: PtyTransport[] = []
  vi.mocked(transportModule.createIpcPtyTransport).mockImplementation((opts) => {
    const transport = realTransport.createIpcPtyTransport(opts)
    transports.push(transport)
    return transport
  })
  const exitModule = await import('./pty-connection/pty-exit-hibernate')
  const install = exitModule.installPtyExitHibernate
  const captured: { session?: ConnectPanePtySession } = {}
  vi.spyOn(exitModule, 'installPtyExitHibernate').mockImplementation((session) => {
    install(session)
    captured.session = session
  })
  const readiness = await import('@/lib/agent-draft-readiness')
  vi.spyOn(readiness, 'waitForAgentDraftInputReady').mockReturnValue(new Promise(() => {}))
  const cwd = Promise.withResolvers<string>()
  const key = makePaneKey('tab-1', createPane(1).leafId)
  const firstHandle = handoffs.beginDeferredSplitPaneHandoff(key, cwd.promise)
  const { createTerminalPanePtyDeps } = await import('./terminal-pane-pty-deps')
  async function mount(
    handle = firstHandle,
    seeds: PtyPreconnectInputEntry[] = [],
    paneStartup = startup
  ) {
    const pane = createPane(1)
    let signalUserInput: () => void = vi.fn()
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
    const base = buildPaneConnectionDeps(() => state, {
      startup: paneStartup,
      cwdPromise: cwd.promise,
      ...handoffs.deferredSplitPaneConnectionInput(handle, seeds),
      onPaneProcessDied: vi.fn()
    })
    const manager = createManager(1)
    const [typedPane, typedManager, typedDeps] = mockPanePtyArgs(pane, manager, base)
    const deferredSplitHandoffs = new Map([[pane.id, handle]])
    const deps = {
      ...base,
      ...createTerminalPanePtyDeps({
        deps: {
          ...typedDeps,
          ...(leafBinding ? { syncPanePtyLayoutBindingForLeaf: vi.fn() } : {}),
          isActive: true,
          isVisible: true,
          systemPrefersDark: false,
          settings: null,
          settingsRef: { current: null },
          requestOpenLinksInAppPreference: vi.fn(),
          requestTerminalLinkAction: vi.fn(),
          effectiveMacOptionAsAlt: 'false',
          effectiveMacOptionAsAltRef: { current: 'false' },
          initialLayoutRef: {
            current: {
              root: { type: 'leaf', leafId: pane.leafId },
              activeLeafId: pane.leafId,
              expandedLeafId: null,
              ptyIdsByLeafId: {}
            }
          },
          managerRef: { current: typedManager },
          containerRef: { current: null },
          getTabWideAgentHintLeafId: () => null,
          expandedStyleSnapshotRef: { current: new Map() },
          paneFontSizesRef: { current: new Map() },
          paneCwdRef: { current: new Map() },
          panePtyBindingsRef: { current: new Map() },
          setTabPaneExpanded: vi.fn(),
          setTabCanExpandPane: vi.fn(),
          setExpandedPane: vi.fn(),
          syncExpandedLayout: vi.fn(),
          persistLayoutSnapshot: vi.fn(),
          showPaneTitle: vi.fn(),
          setPaneTitles: vi.fn(),
          paneTitlesRef: { current: {} },
          setRenamingPaneId: vi.fn(),
          setPaneCount: vi.fn(),
          setPaneLayoutRevision: vi.fn()
        },
        refs: {
          systemPrefersDarkRef: { current: false },
          previousVisibleForReconcileRef: { current: null },
          linkProviderDisposablesRef: { current: new Map() },
          terminalHandleLinkDisposablesRef: { current: new Map() },
          linkifierClickPrimingDisposablesRef: { current: new Map() },
          linkPointerGesturesRef: { current: new Map() },
          fileLinkClickFallbackDisposablesRef: { current: new Map() },
          httpLinkClickFallbackDisposablesRef: { current: new Map() },
          selectionDisposablesRef: { current: new Map() },
          nativeCopyDisposablesRef: { current: new Map() },
          selectionCaptureTimersRef: { current: new Map() },
          osc52DisposablesRef: { current: new Map() },
          osc7DisposablesRef: { current: new Map() },
          mouseHideDisposablesRef: { current: new Map() },
          imeCompositionDisposablesRef: { current: new Map() },
          imeNativeTextForwarderDisposablesRef: { current: new Map() },
          queuedInitialCwdRef: { current: undefined },
          restoredViewportBlankingPanesRef: { current: new Set() },
          replayingPanesRef: typedDeps.replayingPanesRef
        },
        startupCwd: typedDeps.cwd ?? '/tmp/wt-1',
        mountFollowsTerminalPark: false,
        restoredPtyIdByLeafId: {},
        deferredSplitHandoffs
      })
    }
    const { connectPanePty } = await import('./pty-connection')
    const binding = connectPanePty(typedPane, typedManager, {
      ...deps,
      ...handoffs.deferredSplitPaneConnectionInput(handle, seeds),
      cwdPromise: cwd.promise
    })
    await flushAsyncTicks()
    const transport = transports.at(-1)
    const session = captured.session
    if (!transport || !session) {
      throw new Error('Missing installed real transport session')
    }
    return {
      pane,
      deps,
      transport,
      session,
      handle,
      binding,
      seeds,
      deferredSplitHandoffs,
      input: (data: string) => {
        signalUserInput()
        sendTerminalInputThroughPane(pane, data)
      }
    }
  }
  async function die() {
    vi.mocked(window.api.pty.spawn).mockImplementation(async () => {
      transportBuffers.bufferPreHandlerPtyData('pty-1', MARKER)
      transportBuffers.bufferPreHandlerPtyExit('pty-1', 1)
      return { id: 'pty-1' }
    })
    cwd.resolve('C:\\repo')
    await flushAsyncTicks(30)
  }
  async function remount(view: Awaited<ReturnType<typeof mount>>, paneStartup = startup) {
    handoffs.releaseDeferredSplitPaneHandoff(view.handle)
    view.binding.dispose()
    const claim = handoffs.claimDeferredSplitPaneHandoff(key)
    if (!claim) {
      throw new Error('Missing pending launch')
    }
    return mount(claim.handle, claim.preconnectInput, paneStartup)
  }
  async function bind() {
    cwd.resolve('C:\\repo')
    await flushAsyncTicks(30)
  }
  function finish() {
    liveData?.({ id: 'pty-1', data: MARKER })
    liveExit?.({ id: 'pty-1', code: 1 })
  }
  return { ...handoffs, key, mount, die, remount, bind, finish }
}

describe('Git Bash console-capacity pane retention', () => {
  beforeAll(async () => {
    // Keep the suite-loaded transport and its buffer/dispatcher on the same module graph.
    realTransport = await vi.importActual<typeof PtyTransportModule>('./pty-transport')
    transportBuffers = await import('./pty-pre-handler-buffer')
    transportDispatcher = await import('./pty-dispatcher')
  })
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.mocked((await import('./pty-transport')).createIpcPtyTransport).mockReset()
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
    const handoffs = await import('./deferred-split-pane-handoff')
    handoffs.resetDeferredSplitPaneHandoffsForTests()
    await restoreTerminalTestGlobals()
    vi.restoreAllMocks()
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
    sendTerminalInputThroughPane(started.pane, '\u0003')
    started.output(MARKER)
    started.exit()
    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
    // The existing sole-newborn guard still owns an unacknowledged first input.
    expect(started.manager.closePane).not.toHaveBeenCalled()
  })

  it('keeps a pre-connect input attempt with the first process while cwd is pending', async () => {
    const readiness = await import('@/lib/agent-draft-readiness')
    vi.spyOn(readiness, 'waitForAgentDraftInputReady').mockReturnValue(new Promise(() => {}))
    const cwd = Promise.withResolvers<string>()
    const started = await startPane({ startup: null, cwdPromise: cwd.promise })
    expect(started.transport.connect).not.toHaveBeenCalled()
    started.transport.getPtyId.mockReturnValue(null)
    started.transport.sendInputAccepted?.mockImplementation(() => new Promise<boolean>(() => {}))
    sendTerminalInputThroughPane(started.pane, '\u0003')
    expect(started.transport.sendInputAccepted).toHaveBeenCalledWith('\u0003', 'query-reply')
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
    const oldAck = Promise.withResolvers<boolean>()
    started.transport.sendInputAccepted?.mockReturnValue(oldAck.promise)
    sendTerminalInputThroughPane(started.pane, '\u0003')
    // An obsolete non-null ID cannot fall through to the pending successor.
    started.transport.getPtyId.mockReturnValue('obsolete')
    sendTerminalInputThroughPane(started.pane, 'late obsolete event')
    started.transport.getPtyId.mockReturnValue('incoming')
    started.spawn('incoming')
    oldAck.resolve(true)
    await flushAsyncTicks()
    started.output(MARKER)
    incoming.callbacks.onData(MARKER)
    started.exit(1, 'incoming')
    expect(started.deps.onPaneProcessDied).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'git-bash-console-capacity' })
    )
  })
  it.each([
    { remounts: 1, data: '\u0003' },
    { remounts: 2, data: '\u0003' },
    { remounts: 1, data: '\u001b[I' }
  ])(
    'preserves driving $data through $remounts deferred-launch remounts before exit/flush',
    async ({ remounts, data }) => {
      const launch = await heldLaunch()
      let view = await launch.mount()
      view.input(data)
      for (let i = 0; i < remounts; i++) {
        view = await launch.remount(view)
      }
      vi.spyOn(Date, 'now').mockReturnValue(
        Date.now() + launch.DEFERRED_SPLIT_PANE_HANDOFF_TTL_MS + 1
      )
      expect(launch.claimDeferredSplitPaneHandoff(launch.key)).toBeNull()
      await launch.die()
      expect(view.deps.onPaneProcessDied).not.toHaveBeenCalled()
      expect(window.api.pty.write).not.toHaveBeenCalled()
      expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
    }
  )

  it.each(['passive', 'oversize-fallback', 'oversize-driving'])(
    'keeps %s classification independent of retained bytes',
    async (kind) => {
      const launch = await heldLaunch()
      let view = await launch.mount()
      const { PTY_PRECONNECT_INPUT_MAX_CODE_UNITS } = await import('./pty-preconnect-input-buffer')
      const data =
        kind === 'passive' ? '\u001b[I' : 'x'.repeat(PTY_PRECONNECT_INPUT_MAX_CODE_UNITS + 1)
      if (kind === 'oversize-driving') {
        view.input(data)
      } else {
        sendTerminalInputThroughPane(view.pane, data)
      }
      view = await launch.remount(view)
      if (kind !== 'passive') {
        expect(view.seeds).toEqual([])
      }
      await launch.die()
      expect(view.deps.onPaneProcessDied).toHaveBeenCalledTimes(kind === 'passive' ? 1 : 0)
      expect(window.api.pty.write).not.toHaveBeenCalled()
      expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
    }
  )

  it.each(['quick-command', 'accepted-paste', 'query-and-launch', 'captured-draft'])(
    'observes %s at the common public boundary before ACK',
    async (kind) => {
      const launch = await heldLaunch({
        startup: kind === 'captured-draft' ? { command: 'codex' } : null
      })
      const view = await launch.mount()
      let accepted: boolean | Promise<boolean> | undefined
      if (kind === 'quick-command') {
        const { sendTerminalQuickCommandToPane } = await import('./terminal-quick-command-dispatch')
        expect(
          sendTerminalQuickCommandToPane({
            command: { id: 'status', label: 'Status', command: 'git status', appendEnter: true },
            pane: { leafId: view.pane.leafId, terminal: { focus: vi.fn() } },
            tabId: 'tab-1',
            transport: view.transport
          })
        ).toBe(true)
      } else if (kind === 'accepted-paste') {
        const { writeTerminalPastePtyInput } = await import('./terminal-pty-paste-writer')
        const abort = new AbortController()
        accepted = writeTerminalPastePtyInput(view.transport, 'paste', 'driving', abort.signal)
        expect(accepted).toBeInstanceOf(Promise)
        abort.abort()
      } else if (kind === 'query-and-launch') {
        view.transport.sendInputImmediate('\u001b[0n')
        view.transport.sendInput('startup', 'launch')
        view.transport.sendInput('\u001b[I', 'query-reply')
      } else {
        view.input('draft')
      }
      await launch.die()
      if (accepted) {
        expect(await accepted).toBe(false)
      }
      expect(view.deps.onPaneProcessDied).toHaveBeenCalledTimes(
        kind === 'query-and-launch' || kind === 'captured-draft' ? 1 : 0
      )
      expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
    }
  )

  it('rejects a former owner while current owner can still observe after handoff membership expires', async () => {
    const launch = await heldLaunch()
    const former = await launch.mount()
    launch.releaseDeferredSplitPaneHandoff(former.handle)
    const claim = launch.claimDeferredSplitPaneHandoff(launch.key)
    if (!claim) {
      throw new Error('Missing pending launch')
    }
    const current = await launch.mount(claim.handle)
    former.session.forwardPtyInput('late old view', false)
    expect(current.session.pendingLaunchInputAttempt.attempted).toBe(false)
    current.session.deps.paneTransportsRef.current.set(current.pane.id, former.transport)
    expect(current.transport.sendInput('stale transport dispatch', 'driving')).toBe(true)
    expect(current.session.pendingLaunchInputAttempt.attempted).toBe(false)
    current.session.deps.paneTransportsRef.current.set(current.pane.id, current.transport)
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.now() + launch.DEFERRED_SPLIT_PANE_HANDOFF_TTL_MS + 1
    )
    expect(launch.claimDeferredSplitPaneHandoff(launch.key)).toBeNull()
    current.input('\u0003')
    await launch.die()
    expect(current.deps.onPaneProcessDied).not.toHaveBeenCalled()
    former.binding.dispose()
    vi.restoreAllMocks()
  })

  it('preserves the pending target through repeated captures before actual binding', async () => {
    const launch = await heldLaunch()
    const view = await launch.mount()
    view.input('\u0003')
    const { bindCaptureTransportOutputCallbacks } =
      await import('./pty-connection/transport-output-callbacks')
    bindCaptureTransportOutputCallbacks(view.session)
    view.session.captureTransportOutputCallbacks(vi.fn(), null)
    view.session.captureTransportOutputCallbacks(vi.fn(), null)
    await launch.die()
    expect(view.deps.onPaneProcessDied).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'keeps bound observation after real handoff consumption (leaf=%s)',
    async (leafBinding) => {
      const launch = await heldLaunch({ leafBinding })
      const view = await launch.mount()
      await launch.bind()
      expect(view.deferredSplitHandoffs.size).toBe(0)
      expect(launch.claimDeferredSplitPaneHandoff(launch.key)).toBeNull()
      const ack = Promise.withResolvers<boolean>()
      vi.mocked(window.api.pty.writeAccepted).mockReturnValue(ack.promise)
      view.input('live')
      launch.finish()
      expect(view.deps.onPaneProcessDied).not.toHaveBeenCalled()
      ack.resolve(true)
      await flushAsyncTicks()
    }
  )

  it('does not resurrect a released expired target or transfer its fact to a new launch', async () => {
    const launch = await heldLaunch()
    const former = await launch.mount()
    former.input('old launch')
    launch.releaseDeferredSplitPaneHandoff(former.handle)
    former.binding.dispose()
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.now() + launch.DEFERRED_SPLIT_PANE_HANDOFF_TTL_MS + 1
    )
    expect(launch.claimDeferredSplitPaneHandoff(launch.key)).toBeNull()
    const handle = launch.beginDeferredSplitPaneHandoff(launch.key, Promise.resolve('C:\\repo'))
    const current = await launch.mount(handle)
    former.session.forwardPtyInput('stale old launch', false)
    await launch.die()
    expect(current.deps.onPaneProcessDied).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'git-bash-console-capacity' })
    )
  })

  it('retains the exact mapped process on explicit handle rotation and retires its old alias', async () => {
    const exitModule = await import('./pty-connection/pty-exit-hibernate')
    const install = exitModule.installPtyExitHibernate
    const captured: { session?: ConnectPanePtySession } = {}
    vi.spyOn(exitModule, 'installPtyExitHibernate').mockImplementation((session) => {
      install(session)
      captured.session = session
    })
    const started = await startPane()
    const session = captured.session
    if (!session) {
      throw new Error('Missing installed session')
    }
    started.spawn()
    sendTerminalInputThroughPane(started.pane, 'before rotation')
    const process = session.processExitStateByPtyId.get('tab-pty')
    const rebind = options[0]?.onPtyRebind
    if (typeof rebind !== 'function') {
      throw new Error('Missing handle-rotation callback')
    }
    started.transport.getPtyId.mockReturnValue('rotated')
    rebind('rotated', 'tab-pty')
    expect(session.processExitStateByPtyId.get('rotated')).toBe(process)
    expect(session.processExitStateByPtyId.has('tab-pty')).toBe(false)
    started.output(MARKER)
    started.exit(1, 'rotated')
    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
  })

  it('keeps the earlier attempt when handed-off bytes become an agent draft', async () => {
    const launch = await heldLaunch()
    let view = await launch.mount()
    view.input('draft text')
    view = await launch.remount(view, { command: 'codex' })
    expect(view.seeds).toHaveLength(1)
    await launch.die()
    expect(view.deps.onPaneProcessDied).not.toHaveBeenCalled()
    expect(window.api.pty.write).not.toHaveBeenCalled()
    expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
  })
})
