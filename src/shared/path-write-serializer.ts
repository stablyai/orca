// Why: an atomic publish is write-tmp → fsync → rename, three awaits wide once it is async. Two
// concurrent writers on one destination can interleave those steps and publish a payload that is
// neither writer's — the one hazard the sync→async conversion introduces. Writes to a given final
// path therefore run one at a time, in call order.
// ponytail: keyed on the literal path string, so two spellings of one file (symlink, `..`) do not
// share a lane; every caller here builds the path from the same resolver, and realpath() would add
// a syscall to the fast path it exists to protect.
const pendingByPath = new Map<string, Promise<void>>()

export async function serializePathWrite<T>(
  finalPath: string,
  write: () => Promise<T>
): Promise<T> {
  const previous = pendingByPath.get(finalPath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingByPath.set(finalPath, current)

  await previous
  try {
    return await write()
  } finally {
    release()
    if (pendingByPath.get(finalPath) === current) {
      pendingByPath.delete(finalPath)
    }
  }
}

/** Why exposed: map deletion is the only thing keeping this from being a per-path leak. */
export function pendingPathWriteCountForTests(): number {
  return pendingByPath.size
}

/** Test seam for the fire-and-forget callers (`markEnvironmentUsedDetached`), which have no handle
 *  to await before reading the file back. */
export async function settlePathWritesForTests(): Promise<void> {
  while (pendingByPath.size > 0) {
    await Promise.all(pendingByPath.values())
  }
}
