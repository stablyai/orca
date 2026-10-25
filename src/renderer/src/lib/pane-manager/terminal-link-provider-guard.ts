import type { ILinkProvider, Terminal } from '@xterm/xterm'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'

/** Convert synchronous provideLinks errors to no-link results. Pathological wrapped lines can make web-links LinkComputer throw RangeError into window.onerror and kill the renderer; degrading one hover preserves retry on mouse movement. */
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
        // Resolve only if the throwing provider has not delivered already; callbacks must remain single-shot.
        if (!callbackInvoked) {
          callback(undefined)
        }
      }
    }
  }
}

/** Wrap registration before any provider/addon loads, including internal web-links providers, so all pass through guardLinkProvider. */
export function installGuardedLinkProviderRegistration(terminal: Terminal): void {
  // Missing future/stub registerLinkProvider must not prevent pane creation.
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
