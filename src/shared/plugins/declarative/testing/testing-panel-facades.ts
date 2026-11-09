import type { OrcaBridge, OrcaDisposable } from '../runtime/declarative-runtime-types'

type Listener = (payload: unknown) => void

/**
 * The frame shell's `plugin`, `storage`, `settings` and `secrets` for a mounted test panel, over
 * the mock host's calls: what plugin-panel-shell-facades.ts gives a real guest. `post` stands in
 * for the worker's `orca.panels.post`; `changed` for Orca telling the panel a key changed.
 */
export function createTestingPanelFacades(
  call: (method: string, params?: unknown) => Promise<unknown>
) {
  const listeners = new Map<string, Set<Listener>>()
  const listen = (channel: string, handler: Listener): OrcaDisposable => {
    const set = listeners.get(channel) ?? new Set()
    set.add(handler)
    listeners.set(channel, set)
    return { dispose: () => set.delete(handler) }
  }
  const fire = (channel: string, payload: unknown): void => {
    for (const handler of listeners.get(channel) ?? []) {
      handler(payload)
    }
  }
  const pick =
    (name: string) =>
    (result: unknown): unknown =>
      typeof result === 'object' && result !== null && name in result
        ? Object.getOwnPropertyDescriptor(result, name)?.value
        : undefined
  const done = (): void => undefined
  const facades: Required<Pick<OrcaBridge, 'plugin' | 'storage' | 'settings' | 'secrets'>> = {
    plugin: {
      request: (name, input, options) => {
        const timeoutMs =
          typeof options === 'object' && options !== null && 'timeoutMs' in options
            ? options.timeoutMs
            : undefined
        return call('plugin.request', {
          name,
          ...(input === undefined ? {} : { input }),
          ...(typeof timeoutMs === 'number' ? { timeoutMs } : {})
        }).then(pick('output'))
      },
      on: (event, handler) => listen(`message:${event}`, handler)
    },
    storage: {
      get: (key) => call('storage.get', { key }).then((result) => pick('value')(result) ?? null),
      set: (key, value) => call('storage.set', { key, value }).then(done),
      delete: (key) => call('storage.delete', { key }).then(done),
      keys: async () => {
        const keys = pick('keys')(await call('storage.keys'))
        return Array.isArray(keys) ? keys.map(String) : []
      },
      onDidChange: (handler) => listen('changed:storage', (key) => handler({ key: String(key) }))
    },
    settings: {
      get: async (key) => {
        const all = pick('settings')(await call('settings.get'))
        return key === undefined ? all : pick(key)(all)
      },
      set: (key, value) => call('settings.set', { key, value }).then(done),
      onDidChange: (handler) => listen('changed:settings', (key) => handler({ key: String(key) }))
    },
    secrets: {
      get: async (key) => {
        const value = pick('value')(await call('secrets.get', { key }))
        return typeof value === 'string' ? value : null
      },
      set: (key, value) => call('secrets.set', { key, value }).then(done),
      delete: (key) => call('secrets.delete', { key }).then(done)
    }
  }
  return {
    facades,
    post: (event: string, payload: unknown): void => fire(`message:${event}`, payload),
    changed: (area: 'storage' | 'settings', key: string): void => fire(`changed:${area}`, key)
  }
}
