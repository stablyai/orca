import { measureClipboardTextByteLength } from './clipboard-text'

export const ORCA_INTERNAL_FILE_DRAG_TYPE = 'text/x-orca-file-path'

export const NATIVE_FILE_DROP_MAX_PATHS = 256
export const NATIVE_FILE_DROP_MAX_PATH_BYTES = 256 * 1024

export const NATIVE_FILE_DROP_TARGET = {
  editor: 'editor',
  terminal: 'terminal',
  composer: 'composer',
  fileExplorer: 'file-explorer',
  projectSidebar: 'project-sidebar'
} as const

export type NativeDropResolution =
  | { target: typeof NATIVE_FILE_DROP_TARGET.editor }
  | { target: typeof NATIVE_FILE_DROP_TARGET.terminal; tabId?: string; paneLeafId?: string }
  | { target: typeof NATIVE_FILE_DROP_TARGET.composer }
  | { target: typeof NATIVE_FILE_DROP_TARGET.fileExplorer; destinationDir: string }
  | { target: typeof NATIVE_FILE_DROP_TARGET.projectSidebar }
  | { target: 'rejected' }

export type NativeFileDropPayload =
  | { paths: string[]; target: typeof NATIVE_FILE_DROP_TARGET.editor }
  | {
      paths: string[]
      target: typeof NATIVE_FILE_DROP_TARGET.terminal
      tabId?: string
      paneLeafId?: string
    }
  | { paths: string[]; target: typeof NATIVE_FILE_DROP_TARGET.composer }
  | {
      paths: string[]
      target: typeof NATIVE_FILE_DROP_TARGET.fileExplorer
      destinationDir: string
    }
  | { paths: string[]; target: typeof NATIVE_FILE_DROP_TARGET.projectSidebar }
  | NativeFileDropRejectedPayload

export type NativeFileDropRejectedPayload = {
  byteLength: number
  pathCount: number
  reason: 'paths-too-large' | 'too-many-paths'
  target: 'rejected'
}

export type NativeFileDropPathEntry = {
  nativeFileDropTarget?: string
  nativeFileDropDir?: string
  terminalTabId?: string
  terminalPaneLeafId?: string
}

export type NativeFileDropPathValidation =
  | { byteLength: number; pathCount: number; status: 'accepted' }
  | {
      byteLength: number
      pathCount: number
      reason: NativeFileDropRejectedPayload['reason']
      status: 'rejected'
    }

function isNativeFileDropRejectedReason(
  reason: unknown
): reason is NativeFileDropRejectedPayload['reason'] {
  return reason === 'paths-too-large' || reason === 'too-many-paths'
}

function isNativeFileDropTarget(target: unknown): target is NativeFileDropPayload['target'] {
  return Object.values(NATIVE_FILE_DROP_TARGET).includes(target as never) || target === 'rejected'
}

function isOptionalNativeFileDropString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isNativeFileDropPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((path) => typeof path === 'string')
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function getDataTransferTypes(
  types: Iterable<string> | ArrayLike<string> | null | undefined
): string[] {
  return types ? Array.from(types) : []
}

export function hasNativeFileDragTypes(
  types: Iterable<string> | ArrayLike<string> | null | undefined
): boolean {
  const values = getDataTransferTypes(types)
  return values.includes('Files') && !values.includes(ORCA_INTERNAL_FILE_DRAG_TYPE)
}

export function resolveNativeFileDropPath(
  path: readonly NativeFileDropPathEntry[]
): NativeDropResolution | null {
  let foundExplorer = false
  let destinationDir: string | undefined
  let terminalPaneLeafId: string | undefined

  for (const entry of path) {
    terminalPaneLeafId ??= entry.terminalPaneLeafId
    const target = entry.nativeFileDropTarget
    if (target === NATIVE_FILE_DROP_TARGET.terminal) {
      return { target, tabId: entry.terminalTabId, paneLeafId: terminalPaneLeafId }
    }
    if (target === NATIVE_FILE_DROP_TARGET.editor || target === NATIVE_FILE_DROP_TARGET.composer) {
      return { target }
    }
    if (target === NATIVE_FILE_DROP_TARGET.projectSidebar) {
      return { target }
    }
    if (target === NATIVE_FILE_DROP_TARGET.fileExplorer) {
      foundExplorer = true
    }

    // Pick the nearest (innermost) destination directory marker.
    if (destinationDir === undefined && entry.nativeFileDropDir) {
      destinationDir = entry.nativeFileDropDir
    }
  }

  if (foundExplorer) {
    if (!destinationDir) {
      return { target: 'rejected' }
    }
    return { target: NATIVE_FILE_DROP_TARGET.fileExplorer, destinationDir }
  }

  return null
}

export function measureNativeFileDropPathBytes(paths: readonly string[]): number {
  let byteLength = 0
  for (const path of paths) {
    byteLength += measureClipboardTextByteLength(path).byteLength
  }
  return byteLength
}

export function validateNativeFileDropPaths(
  paths: readonly string[],
  options: {
    maxPathBytes?: number
    maxPaths?: number
  } = {}
): NativeFileDropPathValidation {
  const pathCount = paths.length
  const maxPaths = options.maxPaths ?? NATIVE_FILE_DROP_MAX_PATHS
  if (pathCount > maxPaths) {
    return {
      byteLength: 0,
      pathCount,
      reason: 'too-many-paths',
      status: 'rejected'
    }
  }

  const maxPathBytes = options.maxPathBytes ?? NATIVE_FILE_DROP_MAX_PATH_BYTES
  let byteLength = 0
  for (const path of paths) {
    const measurement = measureClipboardTextByteLength(path, {
      stopAfterBytes: maxPathBytes - byteLength
    })
    byteLength += measurement.byteLength
    if (byteLength > maxPathBytes) {
      return {
        byteLength,
        pathCount,
        reason: 'paths-too-large',
        status: 'rejected'
      }
    }
  }

  return { byteLength, pathCount, status: 'accepted' }
}

export function createRejectedNativeFileDropPayload(
  validation: Extract<NativeFileDropPathValidation, { status: 'rejected' }>
): NativeFileDropRejectedPayload {
  return {
    byteLength: validation.byteLength,
    pathCount: validation.pathCount,
    reason: validation.reason,
    target: 'rejected'
  }
}

export function createNativeFileDropPayload(
  resolution: NativeDropResolution | null,
  paths: readonly string[]
): NativeFileDropPayload | null {
  const validation = validateNativeFileDropPaths(paths)
  if (validation.status === 'rejected') {
    return createRejectedNativeFileDropPayload(validation)
  }

  if (resolution?.target === 'rejected') {
    return null
  }

  if (resolution?.target === NATIVE_FILE_DROP_TARGET.fileExplorer) {
    return {
      paths: [...paths],
      target: NATIVE_FILE_DROP_TARGET.fileExplorer,
      destinationDir: resolution.destinationDir
    }
  }

  const target = resolution?.target ?? NATIVE_FILE_DROP_TARGET.editor
  if (resolution?.target === NATIVE_FILE_DROP_TARGET.terminal) {
    return {
      paths: [...paths],
      target: resolution.target,
      ...(resolution.tabId ? { tabId: resolution.tabId } : {}),
      ...(resolution.paneLeafId ? { paneLeafId: resolution.paneLeafId } : {})
    }
  }

  return { paths: [...paths], target }
}

export function isNativeFileDropPayload(value: unknown): value is NativeFileDropPayload {
  if (!value || typeof value !== 'object') {
    return false
  }
  const payload = value as Record<string, unknown>
  const { target } = payload
  if (!isNativeFileDropTarget(target)) {
    return false
  }

  if (target === 'rejected') {
    return (
      isNonNegativeFiniteNumber(payload.byteLength) &&
      isNonNegativeFiniteNumber(payload.pathCount) &&
      isNativeFileDropRejectedReason(payload.reason)
    )
  }

  if (!isNativeFileDropPathList(payload.paths)) {
    return false
  }
  if (validateNativeFileDropPaths(payload.paths).status !== 'accepted') {
    return false
  }

  if (target === NATIVE_FILE_DROP_TARGET.terminal) {
    return (
      isOptionalNativeFileDropString(payload.tabId) &&
      isOptionalNativeFileDropString(payload.paneLeafId)
    )
  }
  if (target === NATIVE_FILE_DROP_TARGET.fileExplorer) {
    return typeof payload.destinationDir === 'string'
  }

  return (
    target === NATIVE_FILE_DROP_TARGET.editor ||
    target === NATIVE_FILE_DROP_TARGET.composer ||
    target === NATIVE_FILE_DROP_TARGET.projectSidebar
  )
}
