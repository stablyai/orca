/* oxlint-disable max-lines */
import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { IDisposable } from '@xterm/xterm'
import { isGeminiTerminalTitle, isClaudeAgent } from '@/lib/agent-status'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import type { PtyConnectResult } from './pty-transport'
import { createIpcPtyTransport } from './pty-transport'
import { shouldSeedCacheTimerOnInitialTitle } from './cache-timer-seeding'
import type { PtyConnectionDeps } from './pty-connection-types'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty, bindPanePtyId } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { isPaneReplaying, replayIntoTerminal } from './replay-guard'
import { terminalOutputRequiresDomRenderer } from '@/lib/pane-manager/terminal-complex-script'
import {
  paneLeafId,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_FOCUS_REPORTING_RESET
} from './layout-serialization'
import { warnTerminalLifecycleAnomaly } from './terminal-lifecycle-diagnostics'
import { registerPtySerializer, registerPtyTitleSource } from './pty-buffer-serializer'

const pendingSpawnByPaneKey = new Map<string, Promise<string | null>>()

// Why: when multiple panes/tabs need the same deferred SSH connection,
// the first one calls ssh.connect() and subsequent ones must wait for it
// rather than returning early (which would leave them disconnected). This
// helper either connects or waits for an in-flight connect to finish.
type SshConnectResult = { connected: true } | { connected: false; error: string }

const sshConnectPromises = new Map<string, Promise<SshConnectResult>>()

async function waitForSshConnection(connectionId: string): Promise<SshConnectResult> {
  const state = useAppStore.getState().sshConnectionStates.get(connectionId)
  if (state?.status === 'connected') {
    return { connected: true }
  }

  const existing = sshConnectPromises.get(connectionId)
  if (existing) {
    return existing
  }

  const promise: Promise<SshConnectResult> = (async (): Promise<SshConnectResult> => {
    try {
      await window.api.ssh.connect({ targetId: connectionId })
      return { connected: true }
    } catch (err) {
      console.warn(`Deferred SSH reconnect failed for ${connectionId}:`, err)
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      sshConnectPromises.delete(connectionId)
    }
  })()

  sshConnectPromises.set(connectionId, promise)
  return promise
}

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
  // Why: passphrase-gate waits register a teardown here so dispose() can
  // actively unsubscribe + resolve them. Without this, a pane disposed
  // mid-wait leaks its zustand subscriber and the surrounding async IIFE
  // forever, since the subscriber's `disposed` check only fires when the
  // store next emits — which may never happen after disconnect.
  const waitTeardowns: (() => void)[] = []
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
  const pendingSpawnKey = `${deps.tabId}:${paneLeafId(pane.id)}`

  const onExit = (ptyId: string): void => {
    deps.syncPanePtyLayoutBinding(pane.id, null)
    deps.clearRuntimePaneTitle(deps.tabId, pane.id)
    deps.clearTabPtyId(deps.tabId, ptyId)
    // Why: if the PTY exits abruptly (Ctrl-D, crash, shell termination) without
    // first emitting a non-agent title, the cache timer would persist as stale
    // state. Clear it unconditionally on PTY exit.
    deps.setCacheTimerStartedAt(cacheKey, null)
    // Why: a dead terminal has no running agent — remove its explicit status
    // entry so the hover UI only shows what is running *now*.
    useAppStore.getState().removeAgentStatus(cacheKey)
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
    bindPanePtyId(pane.id, ptyId, deps.tabId)
    pane.container.dataset.ptyId = ptyId
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

  // ─── Agent task-complete: OS notification, not tab attention ──────────
  //
  // The working→idle title transition drives two independent concerns:
  //   1. The Claude prompt-cache countdown in the sidebar.
  //   2. The "Agent Task Complete" OS notification users toggle in Settings.
  //
  // We intentionally do NOT raise tab/worktree unread from here — that
  // remains BEL-only so non-agent long-running tasks stay first-class and
  // so unread state only reflects what the terminal byte stream actually
  // signals. OS notifications are a separate channel: not every agent CLI
  // reliably emits BEL on completion (Gemini, some Codex flows), and
  // without this dispatch the Settings toggle would have zero producers.
  // Double-firing with a concurrent BEL is handled by the 5 s per-worktree
  // dedupe in main/ipc/notifications.ts.
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
    // Why: this is the sole producer of 'agent-task-complete' in the renderer;
    // removing it (as #944 did) leaves the user-facing Settings toggle with no
    // events to fire. Dispatch is gated per-source in main; the main-process
    // dedupe also collapses concurrent BEL + task-complete for the same
    // worktree into a single notification.
    deps.dispatchNotification({ source: 'agent-task-complete', terminalTitle: title })
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
    // Why: the agent process is gone, so its explicit status is no longer meaningful.
    // Remove the entry so the hover UI does not show stale "working" for a dead agent.
    //
    // TODO(#1167): this path only fires on idle→shell title transitions, which
    // means Ctrl+C'd `working` rows (Codex, Gemini, OpenCode — agents with no
    // interrupt hook) linger until the 30-min AGENT_STATUS_STALE_AFTER_MS TTL
    // decays them to idle or the pane/tab is closed. PR #1167 replaces this
    // heuristic with authoritative foreground-process tracking in main so the
    // row drops within 2s of the CLI process exiting. See branch
    // brennanb2025/foreground-process-agent-exit.
    useAppStore.getState().removeAgentStatus(cacheKey)
  }
  // Why: inject ORCA_PANE_KEY so global Claude/Codex hooks can attribute their
  // callbacks to the correct Orca pane without resolving worktrees from cwd.
  // The key matches the `${tabId}:${paneId}` composite used for cacheTimerByKey.
  // ORCA_TAB_ID / ORCA_WORKTREE_ID are exposed separately so the receiver has
  // routing context without having to split paneKey back into its parts.
  const paneEnv = {
    ...paneStartup?.env,
    ORCA_PANE_KEY: cacheKey,
    ORCA_TAB_ID: deps.tabId,
    ORCA_WORKTREE_ID: deps.worktreeId
  }

  // Why: remote repos route PTY spawn through the SSH provider. Resolve the
  // repo's connectionId from the store so the transport passes it to pty:spawn.
  const state = useAppStore.getState()
  const allWorktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  const worktree = allWorktrees.find((w) => w.id === deps.worktreeId)
  const repo = worktree ? state.repos?.find((r) => r.id === worktree.repoId) : null
  const connectionId = repo?.connectionId ?? null
  const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find((t) => t.id === deps.tabId)
  const shellOverride = tab?.shellOverride

  const transport = createIpcPtyTransport({
    cwd: deps.cwd,
    env: paneEnv,
    command: paneStartup?.command,
    connectionId,
    worktreeId: deps.worktreeId,
    // Why: closes the SIGKILL race documented in INVESTIGATION.md by letting
    // main sync-flush the (worktreeId, tabId, leafId → ptyId) binding before
    // pty:spawn returns. Daemon-host-only: SSH path leaves these undefined
    // and the main-side guard short-circuits.
    tabId: deps.tabId,
    leafId: paneLeafId(pane.id),
    ...(shellOverride ? { shellOverride } : {}),
    ...(paneStartup?.telemetry ? { telemetry: paneStartup.telemetry } : {}),
    onPtyExit: onExit,
    onTitleChange,
    onPtySpawn,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    // Why: forward OSC 9999 payloads from the PTY stream to the agent-status slice.
    // Without this, the OSC parser in pty-transport strips sequences from xterm
    // output but the status never reaches the store or dashboard/hover UI.
    onAgentStatus: (payload) => {
      // Why: capture the store snapshot once so the title lookup and the
      // setAgentStatus call observe the same state. Re-reading getState()
      // between the two lines opens a brief window where the title could
      // shift (OSC title update landing in between) and the status would be
      // stored against a title that was never paired with it.
      const currentState = useAppStore.getState()
      const title = currentState.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
      currentState.setAgentStatus(cacheKey, payload, title)
    }
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
    // Why: presence-lock input drop. While mobile is the driver for this
    // PTY, desktop keystrokes must not reach the shell — any input would
    // race the mobile session and is also dimensionally wrong (PTY is at
    // phone fit). Renderer-side guard belongs here so we don't even mark
    // the pane as "interacted" (no unread clear, no take-floor cascade).
    // The pty:write IPC has a defense-in-depth twin. See
    // docs/mobile-presence-lock.md.
    if (currentPtyId && isPtyLocked(currentPtyId)) {
      return
    }
    // Why: a real keystroke into the terminal is the unambiguous "user is
    // here" signal that dismisses the bell (ghostty "show until interact").
    // Guarded by the replay and codex-stale checks above so synthetic xterm
    // auto-replies never count as interaction.
    deps.clearTerminalTabUnread(deps.tabId)
    deps.clearWorktreeUnread(deps.worktreeId)
    transport.sendInput(data)
  })

  const onResizeDisposable = pane.terminal.onResize(({ cols, rows }) => {
    // Why: when a mobile-fit override is active OR mobile is currently the
    // driver of this PTY, the PTY is already at phone dims and any desktop
    // resize is wrong. Suppress resize forwarding to avoid spurious SIGWINCH
    // signals (TUI flicker / wrap corruption). Both checks are needed:
    // - getFitOverrideForPty covers the "phone-fit dims" state.
    // - isPtyLocked covers the broader "mobile driving" state, including
    //   transitions where override may not be set (e.g. legacy code paths).
    // The pty:resize IPC has a defense-in-depth twin. See
    // docs/mobile-presence-lock.md.
    const currentPtyId = transport.getPtyId()
    if (currentPtyId && (getFitOverrideForPty(currentPtyId) || isPtyLocked(currentPtyId))) {
      return
    }
    transport.resize(cols, rows)
  })

  // Why: while a mobile-fit override is active, the onResize listener above
  // and the matching server-side gate both correctly drop pty:resize so the
  // PTY stays parked at phone dims. But the server still needs to learn the
  // real desktop pane geometry — otherwise resolveDesktopRestoreTarget falls
  // back to the PTY's spawn default (e.g. 80×24 for a hidden tab) and Take
  // Back leaves the terminal partially restored. This observer measures the
  // pane container as a side-channel, computes proposed cols/rows the way
  // safeFit would, and reports it via pty:reportGeometry — a measurement-
  // only IPC that updates lastRendererSizes and non-null subscriber
  // baselines without resizing the PTY. We only fire while an override is
  // active because the normal pty:resize path covers all other cases. See
  // docs/mobile-fit-hold.md.
  let pendingGeometryReportRaf: number | null = null
  const reportPaneGeometry = (): void => {
    pendingGeometryReportRaf = null
    const currentPtyId = transport.getPtyId()
    if (!currentPtyId) {
      return
    }
    if (!getFitOverrideForPty(currentPtyId)) {
      return
    }
    let proposed: { cols: number; rows: number } | undefined
    try {
      proposed = pane.fitAddon.proposeDimensions()
    } catch {
      proposed = undefined
    }
    if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) {
      return
    }
    window.api.pty.reportGeometry(currentPtyId, proposed.cols, proposed.rows)
  }
  const geometryReportObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (pendingGeometryReportRaf !== null) {
            return
          }
          pendingGeometryReportRaf = requestAnimationFrame(reportPaneGeometry)
        })
  // Why: pane.xtermContainer is created later in pane-lifecycle's
  // attachWebgl/initial-fit path; pane.container is always present at the
  // moment connectPanePty runs (it's the .pane element). Both report the
  // same layout signal — when the outer pane resizes, the inner xterm
  // container resizes too — so this is the safe element to observe.
  if (geometryReportObserver && pane.container instanceof Element) {
    geometryReportObserver.observe(pane.container)
  }

  // Defer PTY spawn/attach to next frame so FitAddon has time to calculate
  // the correct terminal dimensions from the laid-out container.
  connectFrame = requestAnimationFrame(() => {
    connectFrame = null
    if (disposed) {
      return
    }
    safeFit(pane)
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

    // Why: shared registration so both fresh-spawn and reattach paths install
    // the same SerializeAddon-backed serializer plus the onTitleChange wrapper
    // that drives lastTitle parity for mobile subscribers. Wires the resulting
    // unregister into onDataDisposable.dispose so disposal stays a single
    // teardown point. See docs/mobile-prefer-renderer-scrollback.md.
    const registerPaneSerializerFor = (ptyId: string): void => {
      // Why: StrictMode mounts panes twice; the first mount is disposed
      // before the second runs, but its pty:spawn IPC may have resolved by
      // the time `disposed` flips. Without this guard, the disposed first
      // mount would register against a torn-down xterm and replace the live
      // second-mount registration via owner-token shadowing.
      if (disposed) {
        return
      }
      const unregisterSerializer = registerPtySerializer(ptyId, async (opts) => {
        try {
          // Why: alt-screen TUIs (vim, claude-code) hold transient state in
          // the alternate screen. The hydration path requests
          // altScreenForcesZeroRows so normal-buffer scrollback isn't bled
          // into the seed when the user is mid-TUI; the read-fallback path
          // omits it because it wants the user's currently-visible content.
          const alt = pane.terminal.buffer.active.type === 'alternate'
          const data =
            opts?.altScreenForcesZeroRows && alt
              ? pane.serializeAddon.serialize({ scrollback: 0 })
              : pane.serializeAddon.serialize({ scrollback: opts?.scrollbackRows })
          return {
            data,
            cols: pane.terminal.cols,
            rows: pane.terminal.rows
          }
        } catch {
          return null
        }
      })
      const unregisterTitleSource = registerPtyTitleSource(ptyId, (handler) =>
        pane.terminal.onTitleChange(handler)
      )
      const origOnDataDisposableDispose = onDataDisposable.dispose.bind(onDataDisposable)
      onDataDisposable.dispose = () => {
        unregisterTitleSource()
        unregisterSerializer()
        origOnDataDisposableDispose()
      }
    }

    // Why: for local connections (connectionId === null) the local PTY provider
    // already writes the startup command via writeStartupCommandWhenShellReady,
    // which is shell-ready-aware and reliable. Re-sending it here would cause
    // the command to appear twice in the terminal. For SSH connections the relay
    // has no equivalent mechanism, so the renderer must inject it via sendInput.
    let pendingStartupCommand = connectionId ? (paneStartup?.command ?? null) : null

    const startFreshSpawn = (): void => {
      // Why: pre-signal the main process so its cooperation gate suppresses
      // the daemon-snapshot seed for this paneKey. We issue declare and the
      // spawn back-to-back without awaiting, because Electron's
      // ipcRenderer→ipcMain channel preserves order across consecutive invoke
      // calls from the same renderer. The cooperation gate at pty:spawn time
      // sees pendingByPaneKey populated. Settle/clear later echoes the gen
      // token captured here. See docs/mobile-prefer-renderer-scrollback.md.
      const preSignalPromise = window.api.pty
        .declarePendingPaneSerializer(cacheKey)
        .catch(() => null)

      const spawnedRaw = transport.connect({
        url: '',
        cols,
        rows,
        callbacks: {
          onData: dataCallback,
          onReplayData: replayDataCallback,
          onError: reportError
        }
      })

      const trackedPromise: Promise<string | null> = Promise.resolve(spawnedRaw)
        .then(async (spawnedPtyId) => {
          const resolvedPtyId =
            typeof spawnedPtyId === 'string' ? spawnedPtyId : transport.getPtyId()
          const gen = await preSignalPromise
          if (typeof gen === 'number' && resolvedPtyId) {
            registerPaneSerializerFor(resolvedPtyId)
            void window.api.pty.settlePaneSerializer(cacheKey, gen).catch(() => {})
          } else if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
          }
          return resolvedPtyId
        })
        .catch(async () => {
          const gen = await preSignalPromise
          if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
          }
          return null
        })
        .finally(() => {
          if (pendingSpawnByPaneKey.get(pendingSpawnKey) === trackedPromise) {
            pendingSpawnByPaneKey.delete(pendingSpawnKey)
          }
        })
      // Why: split panes in the same tab can spawn concurrently. Key by pane
      // as well as tab so a remount cannot attach to a sibling setup pane's PTY.
      pendingSpawnByPaneKey.set(pendingSpawnKey, trackedPromise)
    }

    // The replay path uses the guard so xterm auto-replies to embedded query
    // sequences don't leak into the shell. xterm.write() buffers internally
    // regardless of DOM visibility and the guard stays engaged via the
    // write-completion callback until xterm finishes parsing.
    const writeReplayData = (data: string): void => {
      if (terminalOutputRequiresDomRenderer(data)) {
        manager.markPaneHasComplexScriptOutput(pane.id)
      }
      replayIntoTerminal(pane, deps.replayingPanesRef, data)
    }

    const replayDataCallback = (data: string): void => {
      // Relay replay buffer holds the last 100 KB of output, which may
      // overlap with content already rendered in xterm before the
      // disconnect. Clear first to prevent duplication on SSH reconnect.
      writeReplayData('\x1b[2J\x1b[3J\x1b[H')
      writeReplayData(data)
    }

    const dataCallback = (data: string): void => {
      // Always-live writes: PTY output goes straight into xterm regardless
      // of visibility. xterm's internal write queue handles batching, and
      // suspending WebGL while hidden (use-terminal-pane-global-effects)
      // keeps GPU resources from leaking. Visibility-gated buffering used
      // to feed bytes into xterm at stale dimensions on resume, which was
      // the root of the cursor-on-strange-line and broken-wide-char bugs.
      if (terminalOutputRequiresDomRenderer(data)) {
        manager.markPaneHasComplexScriptOutput(pane.id)
      }
      pane.terminal.write(data)

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

    const handleReattachResult = (
      result: PtyConnectResult | string | void,
      staleSessionId?: string | null
    ): void => {
      if (disposed) {
        return
      }
      const connectResult =
        result && typeof result === 'object' && 'id' in result ? (result as PtyConnectResult) : null

      const ptyId =
        connectResult?.id ?? (typeof result === 'string' ? result : transport.getPtyId())
      if (!ptyId) {
        warnTerminalLifecycleAnomaly('restored PTY reattach returned no PTY id', {
          tabId: deps.tabId,
          worktreeId: deps.worktreeId,
          leafId: deps.restoredLeafId ?? paneLeafId(pane.id),
          paneId: pane.id,
          ptyId: staleSessionId ?? null
        })
        // Why: a stale restored daemon/SSH session can fail reattach after the
        // pane is mounted. Do not leave xterm alive without a backing PTY.
        deps.syncPanePtyLayoutBinding(pane.id, null)
        if (staleSessionId) {
          deps.clearTabPtyId(deps.tabId, staleSessionId)
        }
        startFreshSpawn()
        return
      }
      bindPanePtyId(pane.id, ptyId, deps.tabId)
      pane.container.dataset.ptyId = ptyId
      deps.syncPanePtyLayoutBinding(pane.id, ptyId)
      deps.updateTabPtyId(deps.tabId, ptyId)

      // Why: mobile terminal streaming needs the exact screen state from
      // xterm.js. The shared helper installs both the SerializeAddon-backed
      // serializer and the onTitleChange-driven lastTitle source so the
      // main-process hydration path has full status parity.
      registerPaneSerializerFor(ptyId)

      // Strict precedence: snapshot > replay > coldRestore. Paint exactly
      // one source per reattach. Painting snapshot AND replay produced the
      // duplicated TUI output users saw on worktree switch (the relay replay
      // buffer's tail typically overlaps with the daemon snapshot's tail, so
      // both writing into xterm doubles the same lines). Snapshot wins
      // because the daemon's authoritative buffer is freshest when present;
      // replay wins over coldRestore because the relay's last 100 KB is
      // newer than disk-recorded scrollback. If we ever return all three,
      // the daemon and relay are by definition tracking the same session
      // and only the freshest source belongs on screen.
      if (connectResult?.snapshot) {
        writeReplayData('\x1b[2J\x1b[3J\x1b[H')
        writeReplayData(connectResult.snapshot)
        // Snapshot reattach keeps a live session, so avoid the broader mode
        // reset. Focus reporting is the unsafe exception: preserving `?1004h`
        // can make restored shells ring BEL on pane focus/blur.
        writeReplayData(POST_REPLAY_FOCUS_REPORTING_RESET)
        if (connectResult.coldRestore) {
          // Snapshot superseded the cold-restore payload — ack it so the
          // daemon does not redeliver it on the next reattach.
          window.api.pty.ackColdRestore(ptyId)
        }
      } else if (connectResult?.replay) {
        // Relay replay holds the last 100 KB of raw output. The xterm may
        // already hold pre-disconnect content; clear first to avoid
        // duplication. Focus-reporting reset prevents BEL from stale mode
        // bits in the replayed data.
        writeReplayData('\x1b[2J\x1b[3J\x1b[H')
        writeReplayData(connectResult.replay)
        writeReplayData(POST_REPLAY_FOCUS_REPORTING_RESET)
        if (connectResult.coldRestore) {
          window.api.pty.ackColdRestore(ptyId)
        }
      } else if (connectResult?.coldRestore) {
        // restoreScrollbackBuffers() already wrote the saved xterm buffer
        // before this rAF ran. The cold-restore scrollback overlaps with
        // that content; clear first.
        // replayIntoTerminal: the recorded scrollback is raw PTY output that
        // may contain query sequences the previous agent CLI emitted;
        // writing them through xterm.write would trigger auto-replies that
        // land in the new shell's stdin. See replay-guard.ts.
        writeReplayData('\x1b[2J\x1b[3J\x1b[H')
        writeReplayData(connectResult.coldRestore.scrollback)
        writeReplayData('\r\n\x1b[2m--- session restored ---\x1b[0m\r\n\r\n')
        // Cold-restore means the daemon lost the session and spawned a
        // fresh shell — no TUI is consuming the mode-setting bytes that a
        // crashed TUI (e.g. Claude's \e[?1004h) left in the scrollback, so
        // reset them to match the fresh shell's expectations.
        writeReplayData(POST_REPLAY_MODE_RESET)
        window.api.pty.ackColdRestore(ptyId)
      }
      if (connectResult?.sessionExpired) {
        toast.info('Previous SSH session expired.', {
          id: `ssh-session-expired-${deps.tabId}`,
          description: 'Started a new shell.'
        })
      }

      // Why: when a mobile-fit override is active, skip sending desktop dims
      // to the PTY — the PTY is already at phone dimensions and must stay there.
      const reattachPtyId = transport.getPtyId()
      if (!reattachPtyId || !getFitOverrideForPty(reattachPtyId)) {
        transport.resize(cols, rows)
      }
      // Why: POSIX only delivers SIGWINCH when terminal dimensions actually
      // change. Sending it explicitly guarantees restored TUIs repaint at
      // the correct cursor position after snapshot replay.
      window.api.pty.signal(ptyId, 'SIGWINCH')

      scheduleRuntimeGraphSync()
    }

    // Why: if this tab has a deferred SSH session ID, trigger the SSH
    // connection now that the user has focused the tab. We check per-tab
    // (not per-target) because multiple tabs for the same target each need
    // to reattach independently. This must run before session ID resolution
    // because the SSH provider isn't registered until after connect succeeds.
    if (connectionId) {
      const storeState = useAppStore.getState()
      const restoredLeafSessionId =
        deps.restoredLeafId && deps.restoredPtyIdByLeafId
          ? (deps.restoredPtyIdByLeafId[deps.restoredLeafId] ?? null)
          : null
      const pendingSessionId =
        restoredLeafSessionId ?? storeState.deferredSshSessionIdsByTabId[deps.tabId]
      const isDeferredTarget = storeState.deferredSshReconnectTargets.includes(connectionId)
      console.warn(
        `[pty-connection] SSH tab=${deps.tabId} connectionId=${connectionId} pendingSessionId=${pendingSessionId} isDeferredTarget=${isDeferredTarget}`
      )
      if (pendingSessionId || isDeferredTarget) {
        void (async () => {
          // Why: if the target requires a passphrase/password and no credential
          // is cached yet, auto-firing ssh.connect would surprise the user —
          // a prompt pops unprompted just because they focused a tab / jumped
          // via Cmd+J. Wait for the user to initiate the connect (via
          // SshDisconnectedDialog → passphrase dialog) before proceeding with
          // the PTY reattach. No-passphrase targets (ssh-agent, unencrypted
          // key, cached creds) return false here and continue auto-connecting
          // as before.
          let needsPrompt = false
          try {
            needsPrompt = await window.api.ssh.needsPassphrasePrompt({
              targetId: connectionId
            })
          } catch (err) {
            console.warn('[pty-connection] needsPassphrasePrompt probe failed:', err)
            // Why: if the probe fails, fall through to the existing auto-connect
            // behavior rather than stranding the tab — a stuck tab is worse
            // than a surprising prompt.
          }
          if (disposed) {
            return
          }
          if (needsPrompt) {
            const alreadyConnected =
              useAppStore.getState().sshConnectionStates.get(connectionId)?.status === 'connected'
            if (!alreadyConnected) {
              // Wait for the user-driven connect (SshDisconnectedDialog →
              // passphrase dialog → ssh.connect) to complete, then continue.
              // Why: resolve on terminal-failure statuses too ('auth-failed',
              // 'error', 'reconnection-failed') so this promise can't hang
              // forever if the user cancels or the connect fails —
              // waitForSshConnection below has its own error path that will
              // surface the failure via reportError.
              await new Promise<void>((resolve) => {
                // Why: 'disconnected' counts as terminal only after we've
                // observed a non-disconnected status — i.e. the user actually
                // initiated a connect attempt that returned to 'disconnected'
                // (cancel/dismiss). Treating the entry-time 'disconnected'
                // as terminal would skip the gate entirely, defeating the
                // passphrase-prompt deferral.
                let sawNonDisconnected =
                  useAppStore.getState().sshConnectionStates.get(connectionId)?.status !==
                    'disconnected' &&
                  useAppStore.getState().sshConnectionStates.get(connectionId)?.status !== undefined
                const isTerminalStatus = (status: string | undefined): boolean => {
                  if (
                    status === 'connected' ||
                    status === 'auth-failed' ||
                    status === 'error' ||
                    status === 'reconnection-failed'
                  ) {
                    return true
                  }
                  // Why: a return to 'disconnected' after a connect attempt
                  // means the user cancelled or the dialog was dismissed —
                  // resolve so the gate doesn't hang forever.
                  return sawNonDisconnected && status === 'disconnected'
                }
                let settled = false
                const finish = (): void => {
                  if (settled) {
                    return
                  }
                  settled = true
                  unsub()
                  const idx = waitTeardowns.indexOf(finish)
                  if (idx !== -1) {
                    waitTeardowns.splice(idx, 1)
                  }
                  resolve()
                }
                // Why: registering a teardown lets dispose() actively
                // unsubscribe + resolve if the pane is torn down while the
                // wait is in flight. Without this the zustand subscriber and
                // the surrounding async IIFE leak for the rest of the app
                // session because the callback only checks `disposed` when
                // it next fires — and it may never fire again.
                waitTeardowns.push(finish)
                const unsub = useAppStore.subscribe((state) => {
                  if (disposed) {
                    finish()
                    return
                  }
                  const status = state.sshConnectionStates.get(connectionId)?.status
                  if (status && status !== 'disconnected') {
                    sawNonDisconnected = true
                  }
                  if (isTerminalStatus(status)) {
                    finish()
                  }
                })
                // Why: re-read state immediately after subscribing to close the
                // race where status transitioned between the alreadyConnected
                // check above and the subscribe registration — otherwise we'd
                // wait forever for a state change that already happened.
                if (disposed) {
                  finish()
                  return
                }
                const currentStatus = useAppStore
                  .getState()
                  .sshConnectionStates.get(connectionId)?.status
                if (isTerminalStatus(currentStatus)) {
                  finish()
                }
              })
              if (disposed) {
                return
              }
            }
          }

          // Why: ensure the SSH connection is established before attempting
          // PTY reattach. Multiple panes/tabs may need the same connection,
          // so we wait for it rather than returning early when in-flight.
          const connectResult = await waitForSshConnection(connectionId)
          if (!connectResult.connected) {
            reportError(`SSH connection failed: ${connectResult.error}`)
            return
          }
          if (disposed) {
            return
          }
          useAppStore.getState().removeDeferredSshReconnectTarget(connectionId)
          if (disposed) {
            return
          }
          if (pendingSessionId) {
            console.warn(
              `[pty-connection] Attempting reattach for tab=${deps.tabId} sessionId=${pendingSessionId}`
            )
            // Why: the saved remote PTY ID is single-use restore metadata.
            // Clear it before attach/fallback so remounts don't keep retrying
            // an expired session after a fresh shell has been created.
            useAppStore.getState().removeDeferredSshSessionId(deps.tabId)
            // Why: pre-signal also for SSH-deferred reattach so the
            // cooperation gate uniformly applies to remote sessions. Issue
            // declare and connect back-to-back; Electron preserves order. See
            // docs/mobile-prefer-renderer-scrollback.md.
            const preSignalPromise = window.api.pty
              .declarePendingPaneSerializer(cacheKey)
              .catch(() => null)
            const reattachPromise = transport.connect({
              url: '',
              cols,
              rows,
              sessionId: pendingSessionId,
              callbacks: {
                onData: dataCallback,
                onReplayData: replayDataCallback,
                onError: reportError
              }
            })
            void Promise.resolve(reattachPromise)
              .then(async (result) => {
                console.warn(
                  `[pty-connection] Reattach result for tab=${deps.tabId}:`,
                  result
                    ? {
                        sessionExpired: (result as Record<string, unknown>).sessionExpired,
                        replay: !!(result as Record<string, unknown>).replay
                      }
                    : 'undefined'
                )
                handleReattachResult(result, pendingSessionId)
                const gen = await preSignalPromise
                if (typeof gen === 'number') {
                  void window.api.pty.settlePaneSerializer(cacheKey, gen).catch(() => {})
                }
              })
              .catch(async (err) => {
                const gen = await preSignalPromise
                if (typeof gen === 'number') {
                  void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
                }
                console.warn(`[pty-connection] Reattach FAILED for tab=${deps.tabId}:`, err)
                if (disposed) {
                  return
                }
                startFreshSpawn()
              })
          } else {
            startFreshSpawn()
          }
        })()
        return
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
        : detachedLivePtyId
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
    const _diagMsg = `pane=${pane.id} tab=${deps.tabId} restored=${restoredPtyId} existing=${existingPtyId} detached=${detachedLivePtyId} reattach=${deferredReattachSessionId} hasTransport=${hasExistingPaneTransport} pendingKey=${pendingSpawnKey}`
    console.log(`[pty-connect] ${_diagMsg}`)
    ;((globalThis as Record<string, unknown>).__ptyConnectDiag ??= [] as string[]) as string[]
    ;((globalThis as Record<string, unknown>).__ptyConnectDiag as string[]).push(_diagMsg)

    if (deferredReattachSessionId) {
      allowInitialIdleCacheSeed = true
      console.log(`[pty-connect] pane=${pane.id} → REATTACH ${deferredReattachSessionId}`)
      ;((globalThis as Record<string, unknown>).__ptyConnectDiag as string[])?.push(
        `pane=${pane.id} → REATTACH`
      )

      // Why: reattach also pre-signals so the cooperation gate suppresses
      // the daemon seed for this paneKey. Reattach paths register their
      // serializer in handleReattachResult (via registerPaneSerializerFor),
      // mirroring the fresh-spawn path. We issue declare and the reattach
      // connect back-to-back without awaiting; Electron's ipcRenderer→ipcMain
      // channel preserves order. See
      // docs/mobile-prefer-renderer-scrollback.md (Renderer-side prerequisite
      // requirement #4).
      const preSignalPromise = window.api.pty
        .declarePendingPaneSerializer(cacheKey)
        .catch(() => null)

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
        .then(async (result) => {
          handleReattachResult(result, deferredReattachSessionId)
          const gen = await preSignalPromise
          if (typeof gen === 'number') {
            void window.api.pty.settlePaneSerializer(cacheKey, gen).catch(() => {})
          }
        })
        .catch(async (err) => {
          const gen = await preSignalPromise
          if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
          }
          const message = err instanceof Error ? err.message : String(err)
          warnTerminalLifecycleAnomaly('restored PTY reattach threw', {
            tabId: deps.tabId,
            worktreeId: deps.worktreeId,
            leafId: deps.restoredLeafId ?? paneLeafId(pane.id),
            paneId: pane.id,
            ptyId: deferredReattachSessionId,
            reason: message
          })
          reportError(message)
          deps.syncPanePtyLayoutBinding(pane.id, null)
          deps.clearTabPtyId(deps.tabId, deferredReattachSessionId)
          startFreshSpawn()
        })
    } else if (detachedLivePtyId) {
      console.log(`[pty-connect] pane=${pane.id} → ATTACH detached=${detachedLivePtyId}`)
      ;((globalThis as Record<string, unknown>).__ptyConnectDiag as string[])?.push(
        `pane=${pane.id} → ATTACH ${detachedLivePtyId}`
      )
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
        : pendingSpawnByPaneKey.get(pendingSpawnKey)
      if (pendingSpawn) {
        console.log(`[pty-connect] pane=${pane.id} → PENDING SPAWN (waiting on sibling)`)
        ;((globalThis as Record<string, unknown>).__ptyConnectDiag as string[])?.push(
          `pane=${pane.id} → PENDING SPAWN`
        )
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
        console.log(`[pty-connect] pane=${pane.id} → FRESH SPAWN`)
        ;((globalThis as Record<string, unknown>).__ptyConnectDiag as string[])?.push(
          `pane=${pane.id} → FRESH SPAWN`
        )
        startFreshSpawn()
      }
    }
    scheduleRuntimeGraphSync()
  })

  return {
    dispose() {
      disposed = true
      // Why: actively resolve any in-flight passphrase-gate waits so their
      // zustand subscribers + async IIFEs don't hang for the rest of the
      // session when the pane is torn down before SSH state changes.
      while (waitTeardowns.length > 0) {
        const teardown = waitTeardowns.pop()
        teardown?.()
      }
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
      geometryReportObserver?.disconnect()
      if (pendingGeometryReportRaf !== null) {
        cancelAnimationFrame(pendingGeometryReportRaf)
        pendingGeometryReportRaf = null
      }
    }
  }
}
