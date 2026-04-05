import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import { isGeminiTerminalTitle } from '@/lib/agent-status'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import type { PtyTransport } from './pty-transport'
import { createIpcPtyTransport } from './pty-transport'

type PtyConnectionDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: { command: string; env?: Record<string, string> } | null
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  pendingWritesRef: React.RefObject<Map<number, string>>
  isActiveRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string) => void>
  clearTabPtyId: (tabId: string, ptyId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  markWorktreeUnread: (worktreeId: string) => void
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

  const onExit = (ptyId: string): void => {
    deps.clearTabPtyId(deps.tabId, ptyId)
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

  const onTitleChange = (title: string, rawTitle: string): void => {
    manager.setPaneGpuRendering(pane.id, !isGeminiTerminalTitle(rawTitle))
    deps.updateTabTitle(deps.tabId, title)
  }

  const onPtySpawn = (ptyId: string): void => {
    deps.updateTabPtyId(deps.tabId, ptyId)
    // Spawn completion is when a pane gains a concrete PTY ID. The initial
    // frame-level sync often runs before that async result arrives.
    scheduleRuntimeGraphSync()
  }
  const onBell = (): void => deps.markWorktreeUnread(deps.worktreeId)
  const onAgentBecameIdle = (): void => deps.markWorktreeUnread(deps.worktreeId)

  const transport = createIpcPtyTransport({
    cwd: deps.cwd,
    env: paneStartup?.env,
    onPtyExit: onExit,
    onTitleChange,
    onPtySpawn,
    onBell,
    onAgentBecameIdle
  })
  deps.paneTransportsRef.current.set(pane.id, transport)

  pane.terminal.onData((data) => {
    transport.sendInput(data)
  })

  pane.terminal.onResize(({ cols, rows }) => {
    transport.resize(cols, rows)
  })

  // Defer PTY spawn to next frame so FitAddon has time to calculate
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
        onData: (data) => {
          if (deps.isActiveRef.current) {
            pane.terminal.write(data)
          } else {
            const pending = deps.pendingWritesRef.current
            pending.set(pane.id, (pending.get(pane.id) ?? '') + data)
          }
        }
      }
    })
    scheduleRuntimeGraphSync()
  })
}
