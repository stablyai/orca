import type { BuiltInWindowsTerminalShell } from '../../../../shared/windows-terminal-shell'
import type { TabCreateMenuOption } from './tab-create-menu-options'

export type TabCreateMenuSelectionHandlers = {
  focusNewTerminal: () => void
  onNewTerminalTab: () => void
  onNewTerminalWithShell?: (shell: string) => void
  resolveShell: (shell: BuiltInWindowsTerminalShell) => string
  onNewBrowserTab: () => void
  onNewFileTab?: () => void
  onOpenFileTab?: () => void
  onNewSimulatorTab?: () => void
  onNewDesktopAppTab?: () => void
}

/** Runs the "+" menu row the user picked. */
export function runTabCreateMenuOption(
  option: TabCreateMenuOption,
  handlers: TabCreateMenuSelectionHandlers
): void {
  switch (option.kind) {
    case 'new-terminal':
      handlers.focusNewTerminal()
      handlers.onNewTerminalTab()
      break
    case 'new-terminal-shell':
      if (!handlers.onNewTerminalWithShell || !option.shell) {
        break
      }
      handlers.focusNewTerminal()
      handlers.onNewTerminalWithShell(handlers.resolveShell(option.shell))
      break
    case 'new-browser':
      handlers.onNewBrowserTab()
      break
    case 'new-markdown':
      handlers.onNewFileTab?.()
      break
    case 'open-markdown':
      handlers.onOpenFileTab?.()
      break
    case 'new-simulator':
    case 'go-to-simulator':
      handlers.onNewSimulatorTab?.()
      break
    case 'new-desktop-app':
      handlers.onNewDesktopAppTab?.()
  }
}
