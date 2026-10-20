export const REPOSITORY_ADD_SCRIPT_MAX_LENGTH = 64 * 1024

/**
 * The script to store: exact valid text, `undefined` for unconfigured (absent, empty or blank),
 * or `null` when the value is not a string within the bound.
 */
export function normalizeStoredRepositoryAddScript(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.length > REPOSITORY_ADD_SCRIPT_MAX_LENGTH) {
    return null
  }
  return value.trim() === '' ? undefined : value
}

/** Stored form of a written script; an invalid write throws so it can never replace the configured one. */
export function normalizeRepositoryAddScriptUpdate(value: unknown): string | undefined {
  const script = normalizeStoredRepositoryAddScript(value)
  if (script === null) {
    throw new Error(
      `Repository add script must be text of at most ${REPOSITORY_ADD_SCRIPT_MAX_LENGTH} characters`
    )
  }
  return script
}
