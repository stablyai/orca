/* oxlint-disable max-lines */
import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { IDisposable } from '@xterm/xterm'
import { isGeminiTerminalTitle, isClaudeAgent } from '@/lib/agent-status'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import type { PtyConnectResult } from './pty-transport'
import { createIpcPtyTransport } from './pty-transport'
import { shouldSeedCacheTimerOnInitialTitle } from './cache-timer-seeding'
import type { PtyConnectionDeps } from './pty-connection-types'
import { isPaneReplaying, replayIntoTerminal } from './replay-guard'
import { POST_REPLAY_MODE_RESET, POST_REPLAY_FOCUS_REPORTING_RESET } from './layout-serialization'

const pendingSpawnByTabId = new Map<string, Promise<string | null>>()

function isCodexPaneStale(args: { tabId: string; panePtyId: string | null }): boolean {
  const state = useAppStore.getState()
  const { codexRestartNoticeByPtyId } = state
  if (args.panePtyId && codexRestartNoticeByPtyId[args.panePtyId]) {
    return true
  }

  const tabs = Object.values(state.tabsByWorktree ?? {}).flat()
  const tab = tabs.find((entry) => entry.id === args.tabId)
  if (tab?.ptyId && codexRestartNoticeByPtyId[tab.ptyId]) {
    return true
  }

  return false
}

// Why: daemon session IDs use the format `${worktreeId}@@${shortUuid}`.
// This validates that a session ID actually belongs to the given worktree,
// preventing cross-workspace contamination during restore.
function isSessionOwnedByWorktree(sessionId: string, worktreeId: string): boolean {
  const separatorIdx = sessionId.lastIndexOf('@@')
  if (separatorIdx === -1) {
    return true
  }
  return sessionId.slice(0, separatorIdx) === worktreeId
}

export function connectPanePty(
  pane: ManagedPane,
  manager: PaneManager,
  deps: PtyConnectionDeps
): IDisposable {
  let disposed = false
  let connectFrame: number | null = null
  let startupInjectTimer: ReturnType<typeof setTimeout> | null = null
  // Why: startup commands must only run once — in the pane they were
  // targeted at. Capture `deps.startup` into a local and clear the field on
  // the (already spread-copied) `deps` so nothing else inside this function
  // can accidentally re-read it. The caller is responsible for clearing its
  // own outer reference, since `deps` here is a shallow copy and our
  // mutation does not propagate back.
  const paneStartup = deps.startup ?? null
  deps.startup = undefined

  // Why: cache timer state is keyed per-pane (not per-tab) so split-pane tabs
  // can track each Claude session independently without overwriting each other.
  const cacheKey = `${deps.tabId}:${pane.id}`

  const onExit = (ptyId: string): void => {
    deps.syncPanePtyLayoutBinding(pane.id, null)
    deps.clearRuntimePaneTitle(deps.tabId, pane.id)
    deps.clearTabPtyId(deps.tabId, ptyId)
    // Why: if the PTY exits abruptly (Ctrl-D, crash, shell termination) without
    // first emitting a non-agent title, the cache timer would persist as stale
    // state. Clear it unconditionally on PTY exit.
    deps.setCacheTimerStartedAt(cacheKey, null)
    // The runtime graph is the CLI's source for live terminal bindings, so
    // we must republish when a pane loses its PTY instead of waiting for a
    // broader layout change that may never happen.
    scheduleRuntimeGraphSync()
    // Why: intentional restarts suppress the PTY exit ahead of time so the
    // pane stays mounted and can reconnect in place. Without consuming the
    // suppression here, split-pane Codex restarts would still close the pane
    // because this handler runs before the tab-level close logic sees the exit.
    if (deps.consumeSuppressedPtyExit(ptyId)) {
      manager.setPaneGpuRendering(pane.id, true)
      return
    }
    manager.setPaneGpuRendering(pane.id, true)
    const panes = manager.getPanes()
    if (panes.length <= 1) {
      deps.onPtyExitRef.current(ptyId)
      return
    }
    manager.closePane(pane.id)
  }

  // Why: on app restart, restored Claude tabs may already be idle when we first
  // see their title. The agent status tracker only fires onBecameIdle for
  // working→idle transitions, so the cache timer would never start for these
  // sessions. We only allow this one-time seed for reattached PTYs; fresh
  // Claude launches also start idle, but they have no prompt cache yet.
  let hasConsideredInitialCacheTimerSeed = false
  let allowInitialIdleCacheSeed = false

  const onTitleChange = (title: string, rawTitle: string): void => {
    manager.setPaneGpuRendering(pane.id, !isGeminiTerminalTitle(rawTitle))
    deps.setRuntimePaneTitle(deps.tabId, pane.id, title)
    // Why: only the focused pane should drive the tab title — otherwise two
    // agents in split panes cause rapid title flickering as each emits OSC
    // sequences. Only the active split's title propagates to the tab. When
    // focus changes, onActivePaneChange syncs the newly active pane's stored
    // title to the tab.
    if (manager.getActivePane()?.id === pane.id) {
      deps.updateTabTitle(deps.tabId, title)
    }

    if (!hasConsideredInitialCacheTimerSeed) {
      hasConsideredInitialCacheTimerSeed = true
      const state = useAppStore.getState()
      if (
        shouldSeedCacheTimerOnInitialTitle({
          rawTitle,
          allowInitialIdleSeed: allowInitialIdleCacheSeed,
          existingTimerStartedAt: state.cacheTimerByKey[cacheKey],
          promptCacheTimerEnabled: state.settings?.promptCacheTimerEnabled ?? null
        })
      ) {
        deps.setCacheTimerStartedAt(cacheKey, Date.now())
      }
    }
  }

  const onPtySpawn = (ptyId: string): void => {
    deps.syncPanePtyLayoutBinding(pane.id, ptyId)
    deps.updateTabPtyId(deps.tabId, ptyId)
    // Spawn completion is when a pane gains a concrete PTY ID. The initial
    // frame-level sync often runs before that async result arrives.
    scheduleRuntimeGraphSync()
  }
  // ─── Attention signal: BEL ────────────────────────────────────────────
  //
  // BEL (0x07) is the attention signal. A BEL raises both the tab-level
  // bell indicator and the worktree-level dot, and fires an OS
  // notification. The unread flag clears when the user activates the tab
  // (see activateTab / focusGroup in the terminals slice) — the bell
  // auto-clears on focus/keystroke.
  //
  // The one case where BEL falsely fires is when a crashed TUI left DEC
  // private mode 1004 (focus event reporting) enabled — pane clicks then
  // emit `\e[I`/`\e[O` into the shell, zsh treats them as unbound keys and
  // rings the bell. This is specific to terminals with cross-restart
  // persistence (as we have); our fix is to reset 1004 and friends after
  // scrollback replay so the mode state matches the fresh shell
  // underneath. See POST_REPLAY_MODE_RESET in layout-serialization.ts.
  const onBell = (): void => {
    // Why: restored Claude Code sessions have been observed to emit a real
    // standalone BEL some time after daemon snapshot reattach, even when Orca
    // did not just forward focus/control input. Treat the BEL as authoritative
    // PTY output here; any product-side suppression should be an explicit UX
    // decision higher up, not a transport-layer guess.
    deps.markWorktreeUnread(deps.worktreeId)
    deps.markTerminalTabUnread(deps.tabId)
    deps.dispatchNotification({ source: 'terminal-bell' })
  }

  // ─── Prompt-cache timer: driven by agent lifecycle, not attention ─────
  //
  // The working→idle title transition is kept purely to drive Claude's
  // prompt-cache countdown in the sidebar. It intentionally does NOT raise
  // attention — that would double-fire with the BEL above, and OSC title
  // transitions are too narrow a signal to be the sole attention source
  // (only agent TUIs emit them; non-agent long-running tasks would never
  // get surfaced).
  const onAgentBecameIdle = (title: string): void => {
    // Why: only start the prompt-cache countdown for Claude agents — other
    // agents have different (or no) prompt-caching semantics and showing a
    // timer for them would be misleading.
    //
    // Why we check `settings !== null` separately: during startup, settings
    // hydrate asynchronously after terminals reconnect. If we treat null
    // as disabled, the first working→idle transition on a restored Claude
    // tab silently drops the timer. Writing a timestamp is cheap and the
    // CacheTimer component gates rendering on the enabled flag, so a
    // spurious write when the feature turns out to be disabled is harmless.
    const settings = useAppStore.getState().settings
    if (isClaudeAgent(title) && (settings === null || settings.promptCacheTimerEnabled)) {
      deps.setCacheTimerStartedAt(cacheKey, Date.now())
    }
  }
  const onAgentBecameWorking = (): void => {
    // Why: a new API call refreshes the prompt-cache TTL, so clear any running
    // countdown. The timer will restart when the agent becomes idle again.
    deps.setCacheTimerStartedAt(cacheKey, null)
  }
  const onAgentExited = (): void => {
    // Why: when the terminal title reverts to a plain shell (e.g., "bash", "zsh"),
    // the agent has exited. Clear any running cache timer so the sidebar doesn't
    // show a stale countdown for a tab that no longer has an active Claude session.
    deps.setCacheTimerStartedAt(cacheKey, null)
  }

  // Why: remote repos route PTY spawn through the SSH provider. Resolve the
  // repo's connectionId from the store so the transport passes it to pty:spawn.
  const state = useAppStore.getState()
  const allWorktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  const worktree = allWorktrees.find((w) => w.id === deps.worktreeId)
  const repo = worktree ? state.repos?.find((r) => r.id === worktree.repoId) : null
  const connectionId = repo?.connectionId ?? null

  const transport = createIpcPtyTransport({
    cwd: deps.cwd,
    env: paneStartup?.env,
    command: paneStartup?.command,
    connectionId,
    worktreeId: deps.worktreeId,
    onPtyExit: onExit,
    onTitleChange,
    onPtySpawn,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited
  })
  const hasExistingPaneTransport = deps.paneTransportsRef.current.size > 0
  deps.paneTransportsRef.current.set(pane.id, transport)

  const onDataDisposable = pane.terminal.onData((data) => {
    // Why: xterm auto-replies to embedded query sequences (DA1, DECRQM,
    // OSC 10/11, focus, CPR) via onData. When we replay recorded PTY bytes
    // into xterm for scrollback/cold-restore/snapshot, those queries would
    // otherwise pipe replies into the freshly spawned shell as stray input
    // ("?1;2c", "2026;2$y", OSC color fragments, ...). The replay sites
    // engage the guard via replayIntoTerminal; here we drop everything
    // xterm emits while the guard is active. See replay-guard.ts.
    if (isPaneReplaying(deps.replayingPanesRef, pane.id)) {
      return
    }
    const currentPtyId = transport.getPtyId()
    // Why: after a Codex account switch, the runtime auth has already moved to
    // the newly selected account. Stale panes must not keep sending input until
    // they restart, or work can execute under the wrong account while the UI
    // still says the pane is stale. Fall back to the tab's persisted PTY ID so
    // the block still holds during reconnect races before the live transport has
    // updated its local PTY binding.
    if (isCodexPaneStale({ tabId: deps.tabId, panePtyId: currentPtyId })) {
      return
    }
    transport.sendInput(data)
  })

  const onResizeDisposable = pane.terminal.onResize(({ cols, rows }) => {
    transport.resize(cols, rows)
  })

  // Defer PTY spawn/attach to next frame so FitAddon has time to calculate
  // the correct terminal dimensions from the laid-out container.
  deps.pendingWritesRef.current.set(pane.id, '')
  connectFrame = requestAnimationFrame(() => {
    connectFrame = null
    if (disposed) {
      return
    }
    try {
      pane.fitAddon.fit()
    } catch {
      /* ignore */
    }
    const cols = pane.terminal.cols
    const rows = pane.terminal.rows

    // Why: if fitAddon resolved to 0×0, the container likely has no layout
    // dimensions (display:none, unmounted, or zero-size parent). Surface a
    // diagnostic so the user sees something instead of a blank pane.
    if (cols === 0 || rows === 0) {
      deps.onPtyErrorRef?.current?.(
        pane.id,
        `Terminal has zero dimensions (${cols}×${rows}). The pane container may not be visible.`
      )
    }

    const reportError = (message: string): void => {
      deps.onPtyErrorRef?.current?.(pane.id, message)
    }

    // Why: 512 KB cap keeps the pending buffer from growing without bound
    // when an agent runs for minutes in a background worktree.  When the
    // cap is reached, the oldest output is trimmed so the most recent
    // terminal state is preserved.  This matches the MAX_BUFFER_BYTES
    // constant used for serialized scrollback capture.
    const MAX_PENDING_BYTES = 512 * 1024

    // Why: for local connections (connectionId === null) the local PTY provider
    // already writes the startup command via writeStartupCommandWhenShellReady,
    // which is shell-ready-aware and reliable. Re-sending it here would cause
    // the command to appear twice in the terminal. For SSH connections the relay
    // has no equivalent mechanism, so the renderer must inject it via sendInput.
    let pendingStartupCommand = connectionId ? (paneStartup?.command ?? null) : null

    const startFreshSpawn = (): void => {
      const spawnPromise = Promise.resolve(
        transport.connect({
          url: '',
          cols,
          rows,
          callbacks: {
            onData: dataCallback,
            onReplayData: replayDataCallback,
            onError: reportError
          }
        })
      )
        .then((spawnedPtyId) =>
          typeof spawnedPtyId === 'string' ? spawnedPtyId : transport.getPtyId()
        )
        .catch(() => null)
        .finally(() => {
          if (pendingSpawnByTabId.get(deps.tabId) === spawnPromise) {
            pendingSpawnByTabId.delete(deps.tabId)
          }
        })
      pendingSpawnByTabId.set(deps.tabId, spawnPromise)
    }

    // Why: replay bytes (eager-buffer flush, attach-time screen clear) must
    // always go through the replay guard so xterm's auto-replies to embedded
    // query sequences don't leak to the shell. Unlike dataCallback we do not
    // honor isVisibleRef — the visibility branch is a perf batching strategy
    // for live output that defers parsing until the worktree is foregrounded,
    // but deferring replay parsing drops the bytes into pendingWritesRef,
    // which later flushes through plain pane.terminal.write (in
    // use-terminal-pane-global-effects) with no guard engaged. xterm's
    // write() buffers internally regardless of DOM visibility, and the guard
    // stays engaged via the write-completion callback until xterm finishes
    // parsing — so writing directly here is both correct and safe.
    const replayDataCallback = (data: string): void => {
      replayIntoTerminal(pane, deps.replayingPanesRef, data)
    }

    const dataCallback = (data: string): void => {
      if (deps.isVisibleRef.current) {
        pane.terminal.write(data)
      } else {
        const pending = deps.pendingWritesRef.current
        let buf = (pending.get(pane.id) ?? '') + data
        if (buf.length > MAX_PENDING_BYTES) {
          // Why: slicing at an arbitrary offset can bisect a multi-byte
          // character or an ANSI escape sequence (e.g. \x1b[38;2;255;0m),
          // producing garbled output when the buffer is later flushed.
          // Snapping forward to the next newline ensures the cut lands on
          // a line boundary where escape state is far less likely to be
          // mid-sequence.
          let cutAt = buf.length - MAX_PENDING_BYTES
          const nl = buf.indexOf('\n', cutAt)
          if (nl !== -1 && nl < cutAt + 256) {
            cutAt = nl + 1
          }
          buf = buf.slice(cutAt)
        }
        pending.set(pane.id, buf)
      }

      if (pendingStartupCommand) {
        if (startupInjectTimer !== null) {
          clearTimeout(startupInjectTimer)
        }
        startupInjectTimer = setTimeout(() => {
          startupInjectTimer = null
          if (!pendingStartupCommand || disposed) {
            return
          }
          transport.sendInput(`${pendingStartupCommand}\r`)
          pendingStartupCommand = null
        }, 50)
      }
    }

    // Why: re-read session IDs inside the rAF instead of capturing before.
    // The session could be cleaned up during the one-frame gap, and
    // reading stale IDs would cause a reattach to a dead session.
    const restoredPtyId =
      deps.restoredLeafId && deps.restoredPtyIdByLeafId
        ? (deps.restoredPtyIdByLeafId[deps.restoredLeafId] ?? null)
        : null
    const storeSnapshot = useAppStore.getState()
    const existingPtyId = storeSnapshot.tabsByWorktree[deps.worktreeId]?.find(
      (t) => t.id === deps.tabId
    )?.ptyId

    const daemonEnabled = storeSnapshot.settings?.experimentalTerminalDaemon === true
    // Why: restored leaf PTYs usually come from a previous app session, so
    // they normally go back through the daemon's createOrAttach RPC to
    // recover snapshot or cold-restore data at the pane's real dimensions.
    // But split remounts in the current app session also carry a leaf binding
    // in the saved layout. When the daemon is off, treating that live local
    // PTY like a daemon session ID incorrectly spawns a fresh shell because
    // LocalPtyProvider ignores sessionId. The reliable distinction is whether
    // the tab still owns that PTY right now: same-session remounts keep the
    // tab-level ptyId populated, while daemon-off cold starts clear it during
    // session hydration.
    const restoredSessionId = restoredPtyId ?? null
    const detachedLivePtyId =
      existingPtyId && !hasExistingPaneTransport
        ? restoredSessionId
          ? restoredSessionId === existingPtyId
            ? restoredSessionId
            : null
          : existingPtyId
        : null
    const candidateReattachSessionId =
      restoredSessionId && restoredSessionId !== detachedLivePtyId
        ? restoredSessionId
        : daemonEnabled
          ? detachedLivePtyId
          : null
    // Why: daemon session IDs encode `${worktreeId}@@${uuid}`. After a daemon
    // crash + cold restore, corrupted or stale session-to-tab mappings can
    // cause a tab in workspace A to hold a ptyId from workspace B. Restoring
    // that session would paint the wrong terminal content in this pane. Drop
    // the reattach and spawn a fresh session instead.
    const deferredReattachSessionId =
      candidateReattachSessionId &&
      isSessionOwnedByWorktree(candidateReattachSessionId, deps.worktreeId)
        ? candidateReattachSessionId
        : null
    if (deferredReattachSessionId) {
      allowInitialIdleCacheSeed = true

      const reattachPromise = transport.connect({
        url: '',
        cols,
        rows,
        sessionId: deferredReattachSessionId,
        callbacks: {
          onData: dataCallback,
          onReplayData: replayDataCallback,
          onError: reportError
        }
      })

      void Promise.resolve(reattachPromise)
        .then((result) => {
          if (disposed) {
            return
          }
          const connectResult =
            result && typeof result === 'object' && 'id' in result
              ? (result as PtyConnectResult)
              : null

          const ptyId =
            connectResult?.id ?? (typeof result === 'string' ? result : transport.getPtyId())
          if (ptyId) {
            deps.syncPanePtyLayoutBinding(pane.id, ptyId)
            deps.updateTabPtyId(deps.tabId, ptyId)
          }

          if (connectResult?.coldRestore) {
            // Why: restoreScrollbackBuffers() already wrote the saved xterm
            // buffer before this rAF ran. The cold-restore scrollback from
            // disk history overlaps with that content. Without clearing first,
            // the terminal shows duplicated output.
            // Why replayIntoTerminal: the recorded scrollback is raw PTY output
            // that may contain query sequences the previous agent CLI emitted;
            // writing them through xterm.write would trigger auto-replies that
            // land in the new shell's stdin. See replay-guard.ts.
            replayIntoTerminal(pane, deps.replayingPanesRef, '\x1b[2J\x1b[3J\x1b[H')
            replayIntoTerminal(pane, deps.replayingPanesRef, connectResult.coldRestore.scrollback)
            replayIntoTerminal(
              pane,
              deps.replayingPanesRef,
              '\r\n\x1b[2m--- session restored ---\x1b[0m\r\n\r\n'
            )
            // Why: the cold-restore scrollback is raw PTY output from the prior
            // session, so mode-setting bytes emitted by a crashed TUI (e.g.
            // Claude's \e[?1004h) come through verbatim and re-enable those modes
            // in xterm. Cold-restore means the daemon lost the session and spawned
            // a fresh shell — there is no TUI consuming these modes anymore, so
            // reset them to match the fresh shell's expectations. Not applied to
            // the snapshot branch below: that branch reattaches to a live daemon
            // session where a running TUI may still depend on these modes.
            replayIntoTerminal(pane, deps.replayingPanesRef, POST_REPLAY_MODE_RESET)
            // Why: ptyId can be null if the transport was torn down during the
            // reattach flight. Only IPC the ack when we have a real ptyId;
            // the replay-into-xterm calls above remain unconditional because
            // they write into the terminal buffer regardless.
            if (ptyId) {
              window.api.pty.ackColdRestore(ptyId)
            }
          } else if (connectResult?.snapshot) {
            // Why: always clear before writing the daemon snapshot to prevent
            // duplication with the scrollback that restoreScrollbackBuffers()
            // wrote earlier. The alt-screen case previously skipped this,
            // leaving stale scrollback in the normal buffer that reappeared
            // when the user exited the TUI (e.g. Claude Code).
            // Why replayIntoTerminal: same rationale as the cold-restore path.
            replayIntoTerminal(pane, deps.replayingPanesRef, '\x1b[2J\x1b[3J\x1b[H')
            replayIntoTerminal(pane, deps.replayingPanesRef, connectResult.snapshot)
            // Why: snapshot restore keeps a live daemon session, so we avoid
            // the broader POST_REPLAY_MODE_RESET bundle here. Focus reporting
            // is the unsafe exception: preserving `?1004h` causes xterm to send
            // `\e[I` / `\e[O` on pane focus/blur, and restored shells can ring
            // BEL when no TUI is actively consuming them. Reset only 1004 so
            // live-session mouse/paste modes stay intact while phantom bells stop.
            replayIntoTerminal(pane, deps.replayingPanesRef, POST_REPLAY_FOCUS_REPORTING_RESET)
          }

          if (ptyId) {
            transport.resize(cols, rows)
            // Why: POSIX only delivers SIGWINCH when terminal dimensions
            // actually change. If the pane dimensions match the daemon
            // session's stored dimensions (common for split panes across
            // restarts), the resize above is a no-op and inline-viewport
            // TUIs (Claude Code/Ink) never redraw. Sending SIGWINCH
            // explicitly guarantees the TUI repaints at the correct cursor
            // position, correcting any snapshot-vs-PTY cursor divergence.
            window.api.pty.signal(ptyId, 'SIGWINCH')
          }

          scheduleRuntimeGraphSync()
        })
        .catch((err) => {
          reportError(err instanceof Error ? err.message : String(err))
        })
    } else if (detachedLivePtyId) {
      allowInitialIdleCacheSeed = false
      // Why: surface synchronous attach failures (e.g., the PTY died between
      // mount and remount, so window.api.pty.resize rejects) through
      // reportError so the pane shows a diagnostic instead of silently
      // leaving a blank surface. The deferred-reattach branch above uses
      // `.catch(reportError)` for the same reason. Commit the pane/tab
      // bindings only after attach returns: if attach throws, the stale
      // ptyId must also be cleared from the tab and a fresh spawn kicked
      // off — otherwise the next remount reads the same dead ptyId from
      // the store and lands in this branch again in a loop.
      try {
        transport.attach({
          existingPtyId: detachedLivePtyId,
          cols,
          rows,
          callbacks: {
            onData: dataCallback,
            onReplayData: replayDataCallback,
            onError: reportError
          }
        })
        deps.syncPanePtyLayoutBinding(pane.id, detachedLivePtyId)
        deps.updateTabPtyId(deps.tabId, detachedLivePtyId)
      } catch (err) {
        reportError(err instanceof Error ? err.message : String(err))
        deps.clearTabPtyId(deps.tabId, detachedLivePtyId)
        startFreshSpawn()
      }
    } else {
      allowInitialIdleCacheSeed = false
      const pendingSpawn = hasExistingPaneTransport
        ? undefined
        : pendingSpawnByTabId.get(deps.tabId)
      if (pendingSpawn) {
        void pendingSpawn
          .then((spawnedPtyId) => {
            if (disposed) {
              return
            }
            if (transport.getPtyId()) {
              return
            }
            if (!spawnedPtyId) {
              // Why: React StrictMode in dev can mount, start a spawn, then
              // immediately unmount/remount the pane. If the first mount never
              // produced a usable PTY ID, the remounted pane must issue its own
              // spawn instead of staying attached to a completed-but-empty
              // promise and rendering a dead terminal surface.
              console.warn(
                `Pending PTY spawn for tab ${deps.tabId} resolved without a PTY id, retrying fresh spawn`
              )
              startFreshSpawn()
              return
            }
            // Why: this attach path reuses a PTY spawned by an earlier mount.
            // Persist the binding here so tab-level PTY ownership stays correct
            // even if no later spawn event or layout snapshot runs.
            deps.syncPanePtyLayoutBinding(pane.id, spawnedPtyId)
            deps.updateTabPtyId(deps.tabId, spawnedPtyId)
            transport.attach({
              existingPtyId: spawnedPtyId,
              cols,
              rows,
              callbacks: {
                onData: dataCallback,
                onReplayData: replayDataCallback,
                onError: reportError
              }
            })
          })
          .catch((err) => {
            reportError(err instanceof Error ? err.message : String(err))
          })
      } else {
        startFreshSpawn()
      }
    }
    scheduleRuntimeGraphSync()
  })

  return {
    dispose() {
      disposed = true
      if (startupInjectTimer !== null) {
        clearTimeout(startupInjectTimer)
        startupInjectTimer = null
      }
      if (connectFrame !== null) {
        // Why: StrictMode and split-group remounts can dispose a pane binding
        // before its deferred PTY attach/spawn work runs. Cancel that queued
        // frame so stale bindings cannot reattach the PTY and steal the live
        // handler wiring from the current pane.
        cancelAnimationFrame(connectFrame)
        connectFrame = null
      }
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
    }
  }
}
