import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  respawnPtyForOmpRpcChatHandback,
  respawnPtyForOmpRpcChatHandbackWithRetry,
  restorePtyBindingsAfterRefusedOmpRpcAcquire
} from './omp-rpc-chat-handback'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'wt1@@old'
const NEW_PTY = 'wt1@@new'

function seedPane(opts: { layoutRoot?: 'leaf' | 'none' } = {}): void {
  useAppStore.setState({
    settings: { activeRuntimeEnvironmentId: null } as never,
    // A hydrated local repo row: the hand-back refuses any pane whose execution
    // host is not provably this client (XLR-011), so the owner ladder has to
    // resolve for the ordinary case too.
    repos: [{ id: 'repo1', path: '/Users/dev/code/orca' }] as never,
    worktreesByRepo: {
      repo1: [{ id: 'wt1', repoId: 'repo1', path: '/Users/dev/code/orca' }]
    } as never,
    tabsByWorktree: {
      wt1: [
        {
          id: 'tab-1',
          ptyId: OLD_PTY,
          worktreeId: 'wt1',
          title: 'omp',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          launchAgent: 'omp' as const
        }
      ]
    } as never,
    ptyIdsByTabId: { 'tab-1': [OLD_PTY] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: opts.layoutRoot === 'none' ? null : { type: 'leaf' as const, leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: OLD_PTY }
      }
    }
  })
}

describe('respawnPtyForOmpRpcChatHandback', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      location: originalWindow?.location ?? { pathname: '/index.html' },
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: NEW_PTY }),
          kill: vi.fn().mockResolvedValue(undefined)
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('spawns a resume command into the same pane and kills the replaced PTY', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ ok: true, ptyId: NEW_PTY })
    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cols: 80,
        rows: 24,
        cwd: '/Users/dev/code/orca',
        launchAgent: 'omp',
        worktreeId: 'wt1',
        tabId: 'tab-1',
        leafId: LEAF_ID,
        command: expect.stringContaining('--resume')
      })
    )
    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command: expect.stringContaining('session-1') })
    )
    expect(useAppStore.getState().ptyIdsByTabId['tab-1']).toContain(NEW_PTY)
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      NEW_PTY
    )
    expect(window.api.pty.kill).toHaveBeenCalledWith(OLD_PTY)
  })

  it('preserves the OMP default arguments and environment during handback', async () => {
    seedPane()
    useAppStore.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        agentDefaultArgs: { omp: '--model enterprise' },
        agentDefaultEnv: { omp: { OMP_PROVIDER_URL: 'https://omp.example.test' } }
      } as never
    })

    await respawnPtyForOmpRpcChatHandback({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command: expect.stringContaining("'--model' 'enterprise'"),
        env: { OMP_PROVIDER_URL: 'https://omp.example.test' }
      })
    )
  })

  // XLR-011: release waits for the turn to settle, so the pane can be
  // reclassified onto another execution host before the hand-back lands. A
  // local `omp` bound into a remote pane crosses the execution-host boundary and
  // can resume an unrelated same-path session.
  it('refuses to spawn locally once the pane belongs to a remote host', async () => {
    seedPane()
    useAppStore.setState({
      worktreesByRepo: {
        repo1: [{ id: 'wt1', repoId: 'repo1', path: '/Users/dev/code/orca', hostId: 'ssh:devbox' }]
      } as never
    })

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result.ok).toBe(false)
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    // The pane keeps whatever it had; nothing was rebound to a local child.
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      OLD_PTY
    )
  })

  // XLR-017 (cross-lab review): the pre-spawn locality gate is not enough —
  // `pty.spawn` is async, and the worktree can hydrate or be reclassified onto
  // an SSH/runtime owner while it is in flight without touching the tab
  // generation or the leaf binding the stale check watches.
  it('refuses to bind a locally spawned child once the host changed during the spawn', async () => {
    seedPane()
    vi.mocked(window.api.pty.spawn).mockImplementation(async () => {
      useAppStore.setState({
        worktreesByRepo: {
          repo1: [
            { id: 'wt1', repoId: 'repo1', path: '/Users/dev/code/orca', hostId: 'ssh:devbox' }
          ]
        } as never
      })
      return { id: NEW_PTY } as never
    })

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({
      ok: false,
      reason: 'execution-host-changed-during-respawn:ssh'
    })
    // The orphan is reaped, the remote-owned pane keeps its own binding, and the
    // PTY the RPC child replaced is never killed on this path.
    expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith(NEW_PTY)
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      OLD_PTY
    )
  })

  it('names the local provider on the spawn instead of defaulting to it', async () => {
    seedPane()

    await respawnPtyForOmpRpcChatHandback({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ connectionId: null })
    )
  })

  it('mints a single-pane layout when the leaf has no established split layout yet', async () => {
    seedPane({ layoutRoot: 'none' })
    const paneKey = makePaneKey('tab-1', LEAF_ID)

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ ok: true, ptyId: NEW_PTY })
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      NEW_PTY
    )
  })

  it('fails closed with invalid-pane-key for a malformed pane key, without spawning', async () => {
    seedPane()

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey: 'not-a-real-pane-key',
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ ok: false, reason: 'invalid-pane-key' })
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
  })

  it('fails closed with tab-not-found when the tab has since closed', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({ tabsByWorktree: {} })

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ ok: false, reason: 'tab-not-found' })
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
  })

  it('reaps the spawned PTY without rebinding when the tab closed mid-spawn', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const { promise, resolve } = Promise.withResolvers<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(promise)

    const pending = respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })
    useAppStore.setState({ tabsByWorktree: {} })
    resolve({ id: NEW_PTY })

    await expect(pending).resolves.toEqual({ ok: false, reason: 'tab-closed-during-respawn' })
    expect(window.api.pty.kill).toHaveBeenCalledWith(NEW_PTY)
  })

  // XLR-002 (cross-lab review): the mounted pane's xterm still holds the
  // transport acquisition tore down, and input forwarding / output filtering
  // both key off the transport's own pty id. Bumping the tab generation is
  // the codebase's remount seam (terminal-pane-recovery.ts); the remounted
  // pane reattaches to the leaf binding written just above.
  it('remounts the tab so the pane reattaches its transport to the replacement PTY', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const generationBefore = useAppStore.getState().tabsByWorktree['wt1']?.[0]?.generation ?? 0

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ ok: true, ptyId: NEW_PTY })
    expect(useAppStore.getState().tabsByWorktree['wt1']?.[0]?.generation).toBe(generationBefore + 1)
  })

  // XLR-003 (cross-lab review): a newer owner rebound the leaf while the
  // spawn was in flight. Overwriting it would redirect the pane away from
  // its live owner and orphan that owner's process.
  it('reaps the spawned PTY when a newer owner rebound the leaf mid-spawn', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const { promise, resolve } = Promise.withResolvers<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(promise)

    const pending = respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })
    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab-1', LEAF_ID, 'wt1@@newer-owner')
    resolve({ id: NEW_PTY })

    await expect(pending).resolves.toEqual({ ok: false, reason: 'leaf-rebound-during-respawn' })
    expect(window.api.pty.kill).toHaveBeenCalledWith(NEW_PTY)
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      'wt1@@newer-owner'
    )
  })

  // XLR-050 (cross-lab review): reaping the spawned PTY after the fact cannot
  // hold the no-overlap single-writer invariant -- by then `omp --resume` was
  // already launched beside a session-owning RPC child. Every hand-back path can
  // arrive with a successor already acquired (main's handback push crosses an
  // async IPC hop; the retry fires 250ms after its caller's ownership read), so
  // the launch itself is gated.
  it('never launches the resume when an RPC owner already holds the pane', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.getState().clearTerminalLayoutPanePtyId('tab-1', LEAF_ID, OLD_PTY)
    useAppStore.getState().setOmpRpcChatPaneStatus(paneKey, 'acquired')

    await expect(
      respawnPtyForOmpRpcChatHandback({
        paneKey,
        replacedPtyId: OLD_PTY,
        cwd: '/Users/dev/code/orca',
        sessionId: 'session-1'
      })
    ).resolves.toEqual({ ok: false, reason: 'rpc-owner-acquired-before-respawn' })

    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })

  it.each(['preparing', 'pending'] as const)(
    'never launches the resume while an RPC ownership attempt is %s',
    async (status) => {
      seedPane()
      const paneKey = makePaneKey('tab-1', LEAF_ID)
      useAppStore.getState().clearTerminalLayoutPanePtyId('tab-1', LEAF_ID, OLD_PTY)
      useAppStore.getState().setOmpRpcChatPaneStatus(paneKey, status)

      await expect(
        respawnPtyForOmpRpcChatHandback({
          paneKey,
          replacedPtyId: OLD_PTY,
          cwd: '/Users/dev/code/orca',
          sessionId: 'session-1'
        })
      ).resolves.toEqual({ ok: false, reason: 'rpc-owner-acquired-before-respawn' })

      expect(window.api.pty.spawn).not.toHaveBeenCalled()
    }
  )

  // The retry is its own launch: the caller's ownership read is 250ms stale by
  // the time it fires, so the gate has to be re-read per attempt.
  it('never launches the retry once an RPC owner acquired the pane', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(new Error('spawn failed'))
    vi.useFakeTimers()
    try {
      const pending = respawnPtyForOmpRpcChatHandbackWithRetry({
        paneKey,
        replacedPtyId: OLD_PTY,
        cwd: '/Users/dev/code/orca',
        sessionId: 'session-1'
      })
      await vi.advanceTimersByTimeAsync(1)
      useAppStore.getState().setOmpRpcChatPaneStatus(paneKey, 'acquired')
      await vi.advanceTimersByTimeAsync(500)
      await pending
    } finally {
      vi.useRealTimers()
    }

    expect(window.api.pty.spawn).toHaveBeenCalledTimes(1)
  })

  // XLR-044 (cross-lab review): a failed acquire's recovery reads RPC ownership
  // only BEFORE it awaits the respawn. A newer generation can acquire inside
  // that window, and an RPC-owned pane leaves its leaf unbound by design — so
  // the leaf-binding and tab-generation checks below both still pass, and the
  // stale run bound `omp --resume` over a live RPC session's pane.
  it('reaps the spawned PTY when a newer RPC owner acquired the pane mid-spawn', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.getState().clearTerminalLayoutPanePtyId('tab-1', LEAF_ID, OLD_PTY)
    const { promise, resolve } = Promise.withResolvers<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(promise)

    const pending = respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })
    useAppStore.getState().setOmpRpcChatPaneStatus(paneKey, 'acquired')
    resolve({ id: NEW_PTY })

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'rpc-owner-acquired-during-respawn'
    })
    expect(window.api.pty.kill).toHaveBeenCalledWith(NEW_PTY)
    expect(window.api.pty.kill).not.toHaveBeenCalledWith(OLD_PTY)
    expect(
      useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]
    ).toBeUndefined()
  })

  it('reaps the spawned PTY when the tab was remounted onto a newer generation mid-spawn', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const { promise, resolve } = Promise.withResolvers<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(promise)

    const pending = respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })
    useAppStore.getState().remountTerminalTabForRecovery('tab-1')
    resolve({ id: NEW_PTY })

    await expect(pending).resolves.toEqual({ ok: false, reason: 'tab-remounted-during-respawn' })
    expect(window.api.pty.kill).toHaveBeenCalledWith(NEW_PTY)
  })

  it('reaps the spawned PTY when the leaf split was closed mid-spawn', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const survivingLeafId = '22222222-2222-4222-8222-222222222222'
    const { promise, resolve } = Promise.withResolvers<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(promise)

    const pending = respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf' as const, leafId: survivingLeafId },
          activeLeafId: survivingLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [survivingLeafId]: 'wt1@@sibling' }
        }
      }
    } as never)
    resolve({ id: NEW_PTY })

    await expect(pending).resolves.toEqual({ ok: false, reason: 'leaf-closed-during-respawn' })
    expect(window.api.pty.kill).toHaveBeenCalledWith(NEW_PTY)
    expect(
      useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]
    ).toBeUndefined()
  })
})

// XLR-006 (cross-lab review): `killPtyBeforeOmpRpcAcquire` arms the exit
// suppression and erases the tab + layout-leaf bindings BEFORE the stop round
// trips, because a suppression armed afterwards loses the race with the exit.
// When the stop is then refused, the PTY is still running and those mutations
// have to be taken back — otherwise the child is undiscoverable after a
// remount and its eventual real exit consumes the stale suppression, skipping
// the pane/tab teardown it was owed.
describe('restorePtyBindingsAfterRefusedOmpRpcAcquire', () => {
  /** Replays exactly what the pre-acquire kill helper mutates. */
  function applyPreKillMutations(): void {
    const store = useAppStore.getState()
    store.suppressPtyExit(OLD_PTY)
    store.clearTabPtyId('tab-1', OLD_PTY)
    store.clearTerminalLayoutPanePtyId('tab-1', LEAF_ID, OLD_PTY)
  }

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    seedPane()
    applyPreKillMutations()
  })

  it('re-binds the tab and layout leaf and disarms the suppression', () => {
    expect(useAppStore.getState().tabsByWorktree['wt1']?.[0]?.ptyId).toBeNull()
    expect(
      useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]
    ).toBeUndefined()

    restorePtyBindingsAfterRefusedOmpRpcAcquire({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      ptyId: OLD_PTY
    })

    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt1']?.[0]?.ptyId).toBe(OLD_PTY)
    expect(state.ptyIdsByTabId['tab-1']).toContain(OLD_PTY)
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(OLD_PTY)
    // Armed suppression disarmed: this PTY's next exit is a real one and owes
    // the pane its normal teardown.
    expect(state.suppressedPtyExitIds[OLD_PTY]).toBeUndefined()
  })

  it('mints a single-pane layout when the leaf never had an established split', () => {
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: null,
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      }
    } as never)

    restorePtyBindingsAfterRefusedOmpRpcAcquire({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      ptyId: OLD_PTY
    })

    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      OLD_PTY
    )
  })

  // No remount: the id is unchanged, so the pane's mounted xterm is still
  // attached to exactly this child. Bumping the generation would tear that
  // live transport down for nothing.
  it('never bumps the tab generation', () => {
    const generationBefore = useAppStore.getState().tabsByWorktree['wt1']?.[0]?.generation ?? 0

    restorePtyBindingsAfterRefusedOmpRpcAcquire({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      ptyId: OLD_PTY
    })

    expect(useAppStore.getState().tabsByWorktree['wt1']?.[0]?.generation ?? 0).toBe(
      generationBefore
    )
  })

  it('never clobbers a leaf a newer owner already bound, but still disarms the suppression', () => {
    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab-1', LEAF_ID, 'wt1@@newer-owner')

    restorePtyBindingsAfterRefusedOmpRpcAcquire({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      ptyId: OLD_PTY
    })

    const state = useAppStore.getState()
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      'wt1@@newer-owner'
    )
    expect(state.ptyIdsByTabId['tab-1'] ?? []).not.toContain(OLD_PTY)
    expect(state.suppressedPtyExitIds[OLD_PTY]).toBeUndefined()
  })

  it('disarms the suppression without throwing when the tab has since closed', () => {
    useAppStore.setState({ tabsByWorktree: {} })

    restorePtyBindingsAfterRefusedOmpRpcAcquire({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      ptyId: OLD_PTY
    })

    expect(useAppStore.getState().suppressedPtyExitIds[OLD_PTY]).toBeUndefined()
  })

  it('leaves every binding alone for a malformed pane key', () => {
    restorePtyBindingsAfterRefusedOmpRpcAcquire({ paneKey: 'not-a-real-pane-key', ptyId: OLD_PTY })

    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt1']?.[0]?.ptyId).toBeNull()
    expect(state.suppressedPtyExitIds[OLD_PTY]).toBe(true)
  })
})

// Moved down from use-omp-rpc-chat-pane-ownership.test.ts with the retry
// wrapper itself: the RPC spawn that just failed and this respawn launch the
// same `omp` binary, so a transient common cause deserves exactly one second
// chance — never a loop, and never a failure discarded unread.
describe('respawnPtyForOmpRpcChatHandbackWithRetry', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    seedPane()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      location: originalWindow?.location ?? { pathname: '/index.html' },
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: NEW_PTY }),
          kill: vi.fn().mockResolvedValue(undefined)
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('retries once when the first respawn attempt throws', async () => {
    vi.mocked(window.api.pty.spawn)
      .mockRejectedValueOnce(new Error('ENOMEM'))
      .mockResolvedValueOnce({ id: NEW_PTY } as never)

    await respawnPtyForOmpRpcChatHandbackWithRetry({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(window.api.pty.spawn).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      NEW_PTY
    )
  })

  it('never attempts a third time once the first attempt succeeds', async () => {
    await respawnPtyForOmpRpcChatHandbackWithRetry({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(window.api.pty.spawn).toHaveBeenCalledTimes(1)
  })

  it('stops after the second failure instead of looping', async () => {
    vi.mocked(window.api.pty.spawn).mockRejectedValue(new Error('ENOMEM'))

    await respawnPtyForOmpRpcChatHandbackWithRetry({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(window.api.pty.spawn).toHaveBeenCalledTimes(2)
  })
})
