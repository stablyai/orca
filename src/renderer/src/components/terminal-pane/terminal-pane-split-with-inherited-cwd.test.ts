import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport-types'
import type { PaneCwdMap } from './resolve-split-cwd'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'
import { createDeferred } from './pty-connection-test-async'
import type { splitPaneInMain } from './terminal-pane-split-in-main'

const mocks = vi.hoisted(() => {
  const settings: { terminalFocusNewSplitPane?: boolean } | null = {}
  return {
    layoutOwnerIsMain: false,
    recordCreatedTerminalPaneSplit: vi.fn(),
    resolveSplitCwd: vi.fn(),
    splitPaneInMain: vi.fn<typeof splitPaneInMain>(),
    splitWebRuntimeTerminal: vi.fn(),
    settings
  }
})

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

vi.mock('./terminal-pane-split-in-main', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  splitPaneInMain: mocks.splitPaneInMain
}))

vi.mock('@/runtime/web-runtime-terminal-actions', () => ({
  splitWebRuntimeTerminal: mocks.splitWebRuntimeTerminal
}))

vi.mock('./resolve-split-cwd', () => ({
  resolveSplitCwd: mocks.resolveSplitCwd
}))

vi.mock('./terminal-pane-split-completion', () => ({
  recordCreatedTerminalPaneSplit: mocks.recordCreatedTerminalPaneSplit
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: mocks.settings }) }
}))

function makeManager(splitPane: ReturnType<typeof vi.fn>): PaneManager {
  // A pane counts as mounted once a split that placed it returned a pane.
  const getNumericIdForLeaf = (leafId: string): number | null =>
    splitPane.mock.calls.some(
      (call, index) => call[2]?.leafId === leafId && splitPane.mock.results[index]?.value
    )
      ? 2
      : null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the split reads only splitPane and getNumericIdForLeaf.
  return { splitPane, getNumericIdForLeaf } as unknown as PaneManager
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the split reads only the pane's ids and grid size.
const LAYOUT_OWNER_SOURCE_PANE = {
  id: 1,
  leafId: 'leaf-1',
  terminal: { cols: 80, rows: 24 }
} as unknown as ManagedPane

describe('splitTerminalPaneWithInheritedCwd', () => {
  beforeEach(() => {
    mocks.layoutOwnerIsMain = false
    mocks.splitPaneInMain.mockReset()
    mocks.recordCreatedTerminalPaneSplit.mockReset()
    mocks.resolveSplitCwd.mockReset()
    mocks.splitWebRuntimeTerminal.mockReset()
    mocks.splitWebRuntimeTerminal.mockReturnValue(false)
    mocks.settings = {}
  })

  it.each(['keyboard', 'context_menu'] as const)(
    'delegates remote %s splits without creating a competing local pane',
    (source) => {
      const splitPane = vi.fn()
      const transport = { getPtyId: () => 'remote:web-env-1@@terminal-1' } as PtyTransport
      mocks.splitWebRuntimeTerminal.mockReturnValue(true)

      splitTerminalPaneWithInheritedCwd({
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        manager: makeManager(splitPane),
        paneTransports: new Map([[1, transport]]),
        paneCwdMap: new Map(),
        fallbackCwd: '/fallback',
        pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
        direction: 'vertical',
        source
      })

      expect(mocks.splitWebRuntimeTerminal).toHaveBeenCalledWith(
        'remote:web-env-1@@terminal-1',
        'vertical',
        source,
        { worktreeId: 'worktree-1', tabId: 'tab-1', leafId: 'leaf-1' }
      )
      expect(splitPane).not.toHaveBeenCalled()
    }
  )

  it('keeps the existing local split-and-focus path unchanged', () => {
    const createdPane = { id: 2 }
    const splitPane = vi.fn(() => createdPane)

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager: makeManager(splitPane),
      paneTransports: new Map(),
      paneCwdMap: new Map([[1, { cwd: '/cached', confirmed: true }]]),
      fallbackCwd: '/fallback',
      pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
      direction: 'horizontal',
      source: 'keyboard'
    })

    expect(splitPane).toHaveBeenCalledWith(1, 'horizontal', { cwd: '/cached' })
    expect(mocks.recordCreatedTerminalPaneSplit).toHaveBeenCalledWith(createdPane, {
      source: 'keyboard',
      direction: 'horizontal'
    })
  })

  it('creates and records the split before asynchronous cwd resolution settles', async () => {
    const cwd = createDeferred<string>()
    const createdPane = { id: 2 }
    const staleSplitPane = vi.fn()
    const liveSplitPane = vi.fn(
      (
        _paneId: number,
        _direction: 'vertical' | 'horizontal',
        _opts?: { cwdPromise?: Promise<string> }
      ) => createdPane
    )
    let cwdSettled = false
    void cwd.promise.then(() => {
      cwdSettled = true
    })
    mocks.resolveSplitCwd.mockReturnValue(cwd.promise)

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager: makeManager(staleSplitPane),
      getManager: () => makeManager(liveSplitPane),
      paneTransports: new Map([[1, { getPtyId: () => 'pty-1' } as PtyTransport]]),
      paneCwdMap: new Map(),
      fallbackCwd: '/fallback',
      pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
      direction: 'vertical',
      source: 'keyboard'
    })

    expect(cwdSettled).toBe(false)
    expect(mocks.resolveSplitCwd).toHaveBeenCalledWith({
      paneCwdMap: expect.any(Map),
      sourcePaneId: 1,
      sourcePtyId: 'pty-1',
      fallbackCwd: '/fallback'
    })
    expect(staleSplitPane).not.toHaveBeenCalled()
    expect(liveSplitPane).toHaveBeenCalledWith(1, 'vertical', { cwdPromise: cwd.promise })
    expect(mocks.recordCreatedTerminalPaneSplit).toHaveBeenCalledWith(createdPane, {
      source: 'keyboard',
      direction: 'vertical'
    })

    const spawnHints = liveSplitPane.mock.calls[0]?.[2] as
      | { cwdPromise?: Promise<string> }
      | undefined
    cwd.resolve('/resolved')

    await expect(spawnHints?.cwdPromise).resolves.toBe('/resolved')
  })

  it('reuses one pending cwd lookup across rapid nested splits', () => {
    const cwd = createDeferred<string>()
    const firstCreatedPane = { id: 2, leafId: 'leaf-2' } as ManagedPane
    const secondCreatedPane = { id: 3, leafId: 'leaf-3' } as ManagedPane
    const splitPane = vi
      .fn()
      .mockReturnValueOnce(firstCreatedPane)
      .mockReturnValueOnce(secondCreatedPane)
    const manager = makeManager(splitPane)
    const paneCwdMap: PaneCwdMap = new Map()
    mocks.resolveSplitCwd.mockReturnValue(cwd.promise)

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager,
      paneTransports: new Map([[1, { getPtyId: () => 'pty-1' } as PtyTransport]]),
      paneCwdMap,
      fallbackCwd: '/fallback',
      pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
      direction: 'vertical',
      source: 'keyboard'
    })

    paneCwdMap.set(firstCreatedPane.id, {
      cwd: '/fallback',
      confirmed: false,
      pendingCwd: cwd.promise
    })
    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager,
      paneTransports: new Map(),
      paneCwdMap,
      fallbackCwd: '/fallback',
      pane: firstCreatedPane,
      direction: 'horizontal',
      source: 'keyboard'
    })

    expect(mocks.resolveSplitCwd).toHaveBeenCalledOnce()
    expect(splitPane).toHaveBeenNthCalledWith(1, 1, 'vertical', {
      cwdPromise: cwd.promise
    })
    expect(splitPane).toHaveBeenNthCalledWith(2, 2, 'horizontal', {
      cwdPromise: cwd.promise
    })
  })

  it('does not resolve cwd or split a stale manager when the live manager is gone', () => {
    const staleSplitPane = vi.fn()

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager: makeManager(staleSplitPane),
      getManager: () => null,
      paneTransports: new Map<number, PtyTransport>(),
      paneCwdMap: new Map(),
      fallbackCwd: '/fallback',
      pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
      direction: 'horizontal',
      source: 'context_menu'
    })

    expect(staleSplitPane).not.toHaveBeenCalled()
    expect(mocks.resolveSplitCwd).not.toHaveBeenCalled()
    expect(mocks.recordCreatedTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('asks the pane manager not to focus the new pane when Focus New Split Pane is off', () => {
    mocks.settings = { terminalFocusNewSplitPane: false }
    const cwd = createDeferred<string>()
    mocks.resolveSplitCwd.mockReturnValue(cwd.promise)
    const splitPane = vi.fn()
    const base = {
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager: makeManager(splitPane),
      paneTransports: new Map<number, PtyTransport>(),
      fallbackCwd: '/fallback',
      pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
      direction: 'vertical',
      source: 'keyboard'
    } as const

    splitTerminalPaneWithInheritedCwd({
      ...base,
      paneCwdMap: new Map([[1, { cwd: '/cached', confirmed: true }]])
    })
    splitTerminalPaneWithInheritedCwd({ ...base, paneCwdMap: new Map() })

    expect(splitPane).toHaveBeenNthCalledWith(1, 1, 'vertical', {
      cwd: '/cached',
      focusNewPane: false
    })
    expect(splitPane).toHaveBeenNthCalledWith(2, 1, 'vertical', {
      cwdPromise: cwd.promise,
      focusNewPane: false
    })
  })

  it('never asks main in a window-owned build', () => {
    const splitPane = vi.fn(() => ({ id: 2 }))

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager: makeManager(splitPane),
      paneTransports: new Map(),
      paneCwdMap: new Map([[1, { cwd: '/cached', confirmed: true }]]),
      fallbackCwd: '/fallback',
      pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
      direction: 'vertical',
      source: 'keyboard'
    })

    expect(mocks.splitPaneInMain).not.toHaveBeenCalled()
    expect(splitPane).toHaveBeenCalledWith(1, 'vertical', { cwd: '/cached' })
  })

  it('in a layout-owner build, asks main to split and start the pane, and leaves drawing it to main’s frame', () => {
    const splitPane = vi.fn(() => ({ id: 2 }))
    splitInLayoutOwnerBuild(makeManager(splitPane))

    expect(mocks.splitPaneInMain).toHaveBeenCalledWith(
      {
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        sourceLeafId: 'leaf-1',
        direction: 'vertical',
        cwd: '/cached',
        // Half the source pane's 80x24 grid, side by side.
        initialSize: { cols: 40, rows: 24 },
        telemetry: { source: 'keyboard' }
      },
      expect.any(Function)
    )
    expect(splitPane).not.toHaveBeenCalled()
    expect(mocks.recordCreatedTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('in a layout-owner build, splits here when main answers as today', () => {
    const splitPane = vi.fn(() => ({ id: 2 }))
    splitInLayoutOwnerBuild(makeManager(splitPane))

    mocks.splitPaneInMain.mock.calls[0]?.[1]()

    expect(splitPane).toHaveBeenCalledWith(1, 'vertical', { cwd: '/cached' })
  })

  it('in a layout-owner build, splits as today where a paired server owns the layout', () => {
    mocks.layoutOwnerIsMain = true
    mocks.splitPaneInMain.mockReturnValue(false)
    const splitPane = vi.fn(() => ({ id: 2 }))

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager: makeManager(splitPane),
      paneTransports: new Map(),
      paneCwdMap: new Map([[1, { cwd: '/cached', confirmed: true }]]),
      fallbackCwd: '/fallback',
      pane: LAYOUT_OWNER_SOURCE_PANE,
      direction: 'horizontal',
      source: 'keyboard'
    })

    expect(splitPane).toHaveBeenCalledWith(1, 'horizontal', { cwd: '/cached' })
  })

  function splitInLayoutOwnerBuild(manager: PaneManager): void {
    mocks.layoutOwnerIsMain = true
    mocks.splitPaneInMain.mockReturnValue(true)
    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager,
      paneTransports: new Map(),
      paneCwdMap: new Map([[1, { cwd: '/cached', confirmed: true }]]),
      fallbackCwd: '/fallback',
      pane: LAYOUT_OWNER_SOURCE_PANE,
      direction: 'vertical',
      source: 'keyboard'
    })
  }
})
