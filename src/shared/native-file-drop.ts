export const ORCA_INTERNAL_FILE_DRAG_TYPE = 'text/x-orca-file-path'

export const NATIVE_FILE_DROP_TARGET = {
  editor: 'editor',
  terminal: 'terminal',
  composer: 'composer',
  fileExplorer: 'file-explorer',
  projectSidebar: 'project-sidebar'
} as const

export type NativeFileDropTarget =
  (typeof NATIVE_FILE_DROP_TARGET)[keyof typeof NATIVE_FILE_DROP_TARGET]

export type NativeDropResolution =
  | { target: typeof NATIVE_FILE_DROP_TARGET.editor }
  | { target: typeof NATIVE_FILE_DROP_TARGET.terminal; tabId?: string }
  | { target: typeof NATIVE_FILE_DROP_TARGET.composer }
  | { target: typeof NATIVE_FILE_DROP_TARGET.fileExplorer; destinationDir: string }
  | { target: typeof NATIVE_FILE_DROP_TARGET.projectSidebar }
  | { target: 'rejected' }

export type NativeFileDropPayload =
  | { paths: string[]; target: typeof NATIVE_FILE_DROP_TARGET.editor }
  | { paths: string[]; target: typeof NATIVE_FILE_DROP_TARGET.terminal; tabId?: string }
  | { paths: string[]; target: typeof NATIVE_FILE_DROP_TARGET.composer }
  | {
      paths: string[]
      target: typeof NATIVE_FILE_DROP_TARGET.fileExplorer
      destinationDir: string
    }
  | { paths: string[]; target: typeof NATIVE_FILE_DROP_TARGET.projectSidebar }

export type NativeFileDropPathEntry = {
  nativeFileDropTarget?: string
  nativeFileDropDir?: string
  terminalTabId?: string
}

export function getDataTransferTypes(
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

  for (const entry of path) {
    const target = entry.nativeFileDropTarget
    if (target === NATIVE_FILE_DROP_TARGET.terminal) {
      return { target, tabId: entry.terminalTabId }
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
