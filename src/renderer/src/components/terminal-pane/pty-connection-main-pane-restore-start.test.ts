// Layout-owner main starts or resumes missing terminals; the window only asks and attaches, including after a failed reattach.
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  leafIdForPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { TerminalPaneStart } from '@/store/terminals/terminal-state'
import type { LayoutApplyHandlers, WindowLayoutCommand } from '@/runtime/layout-apply-send'
import type * as LayoutApplySend from '@/runtime/layout-apply-send'
import { LOCAL_LAYOUT_APPLY_ORIGIN } from '@/runtime/server-layout-apply-routes'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { PANE_NOT_LIVE_ERROR } from '../../../../shared/pane-attach-only-view'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const sent = vi.hoisted((): { command: WindowLayoutCommand; handlers: LayoutApplyHandlers }[] => [])
vi.mock('@/runtime/layout-apply-send', async (importOriginal) => ({
  ...(await importOriginal<LayoutApplySendModule>()),
  sendLayoutApply: (
    _state: unknown,
    _worktreeId: string,
    command: WindowLayoutCommand,
    handlers: LayoutApplyHandlers
  ) => {
    sent.push({ command, handlers })
    return true
  }
}))

type LayoutApplySendModule = typeof LayoutApplySend

const TAB = 'tab-restore-start'
const LEAF = leafIdForPane(1)
const PANE_KEY = `${TAB}:${LEAF}`

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

function setStore(patch: Partial<StoreState>): void {
  mockStoreState = { ...mockStoreState, ...patch }
  for (const listener of storeSubscribers) {
    listener(mockStoreState)
  }
}

function layoutBoundTo(ptyId: string): Partial<StoreState> {
  return {
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: ptyId }
      }
    }
  }
}

async function connectBound(
  start: TerminalPaneStart | undefined,
  visible = true,
  transport = createMockTransport()
) {
  const { connectPanePty } = await import('./pty-connection')
  transportFactoryQueue.push(transport)
  setStore({
    tabsByWorktree: { 'wt-1': [{ id: TAB, ptyId: 'pty-old' }] },
    ...layoutBoundTo('pty-old'),
    terminalPaneStartsByPaneKey: start ? { [PANE_KEY]: start } : {}
  })
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    tabId: TAB,
    restoredLeafId: LEAF,
    restoredPtyIdByLeafId: { [LEAF]: 'pty-old' },
    isVisibleRef: { current: visible }
  })
  const args = mockPanePtyArgs(createPane(1), createManager(1), deps)
  const connection = connectPanePty(...args)
  await flushAsyncTicks()
  return { transport, deps, connection }
}

/** Main's start: the frame shows the pane starting, its reply lands, then the pane binds. */
async function mainStartsAndBinds(ptyId: string): Promise<void> {
  setStore({ terminalPaneStartsByPaneKey: { [PANE_KEY]: { status: 'resuming' } } })
  sent.at(-1)?.handlers.apply({}, LOCAL_LAYOUT_APPLY_ORIGIN)
  await flushAsyncTicks()
  setStore({ ...layoutBoundTo(ptyId), terminalPaneStartsByPaneKey: {} })
  await flushAsyncTicks()
}

const startPaneCommands = (): WindowLayoutCommand[] =>
  sent.map((entry) => entry.command).filter((command) => command.type === 'startPane')

describe('a restored pane main starts (layout-owner build)', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    sent.length = 0
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    bindPtyConnectionTestMocks({
      getState: () => mockStoreState,
      getTransportQueue: () => transportFactoryQueue,
      getTransportOptions: () => [],
      getStoreSubscribers: () => storeSubscribers,
      setStoreSubscribers: (subscribers) => {
        storeSubscribers = subscribers
      }
    })
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it("ptyId + sleeping doesn't attach; a later live bind does", async () => {
    const { transport } = await connectBound({ status: 'sleeping' })

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).not.toHaveBeenCalled()
    expect(startPaneCommands()).toEqual([{ type: 'startPane', tabId: TAB, paneKey: PANE_KEY }])

    await mainStartsAndBinds('pty-new')

    expect(transport.connect).toHaveBeenCalledTimes(1)
    const [options] = transport.connect.mock.calls[0]
    expect(options).toMatchObject({ sessionId: 'pty-new', attachOnlyView: true })
    // Main resumed the agent; the attach carries no command of its own.
    expect(options).not.toHaveProperty('command')
    expect(options).not.toHaveProperty('resumeProviderSession')
  })

  it('a hidden sleeping pane asks main only once it is shown', async () => {
    const { transport, deps, connection } = await connectBound({ status: 'sleeping' }, false)
    expect(startPaneCommands()).toEqual([])
    expect(transport.connect).not.toHaveBeenCalled()

    deps.isVisibleRef.current = true
    connection.noteVisibilityResume?.()
    await flushAsyncTicks()

    expect(startPaneCommands()).toHaveLength(1)
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('a reattach whose terminal is gone asks main, then attaches to what main binds', async () => {
    const transport = createMockTransport()
    transport.connect.mockImplementationOnce(
      async (options: { callbacks?: { onError?: (message: string) => void } }) => {
        options.callbacks?.onError?.(
          `Error invoking remote method 'pty:spawn': ${PANE_NOT_LIVE_ERROR}`
        )
        return undefined
      }
    )
    const { deps } = await connectBound(undefined, true, transport)

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect.mock.calls[0][0]).toMatchObject({
      sessionId: 'pty-old',
      attachOnlyView: true
    })
    expect(startPaneCommands()).toEqual([{ type: 'startPane', tabId: TAB, paneKey: PANE_KEY }])
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()

    await mainStartsAndBinds('pty-new')

    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(transport.connect.mock.calls[1][0]).toMatchObject({
      sessionId: 'pty-new',
      attachOnlyView: true
    })
    expect(transport.connect.mock.calls[1][0]).not.toHaveProperty('command')
  })

  it('asks main once when the terminal main bound is gone too, then shows why', async () => {
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      async (options: { callbacks?: { onError?: (message: string) => void } }) => {
        options.callbacks?.onError?.(PANE_NOT_LIVE_ERROR)
        return undefined
      }
    )
    const { deps } = await connectBound(undefined, true, transport)
    await mainStartsAndBinds('pty-new')

    expect(startPaneCommands()).toHaveLength(1)
    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
      1,
      'The terminal could not start: terminal_not_started'
    )
  })

  it('a hidden pane whose terminal is gone asks main only once it is shown', async () => {
    const transport = createMockTransport()
    let answerGone = (): void => {}
    transport.connect.mockImplementationOnce(
      (options: { callbacks?: { onError?: (message: string) => void } }) =>
        new Promise<undefined>((resolve) => {
          answerGone = () => {
            options.callbacks?.onError?.(PANE_NOT_LIVE_ERROR)
            resolve(undefined)
          }
        })
    )
    const { deps, connection } = await connectBound(undefined, true, transport)
    // The pane is hidden by the time its attach finds the terminal gone.
    deps.isVisibleRef.current = false
    answerGone()
    await flushAsyncTicks()
    expect(startPaneCommands()).toEqual([])

    deps.isVisibleRef.current = true
    connection.noteVisibilityResume?.()
    await flushAsyncTicks()

    expect(startPaneCommands()).toHaveLength(1)
  })

  it('asks main again on the next view after a refused start', async () => {
    const { deps, connection } = await connectBound({ status: 'sleeping' })
    expect(startPaneCommands()).toHaveLength(1)

    sent.at(-1)?.handlers.refused?.('call_failed')
    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
      1,
      'The terminal could not start: call_failed'
    )
    connection.noteVisibilityResume?.()
    await flushAsyncTicks()

    expect(startPaneCommands()).toHaveLength(2)
  })

  it('a twin main hands back starts as today from then on', async () => {
    const { transport } = await connectBound({ status: 'sleeping' })
    sent.at(-1)?.handlers.asToday()
    await flushAsyncTicks()

    expect(startPaneCommands()).toHaveLength(1)
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect.mock.calls[0][0]).not.toHaveProperty('attachOnlyView')
  })
})
