import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import type { SessionOptionValue } from './native-chat-session-options'
import {
  cloneNativeChatSessionOptionRecord,
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord,
  type TrackedNativeChatSessionOption
} from './native-chat-session-option-state'
import { setBoundedScopeCacheEntry } from '../native-chat-scope-cache'
import type {
  NativeChatSessionOptionOwner,
  NativeChatSessionOptionBindingSource
} from './native-chat-session-option-owner'
export type { NativeChatSessionOptionOwner } from './native-chat-session-option-owner'
import {
  enrichNativeChatSessionOptionBinding,
  nativeChatSessionOptionBindingObservationsEqual,
  sameNativeChatSessionOptionBinding,
  type NativeChatSessionOptionBinding
} from './native-chat-session-option-binding'

type Entry = {
  record: NativeChatSessionOptionRecord
  binding: NativeChatSessionOptionBinding
  leases: number
  listeners: Set<() => void>
  bindingListeners: Set<() => void>
}
export type NativeChatSessionOptionLease = NativeChatSessionOptionBindingSource & {
  record: NativeChatSessionOptionRecord
  isCurrent: () => boolean
  transact: (mutate: (record: NativeChatSessionOptionRecord) => boolean) => boolean
  settle: (mutate: (record: NativeChatSessionOptionRecord) => boolean) => boolean
  subscribe: (listener: () => void) => () => void
  release: () => void
}
const activeEntries = new Map<string, Entry>()
const inactiveBindings = new WeakMap<
  NativeChatSessionOptionRecord,
  NativeChatSessionOptionBinding
>()

function publishBinding(entry: Entry, binding: NativeChatSessionOptionBinding): void {
  if (nativeChatSessionOptionBindingObservationsEqual(entry.binding, binding)) {
    return
  }
  entry.binding = binding
  for (const listener of entry.bindingListeners) {
    listener()
  }
}

export function readNativeChatSessionOptionSeedBinding(
  scopeKey: string,
  candidate: NativeChatSessionOptionBinding
): NativeChatSessionOptionBinding {
  const active = activeEntries.get(scopeKey)
  const record = active?.record ?? sessionOptionCache.get(scopeKey)
  const binding = active?.binding ?? (record ? inactiveBindings.get(record) : undefined)
  return binding && sameNativeChatSessionOptionBinding(binding, candidate)
    ? enrichNativeChatSessionOptionBinding(binding, candidate)
    : candidate
}

export function readNativeChatSessionOptionSeed(
  scopeKey: string,
  owner: Pick<NativeChatSessionOptionOwner, 'binding'>,
  fallbackScopeKey?: string
): NativeChatSessionOptionRecord {
  const active = activeEntries.get(scopeKey)
  const record = active?.record ?? sessionOptionCache.get(scopeKey)
  const binding = active?.binding ?? (record ? inactiveBindings.get(record) : undefined)
  if (record && binding && sameNativeChatSessionOptionBinding(binding, owner.binding)) {
    return record
  }
  // Launch preferences have no live process authority.
  const seed = !binding ? record : sessionOptionCache.get(fallbackScopeKey ?? '')
  const result = createNativeChatSessionOptionRecord(owner.binding.agent)
  if (seed?.agent === result.agent && seed.model?.source === 'applied') {
    result.model = { ...seed.model }
    for (const [model, values] of Object.entries(seed.valuesByModel)) {
      result.valuesByModel[model] = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value.source === 'applied')
      )
    }
  }
  return result
}

/** Only mounted surfaces and pending operations acquire a live owner. */
export function acquireNativeChatSessionOptionLease(
  scopeKey: string,
  owner: NativeChatSessionOptionOwner,
  fallbackScopeKey?: string
): NativeChatSessionOptionLease | null {
  const current = owner.currentBinding()
  if (!current) {
    return null
  }
  let entry = activeEntries.get(scopeKey)
  if (entry && !sameNativeChatSessionOptionBinding(entry.binding, current)) {
    activeEntries.delete(scopeKey)
    for (const listener of entry.bindingListeners) {
      listener()
    }
    entry = undefined
  }
  if (!entry) {
    const seed = readNativeChatSessionOptionSeed(scopeKey, { binding: current }, fallbackScopeKey)
    entry = {
      record: cloneNativeChatSessionOptionRecord(seed),
      binding: enrichNativeChatSessionOptionBinding(
        enrichNativeChatSessionOptionBinding(
          inactiveBindings.get(seed) ?? owner.binding,
          owner.binding
        ),
        current
      ),
      leases: 0,
      listeners: new Set(),
      bindingListeners: new Set()
    }
    activeEntries.set(scopeKey, entry)
    sessionOptionCache.delete(scopeKey)
  } else {
    publishBinding(entry, enrichNativeChatSessionOptionBinding(entry.binding, current))
  }
  owner.captureBinding(entry.binding)
  const held = entry
  held.leases++
  let released = false
  const isHeld = (): boolean => !released && activeEntries.get(scopeKey) === held
  const isCurrent = (): boolean => {
    if (!isHeld() || !owner.captureBinding(held.binding)) {
      return false
    }
    const next = owner.currentBinding()
    if (!next || !sameNativeChatSessionOptionBinding(held.binding, next)) {
      return false
    }
    publishBinding(held, enrichNativeChatSessionOptionBinding(held.binding, next))
    return true
  }
  const settle = (mutate: (record: NativeChatSessionOptionRecord) => boolean): boolean => {
    if (released || activeEntries.get(scopeKey) !== held || !mutate(held.record)) {
      return false
    }
    for (const listener of held.listeners) {
      listener()
    }
    return true
  }
  return {
    record: held.record,
    getBindingSnapshot: () => held.binding,
    isHeld,
    subscribeBinding: (listener) => {
      held.bindingListeners.add(listener)
      return () => held.bindingListeners.delete(listener)
    },
    isCurrent,
    transact: (mutate) => isCurrent() && settle(mutate),
    settle,
    subscribe: (listener) => {
      held.listeners.add(listener)
      return () => held.listeners.delete(listener)
    },
    release: () => {
      if (released) {
        return
      }
      released = true
      held.leases--
      if (held.leases !== 0 || activeEntries.get(scopeKey) !== held) {
        return
      }
      activeEntries.delete(scopeKey)
      // Historical results regain authority only through a current, compatible acquire.
      const record = cloneNativeChatSessionOptionRecord(held.record)
      inactiveBindings.set(record, held.binding)
      setBoundedScopeCacheEntry(sessionOptionCache, scopeKey, record)
    }
  }
}

const sessionOptionCache = new Map<string, NativeChatSessionOptionRecord>()

export function readNativeChatSessionOptionCache(
  scopeKey: string,
  fallbackScopeKey?: string
): NativeChatSessionOptionRecord | null {
  const record =
    activeEntries.get(scopeKey)?.record ??
    sessionOptionCache.get(scopeKey) ??
    sessionOptionCache.get(fallbackScopeKey ?? '')
  return record ? cloneNativeChatSessionOptionRecord(record) : null
}

export function writeNativeChatSessionOptionCache(
  scopeKey: string,
  record: NativeChatSessionOptionRecord
): void {
  if (activeEntries.has(scopeKey)) {
    return
  }
  setBoundedScopeCacheEntry(
    sessionOptionCache,
    scopeKey,
    cloneNativeChatSessionOptionRecord(record)
  )
}

export function seedNativeChatAppliedSessionOptions(
  scopeKey: string,
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined
): void {
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!modelId) {
    return
  }
  const record = createNativeChatSessionOptionRecord(agent)
  record.model = { value: modelId, source: 'applied' }
  const modelValues: Record<string, TrackedNativeChatSessionOption> = {}
  for (const [id, value] of Object.entries(values ?? {})) {
    if (id !== 'model') {
      modelValues[id] = { value, source: 'applied' }
    }
  }
  record.valuesByModel[modelId] = modelValues
  writeNativeChatSessionOptionCache(scopeKey, record)
}

export function clearNativeChatSessionOptionCacheForTests(): void {
  sessionOptionCache.clear()
  activeEntries.clear()
}
