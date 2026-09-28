import type { IDisposable, Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'

/** Keep Codex selections in xterm so the existing clipboard listener can copy them. */
export function installTerminalCodexCopyOnSelect(terminal: Terminal, paneKey: string): IDisposable {
  const previousRequireAlt = terminal.options.mouseEventsRequireAlt === true
  let enabled = false
  const sync = (): void => {
    const state = useAppStore.getState()
    const foreground = state.paneForegroundAgentByPaneKey[paneKey]
    // Hook-backed panes can skip foreground sampling; restored rows are not live evidence.
    const entry = state.agentStatusByPaneKey[paneKey]
    const agent =
      foreground?.agent ?? (entry?.restoredUnconfirmed === true ? null : entry?.agentType)
    const next =
      state.settings?.terminalClipboardOnSelect === true &&
      agent === 'codex' &&
      !foreground?.shellForeground &&
      !foreground?.routingRevoked
    if (next === enabled) {
      return
    }
    enabled = next
    terminal.options.mouseEventsRequireAlt = enabled || previousRequireAlt
  }
  sync()
  const unsubscribe = useAppStore.subscribe(sync)
  return {
    dispose: () => {
      unsubscribe()
      if (enabled) {
        terminal.options.mouseEventsRequireAlt = previousRequireAlt
      }
    }
  }
}
