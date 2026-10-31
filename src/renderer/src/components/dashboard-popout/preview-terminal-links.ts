import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { installGuardedLinkProviderRegistration } from '@/lib/pane-manager/terminal-link-provider-guard'
import { isTerminalHttpLinkActivation } from '@/components/terminal-pane/terminal-http-link-activation'
import { TERMINAL_HTTP_URL_REGEX } from '../../../../shared/terminal-http-url-extraction'

/** Use pane-style Mod+click but open externally because pop-outs have no workspace-scoped browser pane. */
export function installPreviewTerminalLinks(terminal: Terminal): void {
  const activate = (event: MouseEvent, uri: string): void => {
    if (!isTerminalHttpLinkActivation(event)) {
      return
    }
    event.preventDefault()
    void window.api.shell.openUrl(uri).catch(() => undefined)
    terminal.clearSelection()
  }
  // Why: the preview has no pane tooltip; the native title still shows the destination before a Mod+click.
  const hover = (_event: MouseEvent, uri: string): void => {
    terminal.element?.setAttribute('title', uri)
  }
  const leave = (): void => {
    terminal.element?.removeAttribute('title')
  }
  // Guard providers before registration; xterm can throw on pathological wrapped lines and escape to window.onerror.
  installGuardedLinkProviderRegistration(terminal)
  terminal.loadAddon(
    new WebLinksAddon(activate, { hover, leave, urlRegex: TERMINAL_HTTP_URL_REGEX })
  )
  // Why: without a linkHandler xterm's OSC 8 default confirm()s and window.open()s, which Electron blocks (#34229).
  terminal.options.linkHandler = { activate, hover, leave }
}
