import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { installGuardedLinkProviderRegistration } from '@/lib/pane-manager/terminal-link-provider-guard'
import { isTerminalHttpLinkActivation } from '@/components/terminal-pane/terminal-http-link-activation'

/**
 * Makes URLs in the preview clickable under the same Mod+click gesture a pane
 * uses. Links always open in the system browser: Orca's in-app browser routing
 * is workspace-scoped, and the pop-out window hosts no browser pane.
 */
export function installPreviewTerminalLinks(terminal: Terminal): void {
  // Why: a link provider throwing inside provideLinks (xterm's LinkComputer
  // raises RangeError on pathological wrapped lines) escapes to window.onerror
  // and kills the renderer — guard before any provider registers.
  installGuardedLinkProviderRegistration(terminal)
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!isTerminalHttpLinkActivation(event)) {
        return
      }
      event.preventDefault()
      void window.api.shell.openUrl(uri).catch(() => undefined)
      terminal.clearSelection()
    })
  )
}
