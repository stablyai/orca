import { PLUGIN_V1_EVENT_ALIASES } from '../../contributions/plugin-event-contribution'
import { PLUGIN_EVENT_PAYLOAD_SCHEMAS } from '../../events/plugin-events'
import type { PluginWorkerPanelPost } from '../../workers/plugin-panel-bridge-protocol'
import {
  createPluginWorkerApiTables,
  createPluginWorkerOrcaApi
} from '../../workers/plugin-worker-orca-api'
import type { MockHost } from './testing-host'
import { hostError } from './testing-host-error'

/** A worker `main` module: `activate` is its default export; `deactivate` may sit beside it. */
export type WorkerModule = {
  default?: unknown
  deactivate?: unknown
  [name: string]: unknown
}

export type MountWorkerOptions = {
  host: MockHost
  /** Events the worker receives, as listed in `contributes.events`; defaults to the manifest's. */
  events: readonly string[]
  /** Command ids it may register, as listed in `contributes.commands`; null skips the check. */
  commands: readonly string[] | null
}

/** The caller a test's `request` names when it does not pass one. */
const TEST_PANEL = { id: 'test-panel', surface: 'panel', contributionId: 'panel' } as const

function isEventName(name: string): name is keyof typeof PLUGIN_EVENT_PAYLOAD_SCHEMAS {
  return Object.hasOwn(PLUGIN_EVENT_PAYLOAD_SCHEMAS, name)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs a worker's `activate(orca)` with the same `orca` object Orca builds, over the mock host:
 * events arrive only when listed, payloads are checked against Orca's schemas, and commands and
 * panel requests run with an abort signal as Orca runs them.
 */
export async function mountWorker(module: WorkerModule, options: MountWorkerOptions) {
  const { host } = options
  const subscribed = new Set(options.events)
  const tables = createPluginWorkerApiTables()
  const logs: string[] = []
  const posts: PluginWorkerPanelPost[] = []
  let active = true

  const activate = module.default
  if (typeof activate !== 'function') {
    throw new TypeError(
      typeof module.activate === 'function'
        ? 'mountWorker: the module exports activate by name, but Orca calls the default export: write `export default function activate(orca)`'
        : 'mountWorker: the module has no default-exported activate(orca) function'
    )
  }
  const deactivateExport = module.deactivate
  if (deactivateExport !== undefined && typeof deactivateExport !== 'function') {
    throw new TypeError('mountWorker: the module exports a deactivate that is not a function')
  }

  const orca = createPluginWorkerOrcaApi({
    tables,
    hostCall: (method, params) => host.worker.call(method, params),
    postToPanels: (post) => void posts.push(post),
    log: (message) => void logs.push(message),
    grantedCapabilities: host.capabilities
  })
  // A panel's storage or settings write reaches the worker's `onDidChange`, as in Orca.
  const stopListening = host.onDataChange((area, key) => {
    for (const listener of tables.dataListeners[area]) {
      listener({ key })
    }
  })

  await activate(orca)
  const undeclared = options.commands
    ? [...tables.commands.keys()].find((id) => !options.commands?.includes(id))
    : undefined
  if (undeclared !== undefined) {
    throw new Error(`registered undeclared command ${undeclared}: list it in contributes.commands`)
  }

  async function answer(name: string, input: unknown, panelId?: string): Promise<unknown> {
    const handler = tables.panelRequests.get(name)
    if (!handler) {
      throw hostError('unknown_method', `no panel handler named ${name}`)
    }
    const panel = { ...TEST_PANEL, contributionId: panelId ?? TEST_PANEL.contributionId }
    return handler(input, { panel, signal: new AbortController().signal })
  }
  // Why no idle() here: the panel's own call is still pending on the host while this answers.
  const stopAnswering = host.routeRequests((name, input) => answer(name, input))

  return {
    host,
    /** What the worker passed to `orca.log`, in order. */
    logs,
    /** What the worker sent with `orca.panels.post`, in order. */
    posts,
    /** Calls Orca would refuse, even ones the worker caught. */
    get refusals() {
      return host.refusals
    },
    /** Delivers an event as Orca would, and resolves once every handler has finished. */
    async emit(event: string, payload: unknown): Promise<void> {
      if (!isEventName(event)) {
        throw new Error(`emit: "${event}" is not an event Orca sends to workers`)
      }
      if (!subscribed.has(event)) {
        throw new Error(`emit: "${event}" never arrives: it is not in contributes.events`)
      }
      const parsed = PLUGIN_EVENT_PAYLOAD_SCHEMAS[event].safeParse(payload)
      if (!parsed.success) {
        throw new TypeError(
          `emit: that ${event} payload is not one Orca sends: ${parsed.error.issues[0]?.message ?? ''}`
        )
      }
      const handlers = tables.events.get(PLUGIN_V1_EVENT_ALIASES.get(event) ?? event) ?? []
      await Promise.all([...handlers].map(async (handler) => handler(parsed.data)))
      await host.idle()
    },
    /** Runs a registered command, as the palette or `orca plugin` would. */
    async command(commandId: string, args?: unknown): Promise<unknown> {
      const handler = tables.commands.get(commandId)
      if (!handler) {
        throw new Error(`command: the worker registered no "${commandId}"`)
      }
      const result = await handler(args, { signal: new AbortController().signal })
      await host.idle()
      return result
    },
    /** A panel's `plugin.request(name, input)`, answered by the worker's `orca.panels.handle`. */
    async request(
      name: string,
      input?: unknown,
      caller: { panel?: string } = {}
    ): Promise<unknown> {
      const output = await answer(name, input, caller.panel)
      await host.idle()
      return output
    },
    /** Runs the module's `deactivate`, as Orca does before stopping the worker. */
    async deactivate(): Promise<void> {
      if (!active) {
        return
      }
      active = false
      stopListening()
      stopAnswering()
      tables.events.clear()
      tables.commands.clear()
      tables.panelRequests.clear()
      try {
        await (typeof deactivateExport === 'function' ? deactivateExport() : undefined)
      } catch (error) {
        throw new Error(`deactivate threw: ${messageOf(error)}`, { cause: error })
      }
      await host.idle()
    }
  }
}

export type TestWorker = Awaited<ReturnType<typeof mountWorker>>
