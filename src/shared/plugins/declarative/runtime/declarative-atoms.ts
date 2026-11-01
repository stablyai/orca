/** Observable state for components panels: reads during a render subscribe that render. */

const ATOM = Symbol.for('orca.declarative.atom')

/** Where a keyed atom's value survives: `memory` (this panel run), `plugin`, or `workspace`. */
export type OrcaPersistScope = 'memory' | 'plugin' | 'workspace'
export type OrcaAtomOptions<T> = {
  persist?: OrcaPersistScope
  /** Bump when the stored shape changes; `migrate` then receives the older value. */
  version?: number
  migrate?: (stored: unknown, fromVersion: number) => T
}
export type OrcaStoredValue = { version: number; value: unknown }

type AtomState<T> = {
  value: T
  initial: T
  listeners: Set<() => void>
  readonly: boolean
  /** Derived atoms compute on every read, so whatever they read subscribes the render. */
  compute?: () => T
  key?: string
  persist: OrcaPersistScope
  version: number
  migrate?: (stored: unknown, fromVersion: number) => T
}

export type OrcaAtom<T> = { readonly [ATOM]: AtomState<T> }

type Tracker = (atom: OrcaAtom<unknown>) => void
let activeTracker: Tracker | null = null

const ATOM_KEY = /^[A-Za-z0-9_.:-]{1,128}$/
const keyed = new Map<string, OrcaAtom<unknown>>()
/** Persisted values from the host, by scope; atoms created later hydrate from it too. */
const snapshot: Record<'plugin' | 'workspace', Map<string, OrcaStoredValue>> = {
  plugin: new Map(),
  workspace: new Map()
}
let onPersistedChange: ((atom: OrcaAtom<unknown>) => void) | null = null

function create<T>(initial: T, fields: Partial<AtomState<T>> = {}): OrcaAtom<T> {
  return Object.freeze({
    [ATOM]: {
      value: initial,
      initial,
      listeners: new Set<() => void>(),
      readonly: false,
      persist: 'memory' as const,
      version: 1,
      ...fields
    }
  })
}

type Stored<T> = { found: true; value: T } | { found: false }

function stored<T>(inner: AtomState<T>): Stored<T> {
  if (!inner.key || inner.persist === 'memory') {
    return { found: false }
  }
  const entry = snapshot[inner.persist].get(inner.key)
  if (!entry) {
    return { found: false }
  }
  if (entry.version === inner.version) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by this atom's own version, which stores values of its type.
    return { found: true, value: entry.value as T }
  }
  // A shape the plugin no longer understands falls back to the initial value.
  return inner.migrate
    ? { found: true, value: inner.migrate(entry.value, entry.version) }
    : { found: false }
}

/**
 * `atom(initial)` is anonymous and lives for this panel run. `atom(key, initial, options)` is
 * named (unique per plugin) and may persist across runs for the plugin or the workspace.
 */
export function atom<T>(initial: T): OrcaAtom<T>
export function atom<T>(key: string, initial: T, options?: OrcaAtomOptions<T>): OrcaAtom<T>
export function atom<T>(...args: [T] | [string, T, OrcaAtomOptions<T>?]): OrcaAtom<T> {
  if (args.length === 1) {
    return create(args[0])
  }
  const [key, initial, options = {}] = args
  if (typeof key !== 'string' || !ATOM_KEY.test(key)) {
    throw new TypeError('an atom key is 1-128 letters, digits, or . _ : -')
  }
  if (keyed.has(key)) {
    throw new Error(`atom key "${key}" is already used`)
  }
  const persist = options.persist ?? 'memory'
  if (persist !== 'memory' && persist !== 'plugin' && persist !== 'workspace') {
    throw new TypeError('persist is "memory", "plugin" or "workspace"')
  }
  const result = create(initial, {
    key,
    persist,
    version: options.version ?? 1,
    migrate: options.migrate
  })
  const inner = result[ATOM]
  const hydrated = stored(inner)
  if (hydrated.found) {
    inner.value = hydrated.value
  }
  keyed.set(key, result)
  return result
}

/** A read-only atom computed from others; reading it in render subscribes to what it reads. */
export function derived<T>(compute: () => T): OrcaAtom<T> {
  if (typeof compute !== 'function') {
    throw new TypeError('derived() takes a function')
  }
  return create(compute(), { readonly: true, compute })
}

/** A read-only atom only Orca updates (for example `ctx.visible`). */
export function hostAtom<T>(initial: T): { atom: OrcaAtom<T>; set: (value: T) => void } {
  const result = create(initial, { readonly: true })
  return { atom: result, set: (value) => assign(result[ATOM], value, false) }
}

function state<T>(target: OrcaAtom<T>): AtomState<T> {
  const inner = typeof target === 'object' && target !== null ? target[ATOM] : undefined
  if (!inner) {
    throw new TypeError('expected an atom created by atom()')
  }
  return inner
}

export function read<T>(target: OrcaAtom<T>): T {
  const inner = state(target)
  if (inner.compute) {
    return inner.compute()
  }
  activeTracker?.(target)
  return inner.value
}

function assign<T>(inner: AtomState<T>, value: T, persist: boolean): void {
  if (Object.is(value, inner.value)) {
    return
  }
  inner.value = value
  for (const listener of inner.listeners) {
    listener()
  }
  if (persist && inner.key && inner.persist !== 'memory') {
    const target = keyed.get(inner.key)
    if (target) {
      onPersistedChange?.(target)
    }
  }
}

function writable<T>(target: OrcaAtom<T>, verb: string): AtomState<T> {
  if (activeTracker) {
    // Why: a write while rendering would schedule another render, forever.
    throw new Error(`${verb}() was called while rendering; call it from an event handler instead`)
  }
  const inner = state(target)
  if (inner.readonly) {
    throw new TypeError(`${verb}() cannot change a read-only atom`)
  }
  return inner
}

/** Stores `value` as is, functions included. */
export function set<T>(target: OrcaAtom<T>, value: T): void {
  assign(writable(target, 'set'), value, true)
}

/** Replaces the value with `updater(previous)`. */
export function update<T>(target: OrcaAtom<T>, updater: (previous: T) => T): void {
  const inner = writable(target, 'update')
  if (typeof updater !== 'function') {
    throw new TypeError('update() takes an updater function; use set() to store a value')
  }
  assign(inner, updater(inner.value), true)
}

export function subscribeAtom(target: OrcaAtom<unknown>, listener: () => void): () => void {
  const inner = state(target)
  inner.listeners.add(listener)
  return () => inner.listeners.delete(listener)
}

/** Runs `render`, adding every atom it reads to `reads` (even when it throws). */
export function trackAtomReads<R>(reads: Set<OrcaAtom<unknown>>, render: () => R): R {
  const previous = activeTracker
  activeTracker = (target) => reads.add(target)
  try {
    return render()
  } finally {
    activeTracker = previous
  }
}

export type OrcaPersistedEntry = {
  scope: 'plugin' | 'workspace'
  key: string
  version: number
  value: unknown
}

export function persistedEntry(target: OrcaAtom<unknown>): OrcaPersistedEntry | null {
  const inner = state(target)
  return inner.key && inner.persist !== 'memory'
    ? { scope: inner.persist, key: inner.key, version: inner.version, value: inner.value }
    : null
}

/** Called with each persisted atom that changes from plugin code (not from hydration). */
export function watchPersistedAtoms(listener: ((atom: OrcaAtom<unknown>) => void) | null): void {
  onPersistedChange = listener
}

/** Applies stored values for a scope (on boot, or the workspace's after a workspace switch). */
export function hydrateAtoms(
  scope: 'plugin' | 'workspace',
  values: ReadonlyMap<string, OrcaStoredValue>
): void {
  snapshot[scope] = new Map(values)
  for (const target of keyed.values()) {
    const inner = target[ATOM]
    if (inner.persist !== scope) {
      continue
    }
    const hydrated = stored(inner)
    // A key the new snapshot lacks (another workspace, say) goes back to its initial value.
    assign(inner, hydrated.found ? hydrated.value : inner.initial, false)
  }
}
