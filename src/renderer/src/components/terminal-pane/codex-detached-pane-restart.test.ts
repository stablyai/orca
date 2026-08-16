import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { registerRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import { awaitsCodexRestartAnswer, blocksCodexPaneInput } from '../codex-restart-notice-state'
import { ptyDataHandlers } from './pty-dispatcher'
import { sweepUnclaimedCodexPaneRestarts } from './codex-detached-pane-restart'
import {
  hasAddedPendingCodexPaneRestart,
  installCodexDetachedPaneRestartExecutor,
  resetCodexDetachedPaneRestartExecutorForTests
} from './codex-detached-pane-restart-scheduler'

const ACCOUNT_A = 'a@example.com'
const ACCOUNT_B = 'b@example.com'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'wt1@@old'
const NEW_PTY = 'wt1@@new'
const UNLOCATED_PTY = 'wt1@@unlocated'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => (resolve = done)), resolve }
}

function seedQueuedRestart(
  opts: { leafId?: string | null; layoutRoot?: 'leaf' | 'none' } = {}
): void {
  const leafId = opts.leafId === undefined ? LEAF_ID : opts.leafId
  useAppStore.setState({
    settings: { activeRuntimeEnvironmentId: null } as never,
    worktreesByRepo: {
      repo1: [{ id: 'wt1', path: '/Users/dev/code/orca' }]
    } as never,
    tabsByWorktree: {
      wt1: [
        {
          id: 'tab-1',
          ptyId: OLD_PTY,
          worktreeId: 'wt1',
          title: 'codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          launchAgent: 'codex' as const
        }
      ]
    } as never,
    ptyIdsByTabId: { 'tab-1': [OLD_PTY] },
    terminalLayoutsByTabId: leafId
      ? {
          'tab-1': {
            root: opts.layoutRoot === 'none' ? null : { type: 'leaf' as const, leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: OLD_PTY }
          }
        }
      : {}
  })
  useAppStore
    .getState()
    .markCodexRestartNotices([
      { ptyId: OLD_PTY, previousAccountLabel: ACCOUNT_A, nextAccountLabel: ACCOUNT_B }
    ])
  useAppStore.getState().queueCodexPaneRestarts([OLD_PTY])
}

describe('codex detached pane restart executor', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          getSize: vi.fn().mockResolvedValue({ cols: 120, rows: 30 }),
          spawn: vi.fn().mockResolvedValue({ id: NEW_PTY }),
          kill: vi.fn().mockResolvedValue(undefined)
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    ptyDataHandlers.delete(OLD_PTY)
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('kill-and-respawns an accepted restart no mounted transport claims', async () => {
    seedQueuedRestart()

    await sweepUnclaimedCodexPaneRestarts()

    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cols: 80,
        rows: 24,
        cwd: '/Users/dev/code/orca',
        command: 'codex',
        startupCommandDelivery: 'shell-ready',
        launchAgent: 'codex',
        worktreeId: 'wt1',
        tabId: 'tab-1',
        leafId: LEAF_ID,
        initiallyHidden: true
      })
    )
    expect(window.api.pty.getSize).not.toHaveBeenCalled()
    expect(vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0]?.env).toEqual(
      expect.objectContaining({
        ORCA_PANE_KEY: `tab-1:${LEAF_ID}`,
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: 'wt1',
        ORCA_WORKSPACE_ID: 'wt1'
      })
    )
    expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(OLD_PTY)

    const state = useAppStore.getState()
    expect(state.ptyIdsByTabId['tab-1']).toEqual([NEW_PTY])
    expect(state.tabsByWorktree.wt1?.[0]?.ptyId).toBe(NEW_PTY)
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({ [LEAF_ID]: NEW_PTY })
    expect(state.pendingCodexPaneRestartIds).toEqual({})
    expect(state.suppressedPtyExitIds[OLD_PTY]).toBeUndefined()
    // The whole point: the restart completed, so nothing may block input anymore.
    expect(blocksCodexPaneInput(state.codexRestartNoticeByPtyId[OLD_PTY])).toBe(false)
    expect(blocksCodexPaneInput(state.codexRestartNoticeByPtyId[NEW_PTY])).toBe(false)
  })

  it('executes via the store subscription without a lifecycle timeout', async () => {
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      seedQueuedRestart()
      expect(window.api.pty.spawn).not.toHaveBeenCalled()

      await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(OLD_PTY))

      expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
    } finally {
      uninstall()
    }
  })

  it('reference-gates unrelated store writes before scanning pending ids', () => {
    const unchanged = new Proxy<Record<string, true>>(
      {},
      {
        ownKeys: () => {
          throw new Error('pending ids scanned')
        }
      }
    )

    expect(hasAddedPendingCodexPaneRestart(unchanged, unchanged)).toBe(false)
    expect(hasAddedPendingCodexPaneRestart({ [OLD_PTY]: true }, {})).toBe(true)
  })

  it('contains one claim failure so later queued panes still restart', async () => {
    useAppStore
      .getState()
      .markCodexRestartNotices([
        { ptyId: UNLOCATED_PTY, previousAccountLabel: ACCOUNT_A, nextAccountLabel: ACCOUNT_B }
      ])
    useAppStore.getState().queueCodexPaneRestarts([UNLOCATED_PTY])
    seedQueuedRestart()
    const consumePendingCodexPaneRestart = useAppStore.getState().consumePendingCodexPaneRestart
    useAppStore.setState({
      consumePendingCodexPaneRestart: (ptyId) => {
        if (ptyId === UNLOCATED_PTY) {
          throw new Error('corrupt restored claim')
        }
        return consumePendingCodexPaneRestart(ptyId)
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const uninstall = installCodexDetachedPaneRestartExecutor()

    try {
      await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalledTimes(1))

      const state = useAppStore.getState()
      expect(state.pendingCodexPaneRestartIds).toEqual({})
      expect(awaitsCodexRestartAnswer(state.codexRestartNoticeByPtyId[UNLOCATED_PTY])).toBe(true)
      expect(state.ptyIdsByTabId['tab-1']).toEqual([NEW_PTY])
      expect(warn).toHaveBeenCalledWith(
        '[codex-restart] detached pane restart failed:',
        expect.objectContaining({ message: 'corrupt restored claim' })
      )
    } finally {
      uninstall()
      warn.mockRestore()
    }
  })

  it('leaves a PTY owned by a mounted transport to the pane effect', async () => {
    seedQueuedRestart()
    ptyDataHandlers.set(OLD_PTY, () => {})

    await sweepUnclaimedCodexPaneRestarts()

    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ [OLD_PTY]: true })
  })

  it('leaves foreign-machine PTYs queued for their mounted pane path', async () => {
    useAppStore.setState({ pendingCodexPaneRestartIds: { 'remote:term-1': true } })

    await sweepUnclaimedCodexPaneRestarts()

    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ 'remote:term-1': true })
  })

  it('clears the notice when the queued pane no longer exists', async () => {
    useAppStore
      .getState()
      .markCodexRestartNotices([
        { ptyId: 'wt1@@gone', previousAccountLabel: ACCOUNT_A, nextAccountLabel: ACCOUNT_B }
      ])
    useAppStore.getState().queueCodexPaneRestarts(['wt1@@gone'])

    await sweepUnclaimedCodexPaneRestarts()

    const state = useAppStore.getState()
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(state.pendingCodexPaneRestartIds).toEqual({})
    expect(blocksCodexPaneInput(state.codexRestartNoticeByPtyId['wt1@@gone'])).toBe(false)
  })

  it('rebuilds a rootless single-pane layout so the mount replays this leaf', async () => {
    // Regression guard: replayTerminalLayout mints a fresh leaf when the root
    // doesn't name this one, silently orphaning the respawned PTY on reveal.
    seedQueuedRestart({ layoutRoot: 'none' })

    await sweepUnclaimedCodexPaneRestarts()

    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']).toEqual(
      expect.objectContaining({
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        ptyIdsByLeafId: { [LEAF_ID]: NEW_PTY }
      })
    )
    expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(OLD_PTY)
  })

  it('rebinds only the codex leaf of a split and keeps the sibling', async () => {
    const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'
    seedQueuedRestart()
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': [OLD_PTY, 'wt1@@sibling'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF_ID },
            second: { type: 'leaf', leafId: SIBLING_LEAF }
          },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: OLD_PTY, [SIBLING_LEAF]: 'wt1@@sibling' }
        }
      }
    })

    await sweepUnclaimedCodexPaneRestarts()

    const layout = useAppStore.getState().terminalLayoutsByTabId['tab-1']
    expect(layout?.root?.type).toBe('split')
    expect(layout?.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: NEW_PTY,
      [SIBLING_LEAF]: 'wt1@@sibling'
    })
    // Split-pane safety: only the codex pane's PTY dies.
    expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(OLD_PTY)
    expect(useAppStore.getState().ptyIdsByTabId['tab-1']).toEqual([NEW_PTY, 'wt1@@sibling'])
  })

  it('leaves a tab with a mounted TerminalPane to its own restart effect', async () => {
    seedQueuedRestart()
    const unregister = registerRuntimeTerminalTab({
      tabId: 'tab-1',
      worktreeId: 'wt1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    try {
      await sweepUnclaimedCodexPaneRestarts()

      expect(window.api.pty.spawn).not.toHaveBeenCalled()
      expect(window.api.pty.kill).not.toHaveBeenCalled()
      expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ [OLD_PTY]: true })
    } finally {
      unregister()
    }
  })

  it('reaps a detached spawn and requeues when a pane mounts during the spawn', async () => {
    seedQueuedRestart()
    const pendingSpawn = deferred<{ id: string }>()
    const pendingKill = deferred<void>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(pendingSpawn.promise)
    vi.mocked(window.api.pty.kill).mockReturnValue(pendingKill.promise)

    const restart = sweepUnclaimedCodexPaneRestarts()
    await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalledTimes(1))
    const unregister = registerRuntimeTerminalTab({
      tabId: 'tab-1',
      worktreeId: 'wt1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => OLD_PTY,
      getTabWideAgentHintLeafId: () => null
    })
    try {
      pendingSpawn.resolve({ id: NEW_PTY })
      await vi.waitFor(() => expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(NEW_PTY))

      expect(useAppStore.getState().ptyIdsByTabId['tab-1']).toEqual([OLD_PTY])
      expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ [OLD_PTY]: true })
      await restart
      pendingKill.resolve()
    } finally {
      unregister()
    }
  })

  it('rejects a detached spawn after the tab generation and leaf owner change', async () => {
    seedQueuedRestart()
    const pendingSpawn = deferred<{ id: string }>()
    const pendingKill = deferred<void>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(pendingSpawn.promise)
    vi.mocked(window.api.pty.kill).mockReturnValue(pendingKill.promise)

    const restart = sweepUnclaimedCodexPaneRestarts()
    await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalledTimes(1))
    const state = useAppStore.getState()
    const notice = state.codexRestartNoticeByPtyId[OLD_PTY]
    useAppStore.setState({
      tabsByWorktree: {
        wt1: [{ ...state.tabsByWorktree.wt1![0]!, generation: 1, ptyId: 'wt1@@successor' }]
      },
      ptyIdsByTabId: { 'tab-1': ['wt1@@successor'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...state.terminalLayoutsByTabId['tab-1']!,
          ptyIdsByLeafId: { [LEAF_ID]: 'wt1@@successor' }
        }
      },
      codexRestartNoticeByPtyId: { 'wt1@@successor': notice! }
    })

    pendingSpawn.resolve({ id: NEW_PTY })
    await vi.waitFor(() => expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(NEW_PTY))

    const after = useAppStore.getState()
    expect(after.ptyIdsByTabId['tab-1']).toEqual(['wt1@@successor'])
    expect(after.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe('wt1@@successor')
    expect(awaitsCodexRestartAnswer(after.codexRestartNoticeByPtyId['wt1@@successor'])).toBe(true)
    await restart
    pendingKill.resolve()
  })

  it('leaves a sleep-retained pending id alone so wake can migrate it', async () => {
    // Why: hibernation unbinds a pane's PTY but keeps its pending restart, and
    // wake moves that entry onto the respawned PTY. No notice means nothing is
    // blocked, so consuming here would silently lose the accepted restart.
    useAppStore.setState({ pendingCodexPaneRestartIds: { 'wt1@@sleeping': true } })

    await sweepUnclaimedCodexPaneRestarts()

    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ 'wt1@@sleeping': true })
  })

  it('re-offers the prompt instead of leaving a silent block when the respawn fails', async () => {
    seedQueuedRestart()
    vi.mocked(window.api.pty.spawn).mockRejectedValue(new Error('managed auth unavailable'))

    await sweepUnclaimedCodexPaneRestarts()

    const state = useAppStore.getState()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    expect(state.ptyIdsByTabId['tab-1']).toEqual([OLD_PTY])
    expect(state.pendingCodexPaneRestartIds).toEqual({})
    // The question is back on screen; input stays blocked but never silently.
    expect(awaitsCodexRestartAnswer(state.codexRestartNoticeByPtyId[OLD_PTY])).toBe(true)
  })

  it('kills now and defers the Codex respawn to mount when the layout leaf is unknown', async () => {
    seedQueuedRestart({ leafId: null })

    await sweepUnclaimedCodexPaneRestarts()

    const state = useAppStore.getState()
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(OLD_PTY)
    expect(state.ptyIdsByTabId['tab-1']).toEqual([])
    expect(state.pendingStartupByTabId['tab-1']).toEqual(
      expect.objectContaining({
        command: 'codex',
        startupCommandDelivery: 'shell-ready',
        launchAgent: 'codex'
      })
    )
    expect(blocksCodexPaneInput(state.codexRestartNoticeByPtyId[OLD_PTY])).toBe(false)
  })

  it('publishes a rootless replacement startup before waiting for old PTY teardown', async () => {
    seedQueuedRestart({ leafId: null })
    const pendingKill = deferred<void>()
    vi.mocked(window.api.pty.kill).mockReturnValue(pendingKill.promise)

    const restart = sweepUnclaimedCodexPaneRestarts()
    await vi.waitFor(() => expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(OLD_PTY))

    expect(useAppStore.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(useAppStore.getState().pendingStartupByTabId['tab-1']).toMatchObject({
      command: 'codex',
      launchAgent: 'codex'
    })
    expect(useAppStore.getState().suppressedPtyExitIds[OLD_PTY]).toBeUndefined()
    await restart
    pendingKill.resolve()
  })
})
