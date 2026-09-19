/**
 * The single errno allowlist for "this path is definitively not there".
 *
 * `existsSync` returns `false` for `ENOENT` and for `EPERM`, `EACCES`, `EBUSY`,
 * `EIO`, `UNKNOWN` and every unrecognised code alike, and a `catch` returning a
 * default does the same. Callers that act on absence — deleting a mirror,
 * overwriting a config, clearing a credential — must be able to tell the two
 * apart, and they must all agree on where the line is, so this lives in one
 * place rather than being re-derived per lane.
 *
 * An unknown code is never absence. Mapping the unknown to a verdict is the
 * category error this predicate exists to prevent.
 */
export function isDefinitiveAbsence(error: unknown): boolean {
  const code = readErrnoCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Why the guard rather than a plain `?.code`: this runs inside `catch` blocks
 * that must fail closed, and a `catch` receives whatever was thrown — a string,
 * a Proxy, an object whose `code` is an accessor that throws. Reading the
 * property directly lets that accessor's exception escape the very catch meant
 * to normalise it, so the caller never gets the indeterminate verdict. An
 * unreadable or non-string code is not absence; it is not evidence at all.
 */
function readErrnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  try {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}
