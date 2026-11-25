import {
  isReservedPluginDeclarativeEvent,
  PLUGIN_DECLARATIVE_CATALOG_VERSION,
  PLUGIN_DECLARATIVE_COMPONENT_PROPS
} from '../plugin-declarative-message-names'
import type { OrcaBridge, OrcaDisposable, OrcaTheme } from './declarative-renderer'

/** The same facade frames get as `window.orca`, typed in orca.d.ts. */
export type OrcaHostCallOptions = { signal?: AbortSignal; timeoutMs?: number }
type SdkSource = { bridge: () => OrcaBridge | null; theme: () => OrcaTheme }

function hostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: code === 'timeout' })
}

function unavailable(what: string): Promise<never> {
  return Promise.reject(hostError('unavailable', `${what} is not available in this Orca`))
}

function isComponentTag(name: string): name is keyof typeof PLUGIN_DECLARATIVE_COMPONENT_PROPS {
  return Object.hasOwn(PLUGIN_DECLARATIVE_COMPONENT_PROPS, name)
}

export function createOrcaSdk(source: SdkSource) {
  const host = Object.freeze({
    call(method: string, params?: unknown, options: OrcaHostCallOptions = {}): Promise<unknown> {
      const bridgeHost = source.bridge()?.host
      if (!bridgeHost) {
        return unavailable('host.call')
      }
      const { signal, timeoutMs } = options
      if (timeoutMs === undefined) {
        return bridgeHost.call(method, params, signal ? { signal } : undefined)
      }
      const controller = new AbortController()
      const forward = (): void => controller.abort()
      if (signal?.aborted) {
        controller.abort()
      }
      signal?.addEventListener('abort', forward, { once: true })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      return bridgeHost
        .call(method, params, { signal: controller.signal })
        .catch((error: unknown) => {
          throw timedOut
            ? hostError('timeout', `${method} took longer than ${timeoutMs} ms`)
            : error
        })
        .finally(() => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', forward)
        })
    },
    has(method: string): boolean {
      return source.bridge()?.host?.has?.(method) === true
    }
  })

  const api = Object.freeze({
    get major(): number {
      return source.bridge()?.api?.major ?? 1
    },
    get minor(): number {
      return source.bridge()?.api?.minor ?? 0
    }
  })

  const env = Object.freeze({
    /** Orca's UI language (BCP-47); the guest's `navigator.language` follows the OS instead. */
    get locale(): string {
      return source.bridge()?.locale ?? 'en'
    },
    /** Reading it while rendering re-renders on light/dark switches. */
    get theme(): OrcaTheme {
      return source.theme()
    },
    client: 'desktop' as const
  })

  // Plain host calls: the hidden guest has no gesture of its own, so the host's press grant is
  // what admits them, and the result is the host API's own (`files.saveAs` included).
  const shell = Object.freeze({
    openExternal(url: string): Promise<unknown> {
      return host.call('shell.openExternal', { url: String(url) })
    }
  })

  const files = Object.freeze({
    saveAs(options: {
      suggestedName?: string
      mimeType?: string
      data?: unknown
    }): Promise<unknown> {
      const { data } = options
      // IPC carries an ArrayBuffer, not a view of one.
      const bytes = ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data
      return host.call('files.saveAs', { ...options, data: bytes })
    }
  })

  function on(event: string, handler: (payload: unknown) => void): OrcaDisposable {
    if (typeof event !== 'string' || isReservedPluginDeclarativeEvent(event)) {
      throw new TypeError(`"${String(event)}" is not an event plugins can subscribe to`)
    }
    return source.bridge()?.on?.(event, handler) ?? { dispose: () => undefined }
  }

  const ui = Object.freeze({
    /** Grows with the component catalog. */
    catalog: PLUGIN_DECLARATIVE_CATALOG_VERSION,
    /** Whether this Orca draws `component`, and accepts `prop` on it when given. */
    has(component: string, prop?: string): boolean {
      if (!isComponentTag(component)) {
        return false
      }
      const props: readonly string[] = PLUGIN_DECLARATIVE_COMPONENT_PROPS[component]
      return prop === undefined || props.includes(prop)
    }
  })

  return { host, api, env, shell, files, on, ui }
}
