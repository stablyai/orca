/** The `orca` object a worker's `activate(orca)` receives; shared so orca/testing hands tests the same one. */
import type { PluginEventName } from '../manifest/plugin-manifest'
import { PLUGIN_V1_EVENT_ALIASES } from '../contributions/plugin-event-contribution'
import { PLUGIN_HOST_API_MINOR, pluginHostMethodsFor } from './plugin-host-api'
import { PLUGIN_HOST_API_MAJOR } from './plugin-host-api-major'
import {
  pluginBridgeNameSchema,
  type PluginDataChanged,
  type PluginPanelCaller,
  type PluginWorkerPanelPost
} from './plugin-panel-bridge-protocol'

export type PluginDisposable = { dispose(): void }

export type PluginPanelRequestHandler = (
  input: unknown,
  context: { panel: PluginPanelCaller; signal: AbortSignal }
) => unknown

type HostCall = (
  method: string,
  params?: unknown,
  options?: { signal?: AbortSignal }
) => Promise<unknown>
type DataListener = (change: { key: string }) => void

/** API surface handed to a plugin's `activate(orca)` export (host API 1). */
export type PluginWorkerOrcaApi = {
  api: { readonly major: number; readonly minor: number }
  commands: {
    register(
      commandId: string,
      handler: (args: unknown, context: { signal: AbortSignal }) => unknown
    ): PluginDisposable
  }
  events: {
    on(
      event: PluginEventName,
      handler: (payload: unknown) => void | Promise<void>
    ): PluginDisposable
  }
  host: {
    call: HostCall
    /** Whether this host implements `method` for workers. */
    has(method: string): boolean
  }
  /** The plugin's own panels and custom editors. */
  panels: {
    handle(name: string, handler: PluginPanelRequestHandler): PluginDisposable
    post(event: string, payload?: unknown, options?: { panel?: string }): void
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
    onDidChange(listener: DataListener): PluginDisposable
  }
  settings: {
    /** Every setting, or one; declared settings read as their default until set. */
    get(key?: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    onDidChange(listener: DataListener): PluginDisposable
  }
  secrets: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  /** Consented capability kinds (informational — the host re-gates). */
  grantedCapabilities: readonly string[]
  log(message: string): void
}

// Why: format 1 handlers read `worktreeId`; newer payloads name it `workspaceId`.
function withV1WorktreeId(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('workspaceId' in payload)) {
    return payload
  }
  return 'worktreeId' in payload ? payload : { ...payload, worktreeId: payload.workspaceId }
}

function field(result: unknown, name: string): unknown {
  return typeof result === 'object' && result !== null && name in result
    ? Object.getOwnPropertyDescriptor(result, name)?.value
    : undefined
}

function addTo<T>(set: Set<T>, entry: T): PluginDisposable {
  set.add(entry)
  return { dispose: () => void set.delete(entry) }
}

const WORKER_METHOD_NAMES: ReadonlySet<string> = new Set(pluginHostMethodsFor('worker'))

/** The tables the runtime dispatches from; this module only fills them. */
export type PluginWorkerApiTables = {
  commands: Map<string, (args: unknown, context: { signal: AbortSignal }) => unknown>
  events: Map<string, Set<(payload: unknown) => void | Promise<void>>>
  panelRequests: Map<string, PluginPanelRequestHandler>
  dataListeners: Record<PluginDataChanged['area'], Set<DataListener>>
}

export function createPluginWorkerApiTables(): PluginWorkerApiTables {
  return {
    commands: new Map(),
    events: new Map(),
    panelRequests: new Map(),
    dataListeners: { storage: new Set(), settings: new Set() }
  }
}

export function createPluginWorkerOrcaApi(input: {
  tables: PluginWorkerApiTables
  hostCall: HostCall
  postToPanels: (post: PluginWorkerPanelPost) => void
  log: (message: string) => void
  grantedCapabilities: readonly string[]
}): PluginWorkerOrcaApi {
  const { tables, hostCall } = input
  const ok = async (method: string, params: unknown): Promise<void> => {
    await hostCall(method, params)
  }
  return Object.freeze({
    api: Object.freeze({ major: PLUGIN_HOST_API_MAJOR, minor: PLUGIN_HOST_API_MINOR }),
    commands: Object.freeze({
      register(
        commandId: string,
        handler: Parameters<PluginWorkerOrcaApi['commands']['register']>[1]
      ) {
        tables.commands.set(commandId, handler)
        return { dispose: () => void tables.commands.delete(commandId) }
      }
    }),
    events: Object.freeze({
      on(event: PluginEventName, handler: (payload: unknown) => void | Promise<void>) {
        // Why: format 1 workers still listen under the old worktree.* names.
        const name = PLUGIN_V1_EVENT_ALIASES.get(event) ?? event
        const handlers = tables.events.get(name) ?? new Set()
        tables.events.set(name, handlers)
        const v1Payload = name !== event || event === 'agent.status.changed'
        const subscription = addTo(handlers, (payload: unknown) =>
          handler(v1Payload ? withV1WorktreeId(payload) : payload)
        )
        if (event !== 'workspace.changed') {
          return subscription
        }
        // Replay on subscribe: the handler starts from the context as it is now.
        let active = true
        void hostCall('workspace.readContext')
          .then((context) => active && handler({ context }))
          .catch(() => undefined)
        return {
          dispose: () => {
            active = false
            subscription.dispose()
          }
        }
      }
    }),
    host: Object.freeze({
      call: (method: string, params?: unknown, options?: { signal?: AbortSignal }) =>
        hostCall(method, params, options),
      has: (method: string) => WORKER_METHOD_NAMES.has(method)
    }),
    panels: Object.freeze({
      handle(name: string, handler: PluginPanelRequestHandler) {
        pluginBridgeNameSchema.parse(name)
        if (typeof handler !== 'function') {
          throw new TypeError('orca.panels.handle needs a handler function')
        }
        tables.panelRequests.set(name, handler)
        return {
          dispose: () => {
            if (tables.panelRequests.get(name) === handler) {
              tables.panelRequests.delete(name)
            }
          }
        }
      },
      post(event: string, payload?: unknown, options?: { panel?: string }) {
        pluginBridgeNameSchema.parse(event)
        input.postToPanels({ event, payload, ...(options?.panel ? { panel: options.panel } : {}) })
      }
    }),
    storage: Object.freeze({
      get: async (key: string) => field(await hostCall('storage.get', { key }), 'value') ?? null,
      set: (key: string, value: unknown) => ok('storage.set', { key, value }),
      delete: (key: string) => ok('storage.delete', { key }),
      keys: async () => {
        const keys = field(await hostCall('storage.keys'), 'keys')
        return Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : []
      },
      onDidChange: (listener: DataListener) => addTo(tables.dataListeners.storage, listener)
    }),
    settings: Object.freeze({
      get: async (key?: string) => {
        const raw = field(await hostCall('settings.get'), 'settings')
        const settings = typeof raw === 'object' && raw !== null ? { ...raw } : {}
        return key === undefined ? settings : field(settings, key)
      },
      set: (key: string, value: unknown) => ok('settings.set', { key, value }),
      onDidChange: (listener: DataListener) => addTo(tables.dataListeners.settings, listener)
    }),
    secrets: Object.freeze({
      get: async (key: string) => {
        const value = field(await hostCall('secrets.get', { key }), 'value')
        return typeof value === 'string' ? value : null
      },
      set: (key: string, value: string) => ok('secrets.set', { key, value }),
      delete: (key: string) => ok('secrets.delete', { key })
    }),
    grantedCapabilities: Object.freeze([...input.grantedCapabilities]),
    log: (message: string) => input.log(String(message))
  })
}
