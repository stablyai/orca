import {
  getPluginHostMethodSpec,
  pluginFrameMethodsFor,
  pluginHostApiMinorFor
} from '../../workers/plugin-host-api'
import { PLUGIN_HOST_API_MAJOR } from '../../workers/plugin-host-api-major'

/** A host API rejection, as plugin code sees it from `host.call`. */
export type MockHostError = Error & { code: string; retryable: boolean; retryAfterMs?: number }
export type MockHostCall = { method: string; params: unknown }

export type MockHostOptions = {
  /** Granted capabilities; defaults to the ones the plugin's orca-plugin.json declares. */
  capabilities?: readonly string[]
  /** What each method answers: a value, or a function of the params (it may throw `hostError`). */
  results?: Record<string, unknown>
}

const RETRYABLE = new Set(['rate_limited', 'unavailable', 'timeout', 'conflict'])

/** The error `host.call` rejects with for `code`, e.g. `hostError('rate_limited', 'slow down', 500)`. */
export function hostError(code: string, message = code, retryAfterMs?: number): MockHostError {
  return Object.assign(new Error(message), {
    code,
    retryable: RETRYABLE.has(code),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  })
}

function isResultFunction(value: unknown): value is (params: unknown) => unknown {
  return typeof value === 'function'
}

// What a desktop Orca answers when a test configures nothing for these.
const DEFAULT_RESULTS: Record<string, unknown> = {
  'workspace.readContext': null,
  'notifications.show': { delivered: true },
  'shell.openExternal': { opened: true },
  'files.saveAs': { status: 'saved' }
}

export type MockHost = {
  /** Every call that reached the host, in order, including refused ones. */
  readonly calls: readonly MockHostCall[]
  /** Calls of one method, params only. */
  callsOf(method: string): unknown[]
  respond(method: string, result: unknown): void
  /** Grants one user-gesture call, as a press on one of Orca's controls does. */
  grantGesture(): void
  /** Resolves when every call made so far has answered. */
  idle(): Promise<void>
  readonly bridge: {
    api: { major: number; minor: number }
    call(method: string, params?: unknown): Promise<unknown>
    has(method: string): boolean
  }
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
  const methods = pluginFrameMethodsFor('panel', true)
  const calls: MockHostCall[] = []
  const pending = new Set<Promise<unknown>>()
  let gestures = 0

  async function answer(method: string, params: unknown): Promise<unknown> {
    const spec = getPluginHostMethodSpec(method)
    if (!spec) {
      throw hostError('unknown_method', `${method} does not exist in this Orca`)
    }
    if (!spec.surfaces.includes('panel')) {
      throw hostError('not_permitted', `${method} is not available to panels`)
    }
    if (spec.userActivation === true) {
      if (gestures === 0) {
        throw hostError('not_permitted', `${method} needs a click or key press in the frame`)
      }
      gestures -= 1
    }
    if (spec.capability && !capabilities.has(spec.capability)) {
      throw hostError('capability_denied', `${method} needs the ${spec.capability} capability`)
    }
    const parsedParams = spec.params.safeParse(params)
    if (!parsedParams.success) {
      throw hostError('invalid_params', parsedParams.error.issues[0]?.message ?? 'invalid params')
    }
    if (!results.has(method) && !Object.hasOwn(DEFAULT_RESULTS, method)) {
      throw hostError('unavailable', `the test configured no result for ${method}`)
    }
    const configured: unknown = results.has(method) ? results.get(method) : DEFAULT_RESULTS[method]
    const value = isResultFunction(configured) ? await configured(parsedParams.data) : configured
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

  return {
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.params),
    respond: (method, result) => results.set(method, result),
    grantGesture: () => {
      // Single-use, like a press: an unused grant does not pile up.
      gestures = 1
    },
    async idle() {
      while (pending.size > 0) {
        await Promise.allSettled(pending)
      }
    },
    bridge: {
      api: { major: PLUGIN_HOST_API_MAJOR, minor: pluginHostApiMinorFor(methods) },
      call(method, params) {
        calls.push({ method, params })
        const result = answer(method, params)
        pending.add(result)
        void result.catch(() => undefined).finally(() => pending.delete(result))
        return result
      },
      has: (method) => methods.some((name) => name === method)
    }
  }
}
