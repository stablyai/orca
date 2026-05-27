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

export function getWorkspaceFileDragPaths(dataTransfer: Pick<DataTransfer, 'getData'>): string[] {
  const multiPathData = dataTransfer.getData(WORKSPACE_FILE_PATHS_MIME)
  if (multiPathData) {
    return decodeWorkspaceFilePaths(multiPathData)
  }
  return decodeWorkspaceFilePaths(dataTransfer.getData(WORKSPACE_FILE_PATH_MIME))
}
