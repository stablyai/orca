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
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
