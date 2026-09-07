import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'

/** Resolve keyboard ownership from the focused xterm surface before using manager state. */
export function resolveTerminalKeyboardPane(
  manager: Pick<PaneManager, 'getActivePane' | 'getPanes'>,
  target: EventTarget | null
): ManagedPane | null {
  if (typeof Node !== 'undefined' && target instanceof Node) {
    const focusedPane = manager
      .getPanes()
      .find((pane) => pane.terminal.element?.contains(target) === true)
    if (focusedPane) {
      return focusedPane
    }
  }
  return manager.getActivePane() ?? manager.getPanes()[0] ?? null
}

export function synchronizeTerminalKeyboardPane(
  manager: Pick<PaneManager, 'getActivePane' | 'getPanes' | 'setActivePane'>,
  target: EventTarget | null
): ManagedPane | null {
  const pane = resolveTerminalKeyboardPane(manager, target)
  if (pane && manager.getActivePane()?.id !== pane.id) {
    manager.setActivePane(pane.id, { focus: false })
  }
  return pane
}
