import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../shared/cross-platform-path'

export const WORKSPACE_FILE_PATH_MIME = 'text/x-orca-file-path'
export const WORKSPACE_FILE_PATHS_MIME = 'text/x-orca-file-paths'

export function encodeWorkspaceFilePaths(paths: readonly string[]): string {
  return paths.length === 1 ? paths[0] : JSON.stringify(paths)
}

export function decodeWorkspaceFilePaths(data: string): string[] {
  if (!data) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(data)
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string')
    }
  } catch {
    // Plain path string from legacy single-file drags.
  }
  return [data]
}

function getTopLevelWorkspaceFilePaths(paths: readonly string[]): string[] {
  const uniquePaths: string[] = []
  for (const path of paths) {
    if (
      path &&
      !uniquePaths.some(
        (existing) =>
          normalizeRuntimePathForComparison(existing) === normalizeRuntimePathForComparison(path)
      )
    ) {
      uniquePaths.push(path)
    }
  }

  // Why: moving a selected folder already moves its descendants; issuing
  // extra moves for selected children races against paths that no longer exist.
  return uniquePaths.filter(
    (path) =>
      !uniquePaths.some(
        (candidateRoot) =>
          candidateRoot !== path &&
          normalizeRuntimePathForComparison(candidateRoot) !==
            normalizeRuntimePathForComparison(path) &&
          isPathInsideOrEqual(candidateRoot, path)
      )
  )
}

export function getWorkspaceFileDragPaths(dataTransfer: Pick<DataTransfer, 'getData'>): string[] {
  const multiPathData = dataTransfer.getData(WORKSPACE_FILE_PATHS_MIME)
  if (multiPathData) {
    return getTopLevelWorkspaceFilePaths(decodeWorkspaceFilePaths(multiPathData))
  }
  return getTopLevelWorkspaceFilePaths(
    decodeWorkspaceFilePaths(dataTransfer.getData(WORKSPACE_FILE_PATH_MIME))
  )
}
