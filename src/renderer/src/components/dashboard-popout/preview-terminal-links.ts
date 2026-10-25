import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { installGuardedLinkProviderRegistration } from '@/lib/pane-manager/terminal-link-provider-guard'
import { isTerminalHttpLinkActivation } from '@/components/terminal-pane/terminal-http-link-activation'
import { TERMINAL_HTTP_URL_REGEX } from '@/components/terminal-pane/terminal-http-url-extraction'

/** Use pane-style Mod+click but open externally because pop-outs have no workspace-scoped browser pane. */
export function installPreviewTerminalLinks(terminal: Terminal): void {
  // Guard providers before registration; xterm can throw on pathological wrapped lines and escape to window.onerror.
  installGuardedLinkProviderRegistration(terminal)
  terminal.loadAddon(
    new WebLinksAddon(
      (event, uri) => {
        if (!isTerminalHttpLinkActivation(event)) {
          return
        }
        event.preventDefault()
        void window.api.shell.openUrl(uri).catch(() => undefined)
        terminal.clearSelection()
      },
      { urlRegex: TERMINAL_HTTP_URL_REGEX }
    )
  )
}
