export const PATH_EXISTENCE_BATCH_MAX = 128
export const PATH_EXISTENCE_BATCH_CAPABILITY = 'files.pathsExist'
export type PathExistenceResult = { exists: boolean } | { error: string }
/** The desktop shell batch: a boolean per answered path, an error for one it refused. */
export type ShellPathExistence = boolean | { error: string }

export function validatePathExistenceBatch(paths: unknown): asserts paths is string[] {
  if (
    !Array.isArray(paths) ||
    paths.length > PATH_EXISTENCE_BATCH_MAX ||
    paths.some((path) => typeof path !== 'string')
  ) {
    throw new Error('Invalid path existence batch')
  }
}

export async function capturePathExistence(
  check: () => Promise<boolean>
): Promise<PathExistenceResult> {
  try {
    return { exists: await check() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function requirePathExistenceResults(value: unknown, count: number): PathExistenceResult[] {
  if (!Array.isArray(value) || value.length !== count) {
    throw new Error('Invalid path existence response')
  }
  return value.map((row: unknown): PathExistenceResult => {
    if (row && typeof row === 'object') {
      if ('exists' in row && typeof row.exists === 'boolean' && !('error' in row)) {
        return { exists: row.exists }
      }
      if ('error' in row && typeof row.error === 'string' && !('exists' in row)) {
        return { error: row.error }
      }
    }
    throw new Error('Invalid path existence response')
  })
}

type PendingPath = {
  path: string
  resolve: (exists: boolean) => void
  reject: (error: unknown) => void
  promise: Promise<boolean>
}

/** Paths asked in one microtask share a host request per group, chunked to the batch limit; nothing is cached. */
export function createPathExistenceBatch<Group>({
  groupKey,
  run
}: {
  groupKey: (group: Group) => string
  run: (group: Group, paths: string[]) => Promise<PathExistenceResult[]>
}): (group: Group, path: string) => Promise<boolean> {
  const groups = new Map<string, { group: Group; paths: Map<string, PendingPath> }>()
  let queued = false

  const runChunk = async (group: Group, pending: PendingPath[]): Promise<void> => {
    try {
      const results = await run(
        group,
        pending.map((row) => row.path)
      )
      if (results.length !== pending.length) {
        throw new Error('Invalid path existence response')
      }
      results.forEach((result, index) => {
        if ('exists' in result) {
          pending[index].resolve(result.exists)
        } else {
          pending[index].reject(new Error(result.error))
        }
      })
    } catch (error) {
      pending.forEach((row) => row.reject(error))
    }
  }

  const flush = async (): Promise<void> => {
    const ready = [...groups.values()]
    groups.clear()
    queued = false
    await Promise.all(
      ready.flatMap(({ group, paths }) => {
        const pending = [...paths.values()]
        return Array.from(
          { length: Math.ceil(pending.length / PATH_EXISTENCE_BATCH_MAX) },
          (_, i) =>
            runChunk(
              group,
              pending.slice(i * PATH_EXISTENCE_BATCH_MAX, (i + 1) * PATH_EXISTENCE_BATCH_MAX)
            )
        )
      })
    )
  }

  return (group, path) => {
    const key = groupKey(group)
    let entry = groups.get(key)
    if (!entry) {
      entry = { group, paths: new Map() }
      groups.set(key, entry)
    }
    const existing = entry.paths.get(path)
    if (existing) {
      return existing.promise
    }
    let resolve!: (exists: boolean) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<boolean>((yes, no) => {
      resolve = yes
      reject = no
    })
    entry.paths.set(path, { path, resolve, reject, promise })
    if (!queued) {
      queued = true
      queueMicrotask(() => {
        void flush()
      })
    }
    return promise
  }
}
