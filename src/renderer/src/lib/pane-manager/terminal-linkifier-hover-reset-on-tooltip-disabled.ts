import type { IDisposable, Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'
import { resolveTerminalLinkTooltipEnabled } from '../../../../shared/terminal/links/terminal-link-tooltip-settings'
import { resetTerminalLinkifierHoverState } from './terminal-linkifier-hover-reset'

/**
 * Hides a visible preview bar when the setting turns off, instead of leaving it up
 * until the pointer leaves the pane or the window loses focus.
 */
export function installTerminalLinkifierHoverResetOnTooltipDisabled(
  terminal: Terminal,
  linkTooltip: HTMLElement
): IDisposable {
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (resolveTerminalLinkTooltipEnabled(state.settings?.terminalLinkTooltipEnabled)) {
      return
    }
    if (!resolveTerminalLinkTooltipEnabled(previous.settings?.terminalLinkTooltipEnabled)) {
      return
    }
    linkTooltip.style.display = 'none'
    resetTerminalLinkifierHoverState(terminal)
  })
  return { dispose: unsubscribe }
}
