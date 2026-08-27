export type EditorTextDirection = 'ltr' | 'auto' | 'rtl'
/** Per-file overrides are explicit only; 'auto' stays a global default so a toggle never lands on it. */
export type EditorTextDirectionOverride = 'ltr' | 'rtl'

export function isEditorTextDirection(value: unknown): value is EditorTextDirection {
  return value === 'ltr' || value === 'auto' || value === 'rtl'
}

export function isEditorTextDirectionOverride(
  value: unknown
): value is EditorTextDirectionOverride {
  return value === 'ltr' || value === 'rtl'
}

export function resolveEditorTextDirection(
  globalDefault: EditorTextDirection | undefined,
  perFileOverride: EditorTextDirectionOverride | undefined
): EditorTextDirection {
  // Why: profiles saved before this preference existed must keep Orca's LTR-only behavior.
  return perFileOverride ?? (isEditorTextDirection(globalDefault) ? globalDefault : 'ltr')
}

/** Toggling from 'auto' commits to 'rtl', since a user reaching for the toggle wants the RTL case. */
export function nextEditorTextDirectionOverride(
  resolved: EditorTextDirection
): EditorTextDirectionOverride {
  return resolved === 'rtl' ? 'ltr' : 'rtl'
}
