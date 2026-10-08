import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import {
  deserializeAgentStatusCapabilities,
  hasAgentStatusRunCapability
} from './agent-status-run-capability'
import {
  findAgentStatusLegacyIngressManifestEntry,
  type AgentStatusLegacyIngressCaller
} from './agent-status-legacy-ingress-manifest'
import {
  AGENT_STATUS_2A_SERVING_READINESS,
  isAgentStatusRunServingAdvertised,
  type AgentStatusServingReadiness
} from './agent-status-serving-readiness'

export type AgentStatusLegacyAdmissionMode =
  | Readonly<{
      kind: 'current-producer'
      servingReadiness: AgentStatusServingReadiness
    }>
  | Readonly<{
      kind: 'older-peer'
      advertisedCapabilities: readonly string[]
    }>
  | Readonly<{ kind: 'persisted-hydration' }>

export const AGENT_STATUS_2A_CURRENT_PRODUCER_MODE: AgentStatusLegacyAdmissionMode = Object.freeze({
  kind: 'current-producer',
  servingReadiness: AGENT_STATUS_2A_SERVING_READINESS
})

export const AGENT_STATUS_PERSISTED_HYDRATION_MODE: AgentStatusLegacyAdmissionMode = Object.freeze({
  kind: 'persisted-hydration'
})

/** Existing relay protocols advertise no run-serving capability. Production ingress call sites stamp this onto the envelope explicitly. */
export const AGENT_STATUS_LEGACY_UNADVERTISED_PEER_CAPABILITIES: readonly string[] = Object.freeze(
  []
)

export function olderPeerAgentStatusLegacyMode(
  advertisedCapabilities: readonly string[]
): AgentStatusLegacyAdmissionMode {
  return Object.freeze({
    kind: 'older-peer',
    advertisedCapabilities: Object.freeze([...advertisedCapabilities])
  })
}

export function canAdmitLegacyAgentStatus(
  caller: AgentStatusLegacyIngressCaller,
  mode: AgentStatusLegacyAdmissionMode
): boolean {
  const manifestEntry = findAgentStatusLegacyIngressManifestEntry(caller)
  if (!manifestEntry || !manifestEntry.allowedModes.includes(mode.kind)) {
    return false
  }
  if (mode.kind === 'older-peer') {
    return (
      deserializeAgentStatusCapabilities(mode.advertisedCapabilities) !== null &&
      !hasAgentStatusRunCapability(mode.advertisedCapabilities)
    )
  }
  if (mode.kind === 'persisted-hydration') {
    return true
  }
  return !isAgentStatusRunServingAdvertised(mode.servingReadiness)
}

export type AgentStatusLegacyAdapter = {
  readonly view: ReadonlyMap<string, AgentHookEventPayload>
  canAdmit(
    caller: AgentStatusLegacyIngressCaller,
    mode: AgentStatusLegacyAdmissionMode,
    entry: AgentHookEventPayload
  ): boolean
  admit(
    caller: AgentStatusLegacyIngressCaller,
    mode: AgentStatusLegacyAdmissionMode,
    entry: AgentHookEventPayload,
    options?: { moveToEnd?: boolean }
  ): boolean
  delete(paneKey: string): boolean
  clear(): void
  move(fromPaneKey: string, toPaneKey: string): void
  listingOrder(paneKey: string): number | undefined
}

export type AgentStatusLegacyAdapterOptions = {
  nextListingOrder?: () => number
  isCanonicalPaneKey?: (paneKey: string) => boolean
}

function freezeRecursively(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return
  }
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) {
      freezeRecursively(descriptor.value, seen)
    }
  }
  Object.freeze(value)
}

function freezeStatusEntry(entry: AgentHookEventPayload): void {
  freezeRecursively(entry, new WeakSet())
}

function createReadonlyView(
  entries: Map<string, AgentHookEventPayload>
): ReadonlyMap<string, AgentHookEventPayload> {
  let view: ReadonlyMap<string, AgentHookEventPayload>
  view = Object.freeze({
    get size() {
      return entries.size
    },
    get: (key: string) => entries.get(key),
    has: (key: string) => entries.has(key),
    entries: () => entries.entries(),
    keys: () => entries.keys(),
    values: () => entries.values(),
    forEach: (
      callback: (
        value: AgentHookEventPayload,
        key: string,
        map: ReadonlyMap<string, AgentHookEventPayload>
      ) => void,
      thisArg?: unknown
    ) => entries.forEach((value, key) => callback.call(thisArg, value, key, view)),
    [Symbol.iterator]: () => entries[Symbol.iterator](),
    [Symbol.toStringTag]: 'AgentStatusLegacyReadonlyMap'
  })
  return view
}

export function createAgentStatusLegacyAdapter(
  options: AgentStatusLegacyAdapterOptions = {}
): AgentStatusLegacyAdapter {
  const entries = new Map<string, AgentHookEventPayload>()
  const listingOrderByPaneKey = new Map<string, number>()
  let nextLocalListingOrder = 0
  const nextListingOrder = options.nextListingOrder ?? (() => nextLocalListingOrder++)
  const isCanonicalPaneKey = options.isCanonicalPaneKey ?? (() => false)
  const view = createReadonlyView(entries)
  const canAdmit: AgentStatusLegacyAdapter['canAdmit'] = (caller, mode, entry) =>
    entry.structuredHost === undefined &&
    !isCanonicalPaneKey(entry.paneKey) &&
    canAdmitLegacyAgentStatus(caller, mode)

  return {
    view,
    canAdmit,
    admit: (caller, mode, entry, admitOptions = {}) => {
      if (!canAdmit(caller, mode, entry)) {
        return false
      }
      if (!listingOrderByPaneKey.has(entry.paneKey) || admitOptions.moveToEnd) {
        const order = nextListingOrder()
        if (!Number.isSafeInteger(order) || order < 0) {
          throw new RangeError(
            'Legacy agent-status listing order must be a non-negative safe integer'
          )
        }
        listingOrderByPaneKey.set(entry.paneKey, order)
      }
      freezeStatusEntry(entry)
      if (admitOptions.moveToEnd) {
        entries.delete(entry.paneKey)
      }
      entries.set(entry.paneKey, entry)
      return true
    },
    delete: (paneKey) => {
      listingOrderByPaneKey.delete(paneKey)
      return entries.delete(paneKey)
    },
    clear: () => {
      entries.clear()
      listingOrderByPaneKey.clear()
    },
    move: (fromPaneKey, toPaneKey) => {
      if (fromPaneKey === toPaneKey) {
        return
      }
      for (const [key, value] of Array.from(entries)) {
        if (key !== fromPaneKey && !key.startsWith(`${fromPaneKey}\0`)) {
          continue
        }
        const movedKey = `${toPaneKey}${key.slice(fromPaneKey.length)}`
        const priorTargetOrder = listingOrderByPaneKey.get(movedKey)
        entries.delete(key)
        listingOrderByPaneKey.delete(key)
        if (isCanonicalPaneKey(movedKey)) {
          continue
        }
        entries.set(movedKey, value)
        if (priorTargetOrder !== undefined) {
          listingOrderByPaneKey.set(movedKey, priorTargetOrder)
        } else {
          listingOrderByPaneKey.set(movedKey, nextListingOrder())
        }
      }
    },
    listingOrder: (paneKey) => listingOrderByPaneKey.get(paneKey)
  }
}
