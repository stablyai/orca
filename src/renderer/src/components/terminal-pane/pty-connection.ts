import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { createIpcPtyTransport } from './pty-transport'

type PtyConnectionDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
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
  const onExit = (ptyId: string): void => {
    deps.clearTabPtyId(deps.tabId, ptyId)
    const panes = manager.getPanes()
    if (panes.length <= 1) {
      deps.onPtyExitRef.current(ptyId)
      return
    }
    manager.closePane(pane.id)
  }

  const onTitleChange = (title: string): void => {
    deps.updateTabTitle(deps.tabId, title)
  }

  const onPtySpawn = (ptyId: string): void => deps.updateTabPtyId(deps.tabId, ptyId)
  const onBell = (): void => deps.markWorktreeUnread(deps.worktreeId)
  const onAgentBecameIdle = (): void => deps.markWorktreeUnread(deps.worktreeId)

  const transport = createIpcPtyTransport({
    cwd: deps.cwd,
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
  })
}
