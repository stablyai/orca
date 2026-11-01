import {
  getPluginHostMethodSpec,
  pluginFrameMethodsFor,
  pluginHostApiMinorFor,
  pluginHostMethodsFor,
  type PluginHostMethodName
} from '../../workers/plugin-host-api'
import { PLUGIN_HOST_API_MAJOR } from '../../workers/plugin-host-api-major'

import { hostError } from './testing-host-error'
import {
  createMockPluginData,
  type MockPluginDataOptions,
  type MockPluginDataSnapshot
} from './testing-plugin-data'

export { hostError, type MockHostError } from './testing-host-error'
export type MockHostCall = { method: string; params: unknown }
/** A call Orca itself would refuse (not a failure the test configured), even if the code caught it. */
export type MockHostRefusal = { method: string; code: string; message: string }
type Surface = 'panel' | 'worker'
// The checks Orca makes before running a method; a configured `hostError` is not one of them.
class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export type MockHostOptions = MockPluginDataOptions & {
  /** Granted capabilities; defaults to the ones the plugin's orca-plugin.json declares. */
  capabilities?: readonly string[]
  /** What each method answers: a value, or a function of the params (it may throw `hostError`).
   *  Overrides the built-in storage, settings, secrets and `requests`. */
  results?: Record<string, unknown>
}

function isResultFunction(value: unknown): value is (params: unknown) => unknown {
  return typeof value === 'function'
}

// What a desktop Orca answers when a test configures nothing for these.
const DEFAULT_RESULTS: Record<string, unknown> = {
  'workspace.readContext': null,
  'notifications.show': { delivered: true },
  'shell.openExternal': { opened: true },
  'files.saveAs': { status: 'saved' },
  'agents.list': { agents: [] }
}

type MockHostSurface = {
  api: { major: number; minor: number }
  call(method: string, params?: unknown): Promise<unknown>
  has(method: string): boolean
}

export type MockHost = {
  /** Every call that reached the host, in order, including refused ones. */
  readonly calls: readonly MockHostCall[]
  /** Calls Orca would refuse: unknown method, wrong surface, missing capability, bad params, no press. */
  readonly refusals: readonly MockHostRefusal[]
  /** Granted capability kinds. */
  readonly capabilities: readonly string[]
  /** Calls of one method, params only. */
  callsOf(method: string): unknown[]
  respond(method: string, result: unknown): void
  /** Grants one user-gesture call, as a press on one of Orca's controls does. */
  grantGesture(): void
  /** Resolves when every call made so far has answered. */
  idle(): Promise<void>
  /** The plugin's storage, settings and secrets as they are now. */
  data(): MockPluginDataSnapshot
  /** Hears each storage or settings write, as Orca tells the plugin's open panels. */
  onDataChange(listener: (area: 'storage' | 'settings', key: string) => void): () => void
  /** A mounted worker answers the panel's `plugin.request` (what `requests` does not stub). */
  routeRequests(handler: (name: string, input: unknown) => Promise<unknown>): () => void
  /** The panel's view of the host. */
  readonly bridge: MockHostSurface
  /** A worker's view: worker methods, no gestures. */
  readonly worker: MockHostSurface
}

/**
 * A stand-in for Orca's host: it refuses what Orca would (unknown method, wrong surface, missing
 * capability, bad params, a user-gesture method without a press) with the same codes, checks
 * results against the host API, and records every call.
 */
export function createMockHost(
  options: MockHostOptions,
  declaredCapabilities: readonly string[]
): MockHost {
  const capabilities = new Set(options.capabilities ?? declaredCapabilities)
  const results = new Map<string, unknown>(Object.entries(options.results ?? {}))
  const data = createMockPluginData(options)
  const surfaceMethods: Record<Surface, readonly PluginHostMethodName[]> = {
    panel: pluginFrameMethodsFor('panel', true),
    worker: pluginHostMethodsFor('worker')
  }
  const calls: MockHostCall[] = []
  const refusals: MockHostRefusal[] = []
  const pending = new Set<Promise<unknown>>()
  let gestures = 0

  const refuse = (code: string, message: string): never => {
    throw new Refusal(code, message)
  }

  async function check(method: string, params: unknown, surface: Surface): Promise<unknown> {
    const spec = getPluginHostMethodSpec(method)
    if (!spec) {
      return refuse('unknown_method', `${method} does not exist in this Orca`)
    }
    if (!spec.surfaces.includes(surface)) {
      return refuse('not_permitted', `${method} is not available to ${surface}s`)
    }
    if (spec.userActivation === true) {
      if (gestures === 0) {
        return refuse('not_permitted', `${method} needs a click or key press in the frame`)
      }
      gestures -= 1
    }
    if (spec.capability && !capabilities.has(spec.capability)) {
      return refuse('capability_denied', `${method} needs the ${spec.capability} capability`)
    }
    const parsedParams = spec.params.safeParse(params)
    if (!parsedParams.success) {
      return refuse('invalid_params', parsedParams.error.issues[0]?.message ?? 'invalid params')
    }
    return parsedParams.data
  }

  async function answer(method: string, params: unknown, surface: Surface): Promise<unknown> {
    let checkedParams: unknown
    try {
      checkedParams = await check(method, params, surface)
    } catch (error) {
      if (error instanceof Refusal) {
        refusals.push({ method, code: error.code, message: error.message })
        throw hostError(error.code, error.message)
      }
      throw error
    }
    const spec = getPluginHostMethodSpec(method)
    if (!spec) {
      throw hostError('unknown_method', method)
    }
    const builtIn = !results.has(method) && data.handles(method)
    if (!results.has(method) && !builtIn && !Object.hasOwn(DEFAULT_RESULTS, method)) {
      throw hostError('unavailable', `the test configured no result for ${method}`)
    }
    const configured: unknown = results.has(method) ? results.get(method) : DEFAULT_RESULTS[method]
    const value = builtIn
      ? await data.answer(method, checkedParams)
      : isResultFunction(configured)
        ? await configured(checkedParams)
        : configured
    const parsedResult = spec.result.safeParse(value)
    if (!parsedResult.success) {
      // The test's mock is wrong, not the plugin: fail loudly instead of rejecting the call.
      throw new TypeError(
        `mockHost: the result configured for ${method} does not match the host API: ${
          parsedResult.error.issues[0]?.message ?? 'invalid result'
        }`
      )
    }
    return parsedResult.data
  }

  const surfaceOf = (surface: Surface): MockHostSurface => ({
    api: { major: PLUGIN_HOST_API_MAJOR, minor: pluginHostApiMinorFor(surfaceMethods[surface]) },
    call(method, params) {
      calls.push({ method, params })
      const result = answer(method, params, surface)
      pending.add(result)
      void result.catch(() => undefined).finally(() => pending.delete(result))
      return result
    },
    has: (method) => surfaceMethods[surface].some((name) => name === method)
  })

  return {
    calls,
    refusals,
    capabilities: [...capabilities],
    callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.params),
    respond: (method, result) => results.set(method, result),
    grantGesture: () => {
      // Single-use, like a press: an unused grant does not pile up.
      gestures = 1
    },
    data: () => data.snapshot(),
    onDataChange: (listener) => data.onChange(listener),
    routeRequests: (handler) => data.routeRequests(handler),
    async idle() {
      while (pending.size > 0) {
        await Promise.allSettled(pending)
      }
    },
    bridge: surfaceOf('panel'),
    worker: surfaceOf('worker')
  }
}
