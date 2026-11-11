import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { registerRuntimeTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { provideLayoutFrameTerminalPanes } from '@/runtime/workspace-layout/frames/layout-frame-terminal-panes'

import type { PublishedTab } from '../../../../../../shared/workspace-layout/workspace-layout-published'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { awaitsCodexRestartAnswer, blocksCodexPaneInput } from '../../../codex-restart-notice-state'
import '../../pty-transport/delivery/pty-dispatcher'
import { ptyDataHandlers } from '../../pty-transport/shutdown/pty-shutdown-data-suspension'
import { deliverPtyExitToHandlers } from '../../pty-transport/delivery/pty-exit-delivery'
import {
  bufferPreHandlerPtyData,
  clearPreHandlerPtyState,
  drainPreHandlerPtyData,
  hasPreHandlerPtyExit,
  isPreHandlerPtyStateDiscarded
} from '../../pty-transport/delivery/pty-pre-handler-buffer'
import { parkedWatchersByTabId } from '../../parking/output-watchers/terminal-parked-watcher-registry'
import { sweepUnclaimedCodexPaneRestarts } from './codex-detached-pane-restart'
import { resetCodexDetachedPaneRestartExecutorForTests } from './codex-detached-pane-restart-scheduler'

const ACCOUNT_A = 'a@example.com'
const ACCOUNT_B = 'b@example.com'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'wt1@@old'
const NEW_PTY = 'wt1@@new'

/** The panes main's layout frames hold for tab-1; read only with the switch on. */
let mainFramePanes: { leafId: string; ptyId: string }[] = []

function mainFrameTab(): PublishedTab {
  return {
    id: 'tab-1',
    kind: 'terminal',
    entityId: 'tab-1',
    executionHostId: 'local',
    createdAt: 1,
    customTitle: null,
    color: null,
    terminal: {
      root: mainFramePanes[0] ? { type: 'leaf', leafId: mainFramePanes[0].leafId } : null,
      panes: mainFramePanes
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => (resolve = done)), resolve }
}

function seedQueuedRestart(
  opts: { leafId?: string | null; layoutRoot?: 'leaf' | 'none' } = {}
): void {
  const leafId = opts.leafId === undefined ? LEAF_ID : opts.leafId
  useAppStore.setState({
    settings: getDefaultSettings('/home/dev'),
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
  useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'codex')
}

describe('codex detached pane restart executor', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    // Why: switch on, a restart binds only into a pane main's layout holds.
    mainFramePanes = [{ leafId: LEAF_ID, ptyId: OLD_PTY }]
    provideLayoutFrameTerminalPanes({
      holdsTerminalPane: () => false,
      terminalTab: (worktreeId, tabId) =>
        worktreeId === 'wt1' && tabId === 'tab-1' ? mainFrameTab() : undefined
    })
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

  it('adopts the replacement when the replaced PTY exit clears the tab binding mid-spawn', async () => {
    seedQueuedRestart()
    // Main’s replacement exit can clear the old tab binding before spawn replies through background sidecars.
    vi.mocked(window.api.pty.spawn).mockImplementation(async () => {
      useAppStore.getState().clearTabPtyId('tab-1', OLD_PTY)
      return { id: NEW_PTY }
    })

    await sweepUnclaimedCodexPaneRestarts()

    const state = useAppStore.getState()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    expect(state.ptyIdsByTabId['tab-1']).toEqual([NEW_PTY])
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({ [LEAF_ID]: NEW_PTY })
    expect(blocksCodexPaneInput(state.codexRestartNoticeByPtyId[NEW_PTY])).toBe(false)
  })

  it('keeps the replaced PTY exit away from a tab revealed mid-restart', async () => {
    // Earlier restarts in this file tombstone the same id; start from a live PTY's state.
    clearPreHandlerPtyState(OLD_PTY)
    seedQueuedRestart()
    let revealView: { exitReplayed: boolean; sessionAdmitted: boolean } | null = null
    vi.mocked(window.api.pty.spawn).mockImplementation(async () => {
      // Main stops the replaced PTY before replying, labeled as a replacement; no pane owns it yet.
      deliverPtyExitToHandlers({ ptyId: OLD_PTY, code: 0, replacedByRestart: true, sidecars: [] })
      // What a pane revealed now consults before reconnecting under the layout's old id.
      revealView = {
        exitReplayed: hasPreHandlerPtyExit(OLD_PTY),
        sessionAdmitted: !isPreHandlerPtyStateDiscarded(OLD_PTY)
      }
      return { id: NEW_PTY }
    })

    await sweepUnclaimedCodexPaneRestarts()

    expect(revealView).toEqual({ exitReplayed: false, sessionAdmitted: false })
    expect(useAppStore.getState().ptyIdsByTabId['tab-1']).toEqual([NEW_PTY])
  })

  it('rebinds only the codex leaf of a split and keeps the sibling', async () => {
    const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'
    seedQueuedRestart()
    mainFramePanes = [
      { leafId: LEAF_ID, ptyId: OLD_PTY },
      { leafId: SIBLING_LEAF, ptyId: 'wt1@@sibling' }
    ]
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
    // Split-pane safety: only the codex pane's PTY is replaced.
    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ replacesPtyId: OLD_PTY })
    )
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    expect(useAppStore.getState().ptyIdsByTabId['tab-1']).toEqual([NEW_PTY, 'wt1@@sibling'])
  })

  it('keeps the replacement when a pane mounts during the spawn, since main already stopped the old PTY', async () => {
    seedQueuedRestart()
    const pendingSpawn = deferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(pendingSpawn.promise)

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
      await restart

      expect(window.api.pty.kill).not.toHaveBeenCalled()
      const state = useAppStore.getState()
      expect(state.ptyIdsByTabId['tab-1']).toEqual([NEW_PTY])
      expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(NEW_PTY)
      expect(state.pendingPaneAccountRestarts).toEqual({})
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

  it('keeps parked watchers and buffered output for the old PTY when main cannot stop it', async () => {
    clearPreHandlerPtyState(OLD_PTY)
    seedQueuedRestart()
    bufferPreHandlerPtyData(OLD_PTY, 'still running')
    const disposeWatcher = vi.fn()
    parkedWatchersByTabId.set('tab-1', {
      worktreeId: 'wt1',
      tabPtyId: OLD_PTY,
      paneIdByPtyId: new Map([[OLD_PTY, 1]]),
      disposersByPtyId: new Map([[OLD_PTY, disposeWatcher]])
    })
    vi.mocked(window.api.pty.spawn).mockRejectedValue(new Error('daemon unreachable'))

    try {
      await sweepUnclaimedCodexPaneRestarts()

      // No exit was sent, so the still-running Codex keeps every renderer observer it had.
      expect(disposeWatcher).not.toHaveBeenCalled()
      expect(parkedWatchersByTabId.get('tab-1')?.disposersByPtyId.has(OLD_PTY)).toBe(true)
      expect(isPreHandlerPtyStateDiscarded(OLD_PTY)).toBe(false)
      const replayed: string[] = []
      drainPreHandlerPtyData(OLD_PTY, (data) => replayed.push(data))
      expect(replayed).toEqual(['still running'])
      expect(
        awaitsCodexRestartAnswer(useAppStore.getState().codexRestartNoticeByPtyId[OLD_PTY])
      ).toBe(true)
    } finally {
      parkedWatchersByTabId.delete('tab-1')
      clearPreHandlerPtyState(OLD_PTY)
    }
  })

  it('publishes a rootless replacement startup before waiting for old PTY teardown', async () => {
    seedQueuedRestart({ leafId: null })
    const pendingKill = deferred<void>()
    vi.mocked(window.api.pty.kill).mockReturnValue(pendingKill.promise)

    const restart = sweepUnclaimedCodexPaneRestarts()
    await vi.waitFor(() => expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(OLD_PTY))

    expect(useAppStore.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(useAppStore.getState().pendingStartupByTabId['tab-1']).toMatchObject({
      command: "codex '-c' 'disable_paste_burst=true'",
      launchAgent: 'codex'
    })
    expect(useAppStore.getState().suppressedPtyExitIds[OLD_PTY]).toBeUndefined()
    await restart
    pendingKill.resolve()
  })
})
