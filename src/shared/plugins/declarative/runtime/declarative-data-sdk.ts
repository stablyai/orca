import type { OrcaBridge, OrcaDisposable } from './declarative-runtime-types'

/** `plugin`, `storage`, `settings` and `secrets` from `orca`: the frame shell's facades, typed in
 *  orca.d.ts. Calls before the panel's guest offers them reject with `unavailable`. */

function unavailable(what: string): Promise<never> {
  return Promise.reject(
    Object.assign(new Error(`${what} is not available in this Orca`), {
      code: 'unavailable',
      retryable: false
    })
  )
}

const NOTHING: OrcaDisposable = { dispose: () => undefined }

export function createOrcaDataSdk(bridge: () => OrcaBridge | null) {
  const plugin = Object.freeze({
    request(name: string, input?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }) {
      return bridge()?.plugin?.request(name, input, options) ?? unavailable('plugin.request')
    },
    on(event: string, handler: (payload: unknown) => void): OrcaDisposable {
      return bridge()?.plugin?.on(event, handler) ?? NOTHING
    }
  })
  const storage = Object.freeze({
    get: (key: string) => bridge()?.storage?.get(key) ?? unavailable('storage'),
    set: (key: string, value: unknown) =>
      bridge()?.storage?.set(key, value) ?? unavailable('storage'),
    delete: (key: string) => bridge()?.storage?.delete(key) ?? unavailable('storage'),
    keys: () => bridge()?.storage?.keys() ?? unavailable('storage'),
    onDidChange: (handler: (change: { key: string }) => void): OrcaDisposable =>
      bridge()?.storage?.onDidChange(handler) ?? NOTHING
  })
  const settings = Object.freeze({
    get: (key?: string) => bridge()?.settings?.get(key) ?? unavailable('settings'),
    set: (key: string, value: unknown) =>
      bridge()?.settings?.set(key, value) ?? unavailable('settings'),
    onDidChange: (handler: (change: { key: string }) => void): OrcaDisposable =>
      bridge()?.settings?.onDidChange(handler) ?? NOTHING
  })
  const secrets = Object.freeze({
    get: (key: string) => bridge()?.secrets?.get(key) ?? unavailable('secrets'),
    set: (key: string, value: string) =>
      bridge()?.secrets?.set(key, value) ?? unavailable('secrets'),
    delete: (key: string) => bridge()?.secrets?.delete(key) ?? unavailable('secrets')
  })
  return { plugin, storage, settings, secrets }
}
