import { win32 } from 'node:path'

type WatchedDirectoryDeletionCheck = (eventType: string, fileName: string | null) => boolean

// libuv before 1.53 reports a deleted watched directory as ('rename', <namespaced watch path>) and re-arms
// ReadDirectoryChangesW in a tight loop until the watcher closes. Child events always carry relative names.
export function watchedDirectoryDeletionCheck(
  directoryPath: string,
  platform: NodeJS.Platform = process.platform
): WatchedDirectoryDeletionCheck {
  if (platform !== 'win32') {
    return () => false
  }
  // Node hands libuv toNamespacedPath(path), which libuv echoes back unchanged.
  const watchedPath = win32.toNamespacedPath(directoryPath)
  return (eventType, fileName) => eventType === 'rename' && fileName === watchedPath
}
