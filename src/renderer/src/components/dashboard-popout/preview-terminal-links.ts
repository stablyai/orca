import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { isTerminalHttpLinkActivation } from '@/components/terminal-pane/terminal-http-link-activation'
import {
  createFilePathLinkProvider,
  getTerminalFileOpenHint,
  installFilePathLinkClickFallback,
  type LinkHandlerDeps
} from '../terminal-pane/terminal-link-handlers'
import { handleOscLink } from '../terminal-pane/terminal-osc-link-routing'
import { handleTerminalHttpLink } from '../terminal-pane/terminal-url-link-hit-testing'
import { createPreviewTerminalLinkContext } from './preview-terminal-link-context'
import type { PreviewTerminalWorkspace } from './agent-terminal-preview-props'
import { parseOsc7 } from '../terminal-pane/parse-osc7'
import { extractUncHost } from '../terminal-pane/terminal-pane-lifecycle-primitives'

/** Each connection owns its links; stale hover callbacks cannot open another card's files. */
export function installPreviewTerminalLinks(
  terminal: Terminal,
  args: {
    container: HTMLElement
    workspace?: PreviewTerminalWorkspace
    isCurrent: () => boolean
  }
): () => void {
  let disposed = false
  const isCurrent = (): boolean => !disposed && args.container.isConnected && args.isCurrent()
  const context = args.workspace
    ? createPreviewTerminalLinkContext(args.workspace, isCurrent)
    : null
  const webLinks = new WebLinksAddon((event, uri) => {
    if (!(context?.isCurrent() ?? isCurrent()) || !isTerminalHttpLinkActivation(event)) {
      return
    }
    event.preventDefault()
    if (context) {
      handleTerminalHttpLink(uri, event, {
        ...context,
        actionDestinations: context.getActionDestinations()
      })
    } else {
      void window.api.shell.openUrl(uri).catch(() => undefined)
    }
    terminal.clearSelection()
  })
  terminal.loadAddon(webLinks)
  if (!context) {
    return () => {
      disposed = true
      webLinks.dispose()
    }
  }

  const tooltip = document.createElement('div')
  tooltip.className = 'pane-link-tooltip xterm-hover'
  tooltip.style.display = 'none'
  args.container.appendChild(tooltip)
  let cwd = context.startupCwd
  const osc7 = terminal.parser.registerOscHandler(7, (data) => {
    if (context.isCurrent()) {
      cwd = parseOsc7(data, { uncHost: extractUncHost(context.startupCwd) }) ?? cwd
    }
    return true
  })
  const deps: LinkHandlerDeps = {
    ...context,
    getPaneLinkCwd: () => cwd,
    managerRef: { current: { getPanes: () => [{ id: 0, terminal }] } },
    linkProviderDisposablesRef: { current: new Map() },
    pathExistsCache: new Map(),
    getLinkActionContext: () => null
  }
  const provider = terminal.registerLinkProvider(
    createFilePathLinkProvider(0, deps, tooltip, getTerminalFileOpenHint(false))
  )
  const fallback = installFilePathLinkClickFallback(0, terminal, deps)
  const previousHandler = terminal.options.linkHandler
  terminal.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, text) => {
      if (!context.isCurrent()) {
        return
      }
      if (
        handleOscLink(text, event, {
          ...context,
          startupCwd: cwd,
          actionDestinations: context.getActionDestinations()
        })
      ) {
        terminal.clearSelection()
      }
    }
  }
  return () => {
    disposed = true
    provider.dispose()
    osc7.dispose()
    fallback.dispose()
    webLinks.dispose()
    terminal.options.linkHandler = previousHandler
    tooltip.remove()
  }
}
