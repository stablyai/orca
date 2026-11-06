type Stored = { version: number; value: unknown }

const STORED = Symbol.for('orca.testing.stored')
export type StoredValue = { readonly [STORED]: true; version: number; value: unknown }

/** A persisted value written by an older version of the panel, for testing `migrate`. */
export function stored(value: unknown, version: number): StoredValue {
  return Object.freeze({ [STORED]: true as const, version, value })
}

function isStoredValue(value: unknown): value is StoredValue {
  return typeof value === 'object' && value !== null && STORED in value
}

/** Values an earlier run persisted: plain values at version 1, `stored()` ones as given. */
export function seedPersisted(
  storage: Record<'plugin' | 'workspace', Map<string, Stored>>,
  persisted: { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> } | undefined
): void {
  for (const scope of ['plugin', 'workspace'] as const) {
    for (const [key, value] of Object.entries(persisted?.[scope] ?? {})) {
      storage[scope].set(
        key,
        isStoredValue(value)
          ? { version: value.version, value: value.value }
          : { version: 1, value }
      )
    }
  }
}
