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
const ENOENT_MESSAGE = /\bENOENT: no such file or directory\b/
const ENOTDIR_MESSAGE = /\bENOTDIR: not a directory\b/
const NO_FILESYSTEM_CODE = Symbol('no-filesystem-code')

function filesystemCode(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string') {
    return code
  }
  const data = (error as { data?: unknown } | null)?.data
  return typeof data === 'object' && data !== null && 'errno' in data
    ? (data as { errno?: unknown }).errno
    : NO_FILESYSTEM_CODE
}

export function isDefinitiveAbsence(error: unknown): boolean {
  return definitiveAbsenceCode(error) !== null
}

function definitiveAbsenceCode(error: unknown): 'ENOENT' | 'ENOTDIR' | null {
  const code = filesystemCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR' ? code : null
}

export function isENOENT(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = filesystemCode(error)
  // Old relays overwrite Node's string code with JSON-RPC's numeric code.
  return code === 'ENOENT' || (code === NO_FILESYSTEM_CODE && ENOENT_MESSAGE.test(error.message))
}

export function isDefinitiveAbsenceFromRelay(error: unknown): boolean {
  if (isDefinitiveAbsence(error)) {
    return true
  }
  if (!(error instanceof Error) || filesystemCode(error) !== NO_FILESYSTEM_CODE) {
    return false
  }
  return ENOENT_MESSAGE.test(error.message) || ENOTDIR_MESSAGE.test(error.message)
}
