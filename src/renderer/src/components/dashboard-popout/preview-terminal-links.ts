import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { installGuardedLinkProviderRegistration } from '@/lib/pane-manager/terminal-link-provider-guard'
import { isTerminalHttpLinkActivation } from '@/components/terminal-pane/terminal-http-link-activation'
import {
  getTerminalFileOpenHint,
  getTerminalPreviewUrlOpenHint
} from '@/components/terminal-pane/terminal-link-open-hints'
import { fileUriToFilesystemPath } from '../../../../shared/file-uri-path'
import type { PreviewFileLinkActivation } from './preview-terminal-file-links'

export type PreviewTerminalLinkDeps = {
  hover?: (text: string) => void
  leave?: () => void
  /** Same opener the file-path provider uses, for `file://` OSC 8 targets. */
  openFileLink?: (activation: PreviewFileLinkActivation) => void
}

function openUrlInSystemBrowser(terminal: Terminal, uri: string): void {
  void window.api.shell.openUrl(uri).catch(() => undefined)
  terminal.clearSelection()
}

/** An OSC 8 target Orca is willing to act on. Anything else is left alone
 *  rather than handed to the OS. */
function routeOscLinkTarget(text: string): { kind: 'url' } | { kind: 'file'; path: string } | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'url' }
  }
  if (url.protocol === 'file:') {
    const path = fileUriToFilesystemPath(url)
    return path ? { kind: 'file', path } : null
  }
  return null
}

/**
 * Makes links in the preview clickable under the same Mod+click gesture a pane
 * uses. URLs always open in the system browser: Orca's in-app browser routing
 * is workspace-scoped, and the pop-out window hosts no browser pane.
 *
 * Covers both link shapes, because they reach xterm by different routes:
 * plain-text URLs through the web-links addon's regex scan, and OSC 8
 * hyperlinks (what the agent CLIs actually emit) through `options.linkHandler`.
 * Leaving the latter unset is not neutral — xterm's built-in fallback confirms
 * "this link could potentially be dangerous" and then calls `window.open()`,
 * which Electron blocks, so the click dead-ends on a scary dialog.
 */
export function installPreviewTerminalLinks(
  terminal: Terminal,
  deps: PreviewTerminalLinkDeps = {}
): void {
  // Why: a link provider throwing inside provideLinks (xterm's LinkComputer
  // raises RangeError on pathological wrapped lines) escapes to window.onerror
  // and kills the renderer — guard before any provider registers.
  installGuardedLinkProviderRegistration(terminal)
  terminal.loadAddon(
    new WebLinksAddon(
      (event, uri) => {
        if (!isTerminalHttpLinkActivation(event)) {
          return
        }
        event.preventDefault()
        openUrlInSystemBrowser(terminal, uri)
      },
      {
        hover: (_event, uri) => {
          if (uri) {
            deps.hover?.(`${uri} (${getTerminalPreviewUrlOpenHint()})`)
          }
        },
        leave: () => deps.leave?.()
      }
    )
  )

  // Why the guard: `options` is absent on a Terminal stub, and preview setup
  // runs inside an async boot — a throw here strands the whole terminal.
  if (!terminal.options) {
    return
  }
  terminal.options.linkHandler = {
    // Why: `file://` targets are Orca's to route, so the handler must be offered
    // them rather than only http(s).
    allowNonHttpProtocols: true,
    activate: (event, text) => {
      if (!isTerminalHttpLinkActivation(event as MouseEvent | undefined)) {
        return
      }
      const target = routeOscLinkTarget(text)
      if (!target) {
        return
      }
      ;(event as MouseEvent | undefined)?.preventDefault?.()
      if (target.kind === 'url') {
        openUrlInSystemBrowser(terminal, text)
        return
      }
      deps.openFileLink?.({
        path: target.path,
        line: null,
        column: null,
        openWithSystemDefault: (event as MouseEvent | undefined)?.shiftKey === true
      })
      terminal.clearSelection()
    },
    hover: (_event, text) => {
      const hint =
        routeOscLinkTarget(text)?.kind === 'file'
          ? getTerminalFileOpenHint(false)
          : getTerminalPreviewUrlOpenHint()
      deps.hover?.(`${text} (${hint})`)
    },
    leave: () => deps.leave?.()
  }
}
