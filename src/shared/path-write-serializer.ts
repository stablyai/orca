// Serialize atomic publications per resolved path; callers must use the same path spelling.
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
