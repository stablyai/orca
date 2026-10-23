// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { PaneManager, type ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport-types'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return {
    state,
    callRuntimeRpc: vi.fn(),
    recordCreatedTerminalPaneSplit: vi.fn((pane: unknown) => Boolean(pane)),
    splitWebRuntimeTerminal: vi.fn(() => false),
    toastError: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/runtime/web-runtime-terminal-actions', () => ({
  splitWebRuntimeTerminal: mocks.splitWebRuntimeTerminal
}))
vi.mock('./terminal-pane-split-completion', () => ({
  recordCreatedTerminalPaneSplit: mocks.recordCreatedTerminalPaneSplit
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'

const WT = 'wt-1'
const SOURCE = 'remote:env-b@@handle-1'
const ENV_B = { kind: 'environment', environmentId: 'env-b' }

function stampedSetup(): Record<string, unknown> {
  return {
    id: 'setup-b',
    projectId: 'project-1',
    hostId: 'runtime:env-b',
    repoId: 'repo-1',
    path: '/srv/project',
    setupState: 'ready'
  }
}

function stampedState(tabOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repos: [{ id: 'repo-1', connectionId: null }],
    worktreesByRepo: { 'repo-1': [{ id: WT, repoId: 'repo-1', projectId: 'project-1' }] },
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set<string>(),
    projectHostSetups: [stampedSetup()],
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: 'tab-1',
          worktreeId: WT,
          contentType: 'terminal',
          executionHostId: 'runtime:env-b',
          projectHostSetupId: 'setup-b',
          ...tabOverrides
        }
      ]
    }
  }
}

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const managers: PaneManager[] = []
const panes: ManagedPane[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.destroy()
  }
  for (const pane of panes.splice(0)) {
    pane.terminal.dispose()
    pane.fitAddon.dispose()
    pane.searchAddon.dispose()
    pane.serializeAddon.dispose()
  }
})

function makePane(id: number, leafId: string): ManagedPane {
  if (!isTerminalLeafId(leafId)) {
    throw new Error('Expected a valid fixture leaf id')
  }
  const pane: ManagedPane = {
    id,
    leafId,
    stablePaneId: leafId,
    terminal: new Terminal({ cols: 80, rows: 24, allowProposedApi: true }),
    container: document.createElement('div'),
    linkTooltip: document.createElement('div'),
    fitAddon: new FitAddon(),
    searchAddon: new SearchAddon(),
    serializeAddon: new SerializeAddon()
  }
  panes.push(pane)
  return pane
}

function makeManager(sourcePane: ManagedPane, splitPane: PaneManager['splitPane']): PaneManager {
  const manager = new PaneManager(document.createElement('div'), { linkOpenHint: () => '' })
  managers.push(manager)
  vi.spyOn(manager, 'getPanes').mockReturnValue([sourcePane])
  vi.spyOn(manager, 'splitPane').mockImplementation(splitPane)
  return manager
}

function fakeTransport(getPtyId: () => string | null): PtyTransport {
  return {
    connect: () => {},
    attach: () => {},
    disconnect: () => {},
    sendInput: () => false,
    sendInputImmediate: () => false,
    resize: () => false,
    isConnected: () => true,
    getPtyId
  }
}

function split(
  options: {
    sourcePtyId?: string | null
    manager?: PaneManager | null
    createdPane?: ManagedPane | null
  } = {}
) {
  const sourcePane = makePane(1, LEAF_1)
  const createdPane = options.createdPane === undefined ? makePane(2, LEAF_2) : options.createdPane
  const splitPane = vi.fn<PaneManager['splitPane']>(() => createdPane)
  const manager =
    options.manager === undefined ? makeManager(sourcePane, splitPane) : options.manager
  let sourcePtyId = options.sourcePtyId === undefined ? SOURCE : options.sourcePtyId
  let liveManager = manager
  splitTerminalPaneWithInheritedCwd({
    worktreeId: WT,
    tabId: 'tab-1',
    manager: manager ?? makeManager(sourcePane, splitPane),
    getManager: () => liveManager,
    paneTransports: new Map([[1, fakeTransport(() => sourcePtyId)]]),
    paneCwdMap: new Map(),
    fallbackCwd: '/fallback',
    pane: sourcePane,
    direction: 'vertical',
    source: 'keyboard'
  })
  return {
    splitPane,
    createdPane,
    setSourcePtyId: (ptyId: string | null) => {
      sourcePtyId = ptyId
    },
    replaceManager: () => {
      // Same pane id in a new manager does not prove the same live pane.
      liveManager = makeManager(makePane(1, LEAF_1), splitPane)
    }
  }
}

function deferReply() {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  mocks.callRuntimeRpc.mockImplementationOnce(
    () =>
      new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
  )
  return {
    resolve: async (value: unknown) => {
      resolve(value)
      await new Promise((tick) => setTimeout(tick, 0))
    },
    reject: async (error: unknown) => {
      reject(error)
      await new Promise((tick) => setTimeout(tick, 0))
    }
  }
}

const VALID_REPLY = {
  split: { handle: 'child-1', tabId: 'remote-tab', paneRuntimeId: 9, leafId: 'remote-leaf' }
}

describe('splitting a host-stamped terminal pane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.callRuntimeRpc.mockResolvedValue(undefined)
    mocks.state = stampedState()
  })

  it('splits on the target and mirrors a fresh local leaf with the encoded child PTY', async () => {
    const reply = deferReply()
    const { splitPane, createdPane } = split()

    expect(mocks.callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(ENV_B, 'terminal.split', {
      terminal: 'handle-1',
      direction: 'vertical',
      telemetrySource: 'keyboard'
    })
    expect(splitPane).not.toHaveBeenCalled()
    await reply.resolve(VALID_REPLY)

    // Why exact: no remote tabId/leafId/paneRuntimeId may become local identity.
    expect(splitPane).toHaveBeenCalledExactlyOnceWith(1, 'vertical', {
      ptyId: 'remote:env-b@@child-1'
    })
    expect(mocks.recordCreatedTerminalPaneSplit).toHaveBeenCalledWith(
      createdPane,
      expect.anything()
    )
    expect(mocks.splitWebRuntimeTerminal).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an ownerless source PTY', stampedState(), 'remote:handle-1'],
    ['a foreign source PTY', stampedState(), 'remote:env-c@@handle-1'],
    ['a local source PTY', stampedState(), 'pty-local-1'],
    ['no source PTY', stampedState(), null],
    ['an invalid host stamp', stampedState({ executionHostId: 'local' }), SOURCE],
    ['a blank setup stamp', stampedState({ projectHostSetupId: '' }), SOURCE],
    ['a missing setup', { ...stampedState(), projectHostSetups: [] }, SOURCE]
  ])('refuses %s with no RPC, no leaf and no web/local fallback', (_label, state, sourcePtyId) => {
    mocks.state = state
    const { splitPane } = split({ sourcePtyId })

    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.splitWebRuntimeTerminal).not.toHaveBeenCalled()
    expect(splitPane).not.toHaveBeenCalled()
  })

  it.each([
    ['no reply', undefined],
    ['no split', {}],
    ['a blank handle', { split: { handle: '  ' } }],
    ['a non-string handle', { split: { handle: 5 } }]
  ])('creates no leaf, closes nothing and never retries on %s', async (_label, value) => {
    const reply = deferReply()
    const { splitPane } = split()
    await reply.resolve(value)

    expect(splitPane).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('neither adopts nor closes a reply that echoes the original source handle', async () => {
    const reply = deferReply()
    const { splitPane } = split()
    await reply.resolve({ split: { handle: 'handle-1', tabId: 'remote-tab', paneRuntimeId: 1 } })

    expect(splitPane).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('creates no leaf and never retries when the split RPC fails', async () => {
    const reply = deferReply()
    const { splitPane } = split()
    await reply.reject(new Error('terminal_not_found'))

    expect(splitPane).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('terminal_not_found')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the manager is gone', (_ctx: ReturnType<typeof split>) => {}, { manager: null }],
    [
      'the source PTY changed',
      (ctx: ReturnType<typeof split>) => ctx.setSourcePtyId('remote:env-b@@handle-2'),
      {}
    ],
    [
      'the tab lost its host stamp',
      () => {
        mocks.state = stampedState({ projectHostSetupId: undefined })
      },
      {}
    ],
    ['the live manager was replaced', (ctx: ReturnType<typeof split>) => ctx.replaceManager(), {}],
    [
      'the setup moved within the same host',
      () => {
        mocks.state = {
          ...stampedState(),
          projectHostSetups: [{ ...stampedSetup(), path: '/srv/moved' }]
        }
      },
      {}
    ]
  ])('closes only the new child when %s', async (_label, mutate, options) => {
    const reply = deferReply()
    const ctx = split(options)
    mutate(ctx)
    await reply.resolve(VALID_REPLY)

    expect(ctx.splitPane).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(ENV_B, 'terminal.close', {
      terminal: 'child-1'
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2)
  })

  it('closes only the new child when the local split cannot be created', async () => {
    const reply = deferReply()
    const { splitPane } = split({ createdPane: null })
    await reply.resolve(VALID_REPLY)

    expect(splitPane).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(ENV_B, 'terminal.close', {
      terminal: 'child-1'
    })
  })

  it('leaves an unstamped tab on the existing web/local split path', () => {
    mocks.state = stampedState({ projectHostSetupId: undefined })
    mocks.splitWebRuntimeTerminal.mockReturnValueOnce(true)
    const { splitPane } = split()

    expect(mocks.splitWebRuntimeTerminal).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(splitPane).not.toHaveBeenCalled()
  })
})
