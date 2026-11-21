import type { FilesystemPathFlavor } from '../file-access/filesystem-path-flavor'
import type { DirEntry } from './directory-entry'

export type HostDirectoryListing = {
  resolvedPath: string
  entries: DirEntry[]
  pathFlavor: FilesystemPathFlavor
}

/** Host-mode Explorer clicks: classification only; external files open read-only as user-named files. */
export type HostBrowseEntryResolution = {
  kind: 'directory' | 'file' | 'unsupported'
  realPath: string
  /** Canonical path relative to the canonical workspace root, or null when outside it. */
  workspaceRelativePath: string | null
}
