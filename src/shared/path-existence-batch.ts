export const PATH_EXISTENCE_BATCH_MAX = 128

export const PATH_EXISTENCE_BATCH_CAPABILITY = 'files.pathsExist'

export type PathExistenceResult = { exists: boolean } | { error: string }

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
