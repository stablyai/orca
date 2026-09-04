import type { PersistedUIState } from './persisted-ui-state-types'

// Why a capability rather than Rule 1: `ui.set` params are `.strict()`, so an old host rejects
// the WHOLE batch on one unknown key — sidebar widths and filters riding alongside it are lost.
export const SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY = 'ui.session-grid-fields.v1' as const
// Why its own gate: a host advertising v1 still rejects a key it never knew.
export const SESSION_GRID_WHEEL_TARGET_RUNTIME_CAPABILITY =
  'ui.session-grid-wheel-target.v1' as const
export const SESSION_GRID_VISIBILITY_RUNTIME_CAPABILITY = 'ui.session-grid-visibility.v1' as const

/** Persisted-UI keys a paired client may only send once the host advertises the capability that added them. */
export const HOST_GATED_UI_FIELDS = [
  {
    capability: SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY,
    fields: [
      'sessionsGridPreset',
      'sessionsGridZoom',
      'sessionsGridShowEmpty',
      'sessionsGridFilter',
      'sessionsGridScrollMode',
      'sessionsGridTabOrder'
    ]
  },
  {
    capability: SESSION_GRID_WHEEL_TARGET_RUNTIME_CAPABILITY,
    fields: ['sessionsGridWheelTarget']
  },
  {
    capability: SESSION_GRID_VISIBILITY_RUNTIME_CAPABILITY,
    fields: ['sessionsGridHiddenTabIds', 'sessionsGridStateFilter']
  }
] as const satisfies readonly { capability: string; fields: readonly (keyof PersistedUIState)[] }[]

export type HostGatedUiField = (typeof HOST_GATED_UI_FIELDS)[number]['fields'][number]

const HOST_GATED_UI_FIELD_SET: ReadonlySet<string> = new Set(
  HOST_GATED_UI_FIELDS.flatMap((gate) => gate.fields)
)

export function isHostGatedUiField(key: string): key is HostGatedUiField {
  return HOST_GATED_UI_FIELD_SET.has(key)
}

export function hasHostGatedUiFields(update: object): boolean {
  return Object.keys(update).some(isHostGatedUiField)
}

/**
 * Drop every gated key whose capability the host did not advertise. `capabilities` null means
 * the host could not be asked, which strips too: a silently dropped grid setting beats a rejected batch.
 */
export function omitUnsupportedHostGatedUiFields<T extends object>(
  update: T,
  capabilities: readonly string[] | null | undefined
): Partial<T> {
  const advertised = new Set(capabilities ?? [])
  const unsupported = new Set<string>(
    HOST_GATED_UI_FIELDS.filter((gate) => !advertised.has(gate.capability)).flatMap(
      (gate) => gate.fields
    )
  )
  if (unsupported.size === 0) {
    return update
  }
  return Object.fromEntries(
    Object.entries(update).filter(([key]) => !unsupported.has(key))
  ) as Partial<T>
}
