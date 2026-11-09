/** Desktop downloads of files and folders that live on a paired runtime host. */
import { blockedPluginSaveAsExtension } from '../plugins/frames/plugin-save-as-extensions'

export type RuntimeDownloadErrorCode =
  | 'canceled'
  | 'not_a_file'
  | 'not_a_directory'
  | 'too_large'
  | 'too_many_entries'
  | 'host_update_required'
  | 'host_busy'
  | 'not_found'
  | 'disconnected'
  | 'open_failed'
  /** "Open on this computer" refuses files the OS would run (scripts, installers, apps). */
  | 'open_refused'
  | 'transfer_failed'

/** Largest file "Open locally" will fetch into the temp cache. */
export const RUNTIME_OPEN_LOCALLY_MAX_BYTES = 1024 * 1024 * 1024

/**
 * Whether Orca may hand a fetched copy straight to the OS opener. The host controls the bytes and the
 * name, so anything Windows or macOS would run on a double-click is only ever saved, never opened.
 */
export function canOpenRuntimeDownloadLocally(name: string): boolean {
  return blockedPluginSaveAsExtension(name) === null
}

export type RuntimeDownloadStartArgs = {
  /** Caller-chosen id; progress events and cancel use it. */
  downloadId: string
  environmentId: string
  worktree: string
  relativePath: string
  /** Display name of the remote entry, used for the suggested local name. */
  name: string
  kind: 'file' | 'folder'
  /** `save` asks where to put it; `open` fetches into a temp cache and opens it. */
  intent: 'save' | 'open'
  excludeDefaultDirs?: boolean
  expectedEnvironmentPairingRevision?: number
}

export type RuntimeDownloadProgressEvent = {
  downloadId: string
  phase: 'preparing' | 'transferring'
  receivedBytes: number
  totalBytes: number | null
  processedBytes: number
  /** Folder downloads: files in the archive, known once the host has listed the folder. */
  fileCount?: number
  /** Present once a save location is chosen. */
  destinationPath?: string
}

export type RuntimeDownloadResult =
  | { status: 'canceled' }
  | {
      status: 'done'
      destinationPath: string
      bytes: number
      /** Folder downloads only. */
      fileCount?: number
      skippedCount?: number
      excludedDirCount?: number
      /** `open` intent: the OS refused to open the fetched file. */
      openError?: string
    }
  | { status: 'error'; code: RuntimeDownloadErrorCode; message: string }
