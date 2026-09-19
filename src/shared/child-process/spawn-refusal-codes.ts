/**
 * The kernel-level "I would not fork/exec that" codes, held once.
 *
 * Why shared: ripgrep availability and crash reporting both have to tell a host
 * that refused to create a process from a program that is simply missing, and
 * two copies of the same libuv fact drift.
 */

export type SpawnRefusalReason =
  | 'fork-eagain'
  | 'descriptors-exhausted'
  | 'not-enough-memory'
  | 'image-busy'

const SPAWN_REFUSAL_REASON_BY_CODE: Readonly<Record<string, SpawnRefusalReason>> = {
  EAGAIN: 'fork-eagain',
  EMFILE: 'descriptors-exhausted',
  ENFILE: 'descriptors-exhausted',
  ENOMEM: 'not-enough-memory',
  ETXTBSY: 'image-busy'
}

/** The libuv `code` on a failed spawn, when it carries one. */
export function spawnErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  return typeof error.code === 'string' ? error.code : undefined
}

/** Undefined for anything that is not the host refusing to create a process. */
export function spawnRefusalReason(error: unknown): SpawnRefusalReason | undefined {
  const code = spawnErrorCode(error)
  return code === undefined ? undefined : SPAWN_REFUSAL_REASON_BY_CODE[code]
}
