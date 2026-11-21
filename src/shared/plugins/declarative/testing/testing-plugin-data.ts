import { hostError } from './testing-host-error'

/** What the stand-in Orca holds for the plugin, and the worker handlers it fakes. */
export type MockPluginDataOptions = {
  /** `plugin.request` handlers by name: the answer, or a function of the input (it may throw
   *  `hostError(...)`, which the panel then sees). An unlisted name is `unknown_method`. */
  requests?: Record<string, unknown>
  /** The plugin's storage before the panel runs, by key. */
  storage?: Record<string, unknown>
  /** Its settings, declared defaults included. */
  settings?: Record<string, unknown>
  secrets?: Record<string, string>
}

export type MockPluginDataArea = 'storage' | 'settings' | 'secrets'
export type MockPluginDataSnapshot = Record<MockPluginDataArea, Record<string, unknown>>

const HANDLED = new Set([
  'plugin.request',
  'events.subscribe',
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.keys',
  'settings.get',
  'settings.set',
  'secrets.get',
  'secrets.set',
  'secrets.delete',
  'secrets.protection'
])

function field(params: unknown, name: string): unknown {
  return typeof params === 'object' && params !== null && name in params
    ? Object.getOwnPropertyDescriptor(params, name)?.value
    : undefined
}

/** In-memory storage, settings and secrets, and the plugin's fake worker, behind the host methods
 *  Orca answers for them. Writes tell `onChange` listeners, as Orca tells open panels. */
export function createMockPluginData(options: MockPluginDataOptions) {
  const areas: Record<MockPluginDataArea, Map<string, unknown>> = {
    storage: new Map(Object.entries(options.storage ?? {})),
    settings: new Map(Object.entries(options.settings ?? {})),
    secrets: new Map(Object.entries(options.secrets ?? {}))
  }
  const listeners = new Set<(area: 'storage' | 'settings', key: string) => void>()
  const write = (area: MockPluginDataArea, key: string, value: unknown): { ok: true } => {
    if (value === undefined) {
      areas[area].delete(key)
    } else {
      areas[area].set(key, value)
    }
    if (area !== 'secrets') {
      for (const listener of listeners) {
        listener(area, key)
      }
    }
    return { ok: true }
  }

  // A worker mounted on the same host answers what `requests` does not stub, as Orca's would.
  let worker: ((name: string, input: unknown) => Promise<unknown>) | null = null

  async function request(params: unknown): Promise<{ output: unknown }> {
    const name = String(field(params, 'name'))
    const input = field(params, 'input')
    if (!options.requests || !Object.hasOwn(options.requests, name)) {
      if (worker) {
        return { output: (await worker(name, input)) ?? null }
      }
      throw hostError('unknown_method', `no panel handler named ${name}`)
    }
    const handler: unknown = options.requests[name]
    const output = typeof handler === 'function' ? await handler(input) : handler
    return { output: output ?? null }
  }

  return {
    handles: (method: string): boolean => HANDLED.has(method),
    async answer(method: string, params: unknown): Promise<unknown> {
      const key = String(field(params, 'key'))
      const value = field(params, 'value')
      switch (method) {
        case 'plugin.request':
          return request(params)
        case 'storage.get':
          return { value: areas.storage.get(key) ?? null }
        case 'storage.keys':
          return { keys: [...areas.storage.keys()] }
        case 'settings.get':
          return { settings: Object.fromEntries(areas.settings) }
        case 'secrets.get':
          return { value: areas.secrets.get(key) ?? null }
        case 'secrets.protection':
          return { status: 'os-keyring' }
        case 'storage.set':
          return write('storage', key, value)
        case 'settings.set':
          return write('settings', key, value)
        case 'secrets.set':
          return write('secrets', key, value)
        case 'storage.delete':
          return write('storage', key, undefined)
        case 'secrets.delete':
          return write('secrets', key, undefined)
        default:
          return { ok: true }
      }
    },
    /** Routes unstubbed `plugin.request` calls to a mounted worker; returns the undo. */
    routeRequests(handler: (name: string, input: unknown) => Promise<unknown>): () => void {
      worker = handler
      return () => {
        if (worker === handler) {
          worker = null
        }
      }
    },
    onChange(listener: (area: 'storage' | 'settings', key: string) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: (): MockPluginDataSnapshot => ({
      storage: Object.fromEntries(areas.storage),
      settings: Object.fromEntries(areas.settings),
      secrets: Object.fromEntries(areas.secrets)
    })
  }
}

export type MockPluginData = ReturnType<typeof createMockPluginData>
