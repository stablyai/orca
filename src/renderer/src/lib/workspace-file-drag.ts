import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  NATIVE_FILE_DROP_MAX_PATH_BYTES,
  NATIVE_FILE_DROP_MAX_PATHS,
  validateNativeFileDropPaths
} from '../../../shared/native-file-drop'
import { measureClipboardTextByteLength } from '../../../shared/clipboard-text'

export const WORKSPACE_FILE_PATH_MIME = 'text/x-orca-file-path'
export const WORKSPACE_FILE_PATHS_MIME = 'text/x-orca-file-paths'

export type WorkspaceFileDragRejectionReason = 'paths-too-large' | 'too-many-paths'

export type WorkspaceFileDragPathsReadResult =
  | { byteLength: number; pathCount: number; paths: string[]; status: 'accepted' }
  | {
      byteLength: number
      pathCount: number
      reason: WorkspaceFileDragRejectionReason
      status: 'rejected'
    }

type NormalizedWorkspaceFilePath = {
  normalizedPath: string
  path: string
}

type WorkspaceFilePathDecodeResult =
  | { pathCount: number; paths: string[]; status: 'accepted' }
  | { pathCount: number; reason: 'too-many-paths'; status: 'rejected' }

export function encodeWorkspaceFilePaths(paths: readonly string[]): string {
  return paths.length === 1 ? paths[0] : JSON.stringify(paths)
}

export function decodeWorkspaceFilePaths(data: string): string[] {
  const result = decodeWorkspaceFilePathPayload(data)
  return result.status === 'accepted' ? result.paths : []
}

function decodeWorkspaceFilePathPayload(
  data: string,
  options: { maxPaths?: number } = {}
): WorkspaceFilePathDecodeResult {
  if (!data) {
    return { pathCount: 0, paths: [], status: 'accepted' }
  }
  try {
    const parsed: unknown = JSON.parse(data)
    if (Array.isArray(parsed)) {
      return collectDecodedWorkspaceFilePaths(parsed, options.maxPaths)
    }
  } catch {
    // Plain path string from legacy single-file drags.
  }
  if (options.maxPaths !== undefined && options.maxPaths < 1) {
    return { pathCount: 1, reason: 'too-many-paths', status: 'rejected' }
  }
  return { pathCount: 1, paths: [data], status: 'accepted' }
}

function collectDecodedWorkspaceFilePaths(
  values: readonly unknown[],
  maxPaths: number | undefined
): WorkspaceFilePathDecodeResult {
  const paths: string[] = []
  let pathCount = 0
  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }
    pathCount += 1
    if (maxPaths === undefined || pathCount <= maxPaths) {
      paths.push(value)
    }
  }
  if (maxPaths !== undefined && pathCount > maxPaths) {
    return { pathCount, reason: 'too-many-paths', status: 'rejected' }
  }
  return { pathCount, paths, status: 'accepted' }
}

function isNormalizedRuntimePathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  if (candidatePath === rootPath) {
    return true
  }
  const rootWithBoundary =
    rootPath === '/' || /^[a-z]:\/$/i.test(rootPath) ? rootPath : `${rootPath.replace(/\/+$/, '')}/`
  return candidatePath.startsWith(rootWithBoundary)
}

function getUniqueWorkspaceFilePathEntries(
  paths: readonly string[]
): NormalizedWorkspaceFilePath[] {
  const uniquePaths: NormalizedWorkspaceFilePath[] = []
  const seenNormalizedPaths = new Set<string>()
  for (const path of paths) {
    if (!path) {
      continue
    }
    const normalizedPath = normalizeRuntimePathForComparison(path)
    if (!seenNormalizedPaths.has(normalizedPath)) {
      seenNormalizedPaths.add(normalizedPath)
      uniquePaths.push({ normalizedPath, path })
    }
  }
  return uniquePaths
}

function getTopLevelWorkspaceFilePaths(paths: readonly string[]): string[] {
  const uniquePaths = getUniqueWorkspaceFilePathEntries(paths)

  // Why: moving a selected folder already moves its descendants; issuing
  // extra moves for selected children races against paths that no longer exist.
  return uniquePaths
    .filter(
      (pathEntry) =>
        !uniquePaths.some(
          (candidateRoot) =>
            candidateRoot.normalizedPath !== pathEntry.normalizedPath &&
            isNormalizedRuntimePathInsideOrEqual(
              candidateRoot.normalizedPath,
              pathEntry.normalizedPath
            )
        )
    )
    .map((pathEntry) => pathEntry.path)
}

export function readWorkspaceFileDragPaths(
  dataTransfer: Pick<DataTransfer, 'getData'>,
  options: {
    maxPathBytes?: number
    maxPaths?: number
  } = {}
): WorkspaceFileDragPathsReadResult {
  const maxPathBytes = options.maxPathBytes ?? NATIVE_FILE_DROP_MAX_PATH_BYTES
  const maxPaths = options.maxPaths ?? NATIVE_FILE_DROP_MAX_PATHS
  const multiPathData = dataTransfer.getData(WORKSPACE_FILE_PATHS_MIME)
  const data = multiPathData || dataTransfer.getData(WORKSPACE_FILE_PATH_MIME)
  if (!data) {
    return { byteLength: 0, pathCount: 0, paths: [], status: 'accepted' }
  }

  const rawMeasurement = measureClipboardTextByteLength(data, { stopAfterBytes: maxPathBytes })
  if (rawMeasurement.exceededLimit) {
    return {
      byteLength: rawMeasurement.byteLength,
      pathCount: 0,
      reason: 'paths-too-large',
      status: 'rejected'
    }
  }

  const decodedPathResult = decodeWorkspaceFilePathPayload(data, { maxPaths })
  if (decodedPathResult.status === 'rejected') {
    return {
      byteLength: 0,
      pathCount: decodedPathResult.pathCount,
      reason: decodedPathResult.reason,
      status: 'rejected'
    }
  }

  const decodedPaths = decodedPathResult.paths
  const validation = validateNativeFileDropPaths(decodedPaths, { maxPathBytes, maxPaths })
  if (validation.status === 'rejected') {
    return {
      byteLength: validation.byteLength,
      pathCount: validation.pathCount,
      reason: validation.reason,
      status: 'rejected'
    }
  }

  const paths = getTopLevelWorkspaceFilePaths(decodedPaths)
  return {
    byteLength: validation.byteLength,
    pathCount: paths.length,
    paths,
    status: 'accepted'
  }
}

export function getWorkspaceFileDragPaths(dataTransfer: Pick<DataTransfer, 'getData'>): string[] {
  const result = readWorkspaceFileDragPaths(dataTransfer)
  return result.status === 'accepted' ? result.paths : []
}

export function getWorkspaceFileDragRejectionMessage(
  reason: WorkspaceFileDragRejectionReason
): string {
  if (reason === 'too-many-paths') {
    return 'Drop contains too many paths.'
  }
  return 'Drop path list is too large.'
}
