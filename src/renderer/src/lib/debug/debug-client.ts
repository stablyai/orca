import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import type {
  DebugApi,
  DebugOutputEvent,
  DebugResult,
  DebugSnapshot
} from '../../../../preload/api/debug-api'

/** The web preload has no main process to host a debugger, so it exposes no bridge. */
export type DebugUnavailable = {
  ok: false
  reason: 'unavailable'
  message: string
}
export type DebugClientResult<T> = DebugResult<T> | DebugUnavailable

type Calls = Omit<DebugApi, 'subscribe' | 'onState' | 'onOutput'>
type Wrapped<F> = F extends (...args: infer A) => Promise<DebugResult<infer T>>
  ? (...args: A) => Promise<DebugClientResult<T>>
  : never

export type DebugClient = { [K in keyof Calls]: Wrapped<Calls[K]> } & {
  readonly available: boolean
  /** Starts the debug:state and debug:output pushes; idempotent. */
  subscribe: () => Promise<DebugClientResult<null>>
  onState: (listener: (snapshot: DebugSnapshot) => void) => () => void
  onOutput: (listener: (event: DebugOutputEvent) => void) => () => void
}

function unavailable(): DebugUnavailable {
  return {
    ok: false,
    reason: 'unavailable',
    message: translate('debug.client.unavailable', 'The debugger is not available in this window.')
  }
}

export function readWindowDebugBridge(): DebugApi | undefined {
  if (typeof window === 'undefined' || !window.api) {
    return undefined
  }
  const { debug }: PreloadApi & Partial<{ debug: DebugApi }> = window.api
  return debug
}

export function createDebugClient(
  getBridge: () => DebugApi | undefined = readWindowDebugBridge
): DebugClient {
  const stateListeners = new Set<(snapshot: DebugSnapshot) => void>()
  const outputListeners = new Set<(event: DebugOutputEvent) => void>()
  let attached = false
  let subscription: Promise<DebugClientResult<null>> | null = null

  async function run<T>(
    call: (bridge: DebugApi) => Promise<DebugResult<T>>
  ): Promise<DebugClientResult<T>> {
    const bridge = getBridge()
    if (!bridge) {
      return unavailable()
    }
    try {
      return await call(bridge)
    } catch (error) {
      // A rejected invoke (handler not registered, window closing) is a refusal, never a throw.
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: 'request-failed', message }
    }
  }

  function subscribe(): Promise<DebugClientResult<null>> {
    const bridge = getBridge()
    if (!bridge) {
      return Promise.resolve(unavailable())
    }
    if (!attached) {
      attached = true
      bridge.onState((snapshot) => stateListeners.forEach((listener) => listener(snapshot)))
      bridge.onOutput((event) => outputListeners.forEach((listener) => listener(event)))
    }
    subscription ??= run((api) => api.subscribe()).then((result) => {
      if (!result.ok) {
        subscription = null
      }
      return result
    })
    return subscription
  }

  function listen<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) {
    listeners.add(listener)
    void subscribe()
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    get available() {
      return getBridge() !== undefined
    },
    describeAdapters: (params) => run((api) => api.describeAdapters(params)),
    listConfigs: (params) => run((api) => api.listConfigs(params)),
    previewLaunch: (params) => run((api) => api.previewLaunch(params)),
    approveLaunch: (params) => run((api) => api.approveLaunch(params)),
    start: (params) => run((api) => api.start(params)),
    stop: (params) => run((api) => api.stop(params)),
    restart: (params) => run((api) => api.restart(params)),
    continue: (params) => run((api) => api.continue(params)),
    next: (params) => run((api) => api.next(params)),
    stepIn: (params) => run((api) => api.stepIn(params)),
    stepOut: (params) => run((api) => api.stepOut(params)),
    pause: (params) => run((api) => api.pause(params)),
    threads: (params) => run((api) => api.threads(params)),
    stackTrace: (params) => run((api) => api.stackTrace(params)),
    scopes: (params) => run((api) => api.scopes(params)),
    variables: (params) => run((api) => api.variables(params)),
    evaluate: (params) => run((api) => api.evaluate(params)),
    setVariable: (params) => run((api) => api.setVariable(params)),
    setExceptionFilters: (params) => run((api) => api.setExceptionFilters(params)),
    addBreakpoint: (params) => run((api) => api.addBreakpoint(params)),
    updateBreakpoint: (params) => run((api) => api.updateBreakpoint(params)),
    removeBreakpoint: (params) => run((api) => api.removeBreakpoint(params)),
    setFileLines: (params) => run((api) => api.setFileLines(params)),
    listBreakpoints: (params) => run((api) => api.listBreakpoints(params)),
    snapshot: (params) => run((api) => api.snapshot(params)),
    eventsSince: (params) => run((api) => api.eventsSince(params)),
    subscribe,
    onState: (listener) => listen(stateListeners, listener),
    onOutput: (listener) => listen(outputListeners, listener)
  }
}

export const debugClient = createDebugClient()
