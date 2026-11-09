import { useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import type {
  RuntimePortForward,
  RuntimePortForwardOpenRequest,
  RuntimePortForwardOpenResult
} from '../../../../shared/runtime-port-forwards'

type ForwardState = {
  forwards: RuntimePortForward[]
  /** `${environmentId}:${remotePort}` being forwarded right now (by the user or auto-forward). */
  pending: ReadonlySet<string>
  /** Last failure per `${environmentId}:${remotePort}`, cleared when it forwards. */
  failures: ReadonlyMap<string, RuntimePortForwardFailure>
  /** Latest outcome for the Ports panel's polite live region. */
  announcement: string
}

export type RuntimePortForwardFailure = {
  code: Extract<RuntimePortForwardOpenResult, { ok: false }>['code']
  localPort: number
}

const EMPTY_FORWARDS: RuntimePortForward[] = []
let state: ForwardState = {
  forwards: EMPTY_FORWARDS,
  pending: new Set(),
  failures: new Map(),
  announcement: ''
}
const listeners = new Set<() => void>()
let started = false
let broadcastSeen = false
const USER_CLOSED_STORAGE_KEY = 'orca.runtimePortForwards.userClosed'

/** Ports the user stopped forwarding; auto-forward leaves them alone for this app session (survives reloads). */
const userClosed = new Set<string>(readUserClosed())

function readUserClosed(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(USER_CLOSED_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string')
      : []
  } catch {
    return []
  }
}

function saveUserClosed(): void {
  try {
    sessionStorage.setItem(USER_CLOSED_STORAGE_KEY, JSON.stringify([...userClosed]))
  } catch {
    // Storage is best effort; the in-memory set still applies.
  }
}

export const portForwardKey = (environmentId: string, remotePort: number): string =>
  `${environmentId}:${remotePort}`

function bridge(): Window['api']['runtimeEnvironments'] {
  return window.api.runtimeEnvironments
}

/** False in the web client, which cannot listen on this computer's loopback. */
export function runtimePortForwardingAvailable(): boolean {
  return typeof bridge()?.openPortForward === 'function'
}

function emit(next: ForwardState): void {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

// Byte counters change on every chunk; the UI only shows these fields.
function visibleSignature(forward: RuntimePortForward): string {
  return [
    forward.id,
    forward.localPort,
    forward.reason,
    forward.label ?? '',
    forward.lastError ?? '',
    forward.openConnections
  ].join('|')
}

function publishForwards(next: RuntimePortForward[]): void {
  const previous = state.forwards
  if (
    previous.length === next.length &&
    previous.every((forward, index) => visibleSignature(forward) === visibleSignature(next[index]!))
  ) {
    return
  }
  emit({ ...state, forwards: next.length === 0 ? EMPTY_FORWARDS : next })
}

function start(): void {
  if (started || !runtimePortForwardingAvailable()) {
    return
  }
  started = true
  bridge().onPortForwardsChanged?.((next) => {
    broadcastSeen = true
    publishForwards(next)
  })
  void bridge()
    .listPortForwards?.()
    .then((next) => {
      // A broadcast that arrived first is newer than this startup snapshot.
      if (!broadcastSeen) {
        publishForwards(next)
      }
    })
    .catch(() => {})
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getState(): ForwardState {
  return state
}

export function getRuntimePortForwards(): RuntimePortForward[] {
  start()
  return state.forwards
}

export function useRuntimePortForwardState(): ForwardState {
  return useSyncExternalStore(subscribe, getState)
}

export function isRuntimePortForwardUserClosed(environmentId: string, remotePort: number): boolean {
  return userClosed.has(portForwardKey(environmentId, remotePort))
}

export async function openRuntimePortForward(
  request: RuntimePortForwardOpenRequest
): Promise<RuntimePortForwardOpenResult> {
  const open = bridge()?.openPortForward
  if (!open) {
    return {
      ok: false,
      code: 'listen_failed',
      message: translate(
        'auto.lib.runtimePortForwards.desktopOnly',
        'Port forwarding needs the desktop app.'
      )
    }
  }
  const key = portForwardKey(request.environmentId, request.remotePort)
  if (request.reason !== 'auto' && userClosed.delete(key)) {
    saveUserClosed()
  }
  emit({ ...state, pending: new Set(state.pending).add(key) })
  let result: RuntimePortForwardOpenResult
  try {
    result = await open(request)
  } catch (error) {
    result = {
      ok: false,
      code: 'tunnel_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
  const pending = new Set(state.pending)
  pending.delete(key)
  const failures = new Map(state.failures)
  if (result.ok) {
    failures.delete(key)
  } else {
    failures.set(key, { code: result.code, localPort: request.localPort ?? request.remotePort })
  }
  emit({
    forwards: result.ok
      ? [...state.forwards.filter((forward) => forward.id !== result.forward.id), result.forward]
      : state.forwards,
    pending,
    failures,
    announcement: result.ok
      ? translate(
          'auto.lib.runtimePortForwards.forwardedAnnouncement',
          'Forwarded :{{value0}} to localhost:{{value1}}',
          { value0: request.remotePort, value1: result.forward.localPort }
        )
      : `:${request.remotePort} ${runtimePortForwardFailureText({
          code: result.code,
          localPort: request.localPort ?? request.remotePort
        })}`
  })
  return result
}

/** Stops a forward; a user stop also keeps auto-forward from bringing it back. */
export async function closeRuntimePortForward(
  forward: Pick<RuntimePortForward, 'id' | 'environmentId' | 'remotePort'>,
  byUser = true
): Promise<void> {
  if (byUser) {
    userClosed.add(portForwardKey(forward.environmentId, forward.remotePort))
    saveUserClosed()
  }
  await bridge()?.closePortForward?.({ id: forward.id })
  // Main broadcasts the change; re-list in case that broadcast was dropped.
  const next = await bridge()
    ?.listPortForwards?.()
    .catch(() => null)
  if (next) {
    publishForwards(next)
  }
}

export function runtimePortForwardFailureText(failure: RuntimePortForwardFailure): string {
  switch (failure.code) {
    case 'port_busy':
      return translate('auto.lib.runtimePortForwards.busyInUse', 'localhost:{{value0}} in use', {
        value0: failure.localPort
      })
    case 'host_unsupported':
      return translate('auto.lib.runtimePortForwards.updateHost', 'Update Orca on this host')
    case 'invalid_request':
    case 'listen_failed':
      return translate(
        'auto.lib.runtimePortForwards.listenFailedHere',
        'Could not listen on this computer'
      )
    case 'tunnel_failed':
      return translate('auto.lib.runtimePortForwards.hostNotReachable', 'Host not reachable')
  }
}

/** Reconnects (and wakes a sleeping VM) by opening the environment's tunnel. */
export async function wakeRuntimePortForwardHost(environmentId: string): Promise<void> {
  await bridge()?.wakePortForwardHost?.({ environmentId })
}

export function runtimePortForwardUrl(
  forward: Pick<RuntimePortForward, 'localPort'>,
  protocol: 'http' | 'https' = 'http'
): string {
  return `${protocol}://localhost:${forward.localPort}`
}
