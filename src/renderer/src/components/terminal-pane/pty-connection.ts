import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import {
  isGeminiTerminalTitle,
  isClaudeAgent,
  detectAgentStatusFromTitle
} from '@/lib/agent-status'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import type { PtyTransport } from './pty-transport'
import { createIpcPtyTransport, getEagerPtyBufferHandle } from './pty-transport'

type PtyConnectionDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: { command: string; env?: Record<string, string> } | null
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  pendingWritesRef: React.RefObject<Map<number, string>>
  isActiveRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string) => void>
  onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>
  clearTabPtyId: (tabId: string, ptyId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  markWorktreeUnread: (worktreeId: string) => void
  dispatchNotification: (event: {
    source: 'agent-task-complete' | 'terminal-bell'
    terminalTitle?: string
  }) => void
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
}

export function connectPanePty(
  pane: ManagedPane,
  manager: PaneManager,
  deps: PtyConnectionDeps
): void {
  // Why: setup commands must only run once — in the initial pane of the tab.
  // Capture and clear the startup reference synchronously so that panes
  // created later by splits or layout restoration cannot re-execute the
  // setup script, which would be confusing and potentially destructive.
  // Note: this intentionally mutates `deps` so the caller's object no
  // longer carries the startup payload — preventing any later consumer
  // from accidentally replaying it.
  const paneStartup = deps.startup ?? null
  deps.startup = undefined

  // Why: cache timer state is keyed per-pane (not per-tab) so split-pane tabs
  // can track each Claude session independently without overwriting each other.
  const cacheKey = `${deps.tabId}:${pane.id}`

  const onExit = (ptyId: string): void => {
    deps.clearTabPtyId(deps.tabId, ptyId)
    // Why: if the PTY exits abruptly (Ctrl-D, crash, shell termination) without
    // first emitting a non-agent title, the cache timer would persist as stale
    // state. Clear it unconditionally on PTY exit.
    deps.setCacheTimerStartedAt(cacheKey, null)
    // The runtime graph is the CLI's source for live terminal bindings, so
    // we must republish when a pane loses its PTY instead of waiting for a
    // broader layout change that may never happen.
    scheduleRuntimeGraphSync()
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
  // sessions. This one-time flag seeds the timer on the first idle Claude title.
  let hasSeededCacheTimer = false

  const onTitleChange = (title: string, rawTitle: string): void => {
    manager.setPaneGpuRendering(pane.id, !isGeminiTerminalTitle(rawTitle))
    deps.updateTabTitle(deps.tabId, title)

    if (!hasSeededCacheTimer && isClaudeAgent(rawTitle)) {
      hasSeededCacheTimer = true
      const status = detectAgentStatusFromTitle(rawTitle)
      if (status !== null && status !== 'working') {
        const existing = useAppStore.getState().cacheTimerByKey[cacheKey]
        if (existing == null) {
          const settings = useAppStore.getState().settings
          if (settings === null || settings.promptCacheTimerEnabled) {
            deps.setCacheTimerStartedAt(cacheKey, Date.now())
          }
        }
      }
    }
  }

  const onPtySpawn = (ptyId: string): void => {
    deps.updateTabPtyId(deps.tabId, ptyId)
    // Spawn completion is when a pane gains a concrete PTY ID. The initial
    // frame-level sync often runs before that async result arrives.
    scheduleRuntimeGraphSync()
  }
  const onBell = (): void => {
    deps.markWorktreeUnread(deps.worktreeId)
    deps.dispatchNotification({ source: 'terminal-bell' })
  }
  const onAgentBecameIdle = (title: string): void => {
    deps.markWorktreeUnread(deps.worktreeId)
    deps.dispatchNotification({ source: 'agent-task-complete', terminalTitle: title })
    // Why: only start the prompt-cache countdown for Claude agents — other agents
    // have different (or no) prompt-caching semantics and showing a timer for them
    // would be misleading.
    // Why we check `settings !== null` separately: during startup, settings hydrate
    // asynchronously after terminals reconnect. If we treat null as disabled, the
    // first working→idle transition on a restored Claude tab silently drops the
    // timer. Writing a timestamp is cheap and the CacheTimer component already
    // gates rendering on the enabled flag, so a spurious write when the feature
    // turns out to be disabled is harmless.
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

  const transport = createIpcPtyTransport({
    cwd: deps.cwd,
    env: paneStartup?.env,
    onPtyExit: onExit,
    onTitleChange,
    onPtySpawn,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited
  })
  deps.paneTransportsRef.current.set(pane.id, transport)

  pane.terminal.onData((data) => {
    transport.sendInput(data)
  })

  pane.terminal.onResize(({ cols, rows }) => {
    transport.resize(cols, rows)
  })

  // Defer PTY spawn/attach to next frame so FitAddon has time to calculate
  // the correct terminal dimensions from the laid-out container.
  deps.pendingWritesRef.current.set(pane.id, '')
  requestAnimationFrame(() => {
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

    const dataCallback = (data: string): void => {
      if (deps.isActiveRef.current) {
        pane.terminal.write(data)
      } else {
        const pending = deps.pendingWritesRef.current
        pending.set(pane.id, (pending.get(pane.id) ?? '') + data)
      }
    }

    // Why: re-read ptyId inside the rAF instead of capturing it before.
    // The eagerly-spawned PTY could exit during the one-frame gap (e.g.,
    // broken .bashrc), clearing the tab's ptyId. Reading it stale would
    // cause attach() on a dead process, leaving the pane frozen.
    const existingPtyId = useAppStore
      .getState()
      .tabsByWorktree[deps.worktreeId]?.find((t) => t.id === deps.tabId)?.ptyId

    // Why: only attach if the eager buffer handle still exists. For split-pane
    // tabs, replayTerminalLayout calls connectPanePty once per pane. The first
    // pane consumes the handle via attach(); subsequent panes find no handle
    // and fall through to connect(), which spawns their own fresh PTYs. Without
    // this guard, every split pane would try to share the same PTY ID, and the
    // last one's handler would overwrite the earlier ones' in the dispatcher.
    if (existingPtyId && getEagerPtyBufferHandle(existingPtyId)) {
      // Why: this tab had a PTY eagerly spawned by reconnectPersistedTerminals().
      // Attach to it instead of spawning a duplicate. Startup commands are
      // intentionally skipped — the PTY was already spawned with a fresh shell.
      transport.attach({
        existingPtyId,
        cols,
        rows,
        callbacks: {
          onData: dataCallback,
          onError: reportError
        }
      })
    } else {
      transport.connect({
        url: '',
        cols,
        rows,
        callbacks: {
          onConnect: () => {
            if (paneStartup?.command) {
              // Why: setup commands are injected only after the PTY reports a live
              // shell connection. Writing earlier is racy with shell startup files
              // and can drop characters on slower shells.
              transport.sendInput(`${paneStartup.command}\r`)
            }
          },
          onData: dataCallback,
          onError: reportError
        }
      })
    }
    scheduleRuntimeGraphSync()
  })
}
