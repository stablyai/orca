import type { ILinkProvider, Terminal } from '@xterm/xterm'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'

/**
 * Wrap a link provider so a synchronous throw inside `provideLinks` is reported
 * as "no links" instead of escaping to `window.onerror`.
 *
 * Why: xterm's web-links `LinkComputer._getWindowedLineStrings` can raise
 * `RangeError: Invalid array length` while scanning a pathological wrapped line
 * (e.g. agent CLI output with very wide/control-mangled buffers). That throw
 * propagates out of the synchronously-invoked provider and wedges the renderer,
 * which Chromium then kills (`killed` exit 1). Degrading to "no link this hover"
 * keeps the renderer alive; the user can retry by moving the mouse.
 */
export function guardLinkProvider(provider: ILinkProvider, label: string): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      let callbackInvoked = false
      const trackedCallback: typeof callback = (links) => {
        callbackInvoked = true
        callback(links)
      }
      try {
        provider.provideLinks(bufferLineNumber, trackedCallback)
      } catch (error: unknown) {
        recordRendererCrashBreadcrumb('terminal_link_provider_error', {
          provider: label,
          bufferLineNumber,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
        // Why: only resolve the link request if the provider threw before it
        // already delivered links, so we never double-invoke the callback.
        if (!callbackInvoked) {
          callback(undefined)
        }
      }
    }
  }
}

/**
 * Patch `terminal.registerLinkProvider` so every provider registered afterward
 * — including xterm addons' internal providers loaded via `loadAddon` (notably
 * the web-links `LinkComputer`) — is wrapped by {@link guardLinkProvider}.
 * Must run before any `loadAddon`/`registerLinkProvider` call for the terminal.
 */
export function installGuardedLinkProviderRegistration(terminal: Terminal): void {
  // Why: never let the guard itself break pane creation if a Terminal stub or a
  // future xterm build lacks registerLinkProvider.
  if (typeof terminal.registerLinkProvider !== 'function') {
    return
  }
  const register = terminal.registerLinkProvider.bind(terminal)
  let providerCount = 0
  terminal.registerLinkProvider = (provider: ILinkProvider) => {
    providerCount += 1
    return register(guardLinkProvider(provider, `provider-${providerCount}`))
  }
}
