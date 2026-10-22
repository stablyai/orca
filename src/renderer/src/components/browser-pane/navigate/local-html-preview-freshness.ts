import { documentResourceAccess, userNamedFileAccess } from '@/lib/local-file-access'
import { normalizeRuntimePathForComparison } from '../../../../../shared/cross-platform-path'
import { isHtmlFilePath } from '../../../../../shared/html-file-url'
import type { LocalFileAccess } from '../../../../../shared/local-file-access'
import { browserFileUrlToAbsolutePath } from '../describe-page/browser-artifact-upload'
import { reloadBrowserPageWebview } from './browser-reload-action'

type FileRevision = { size: number; mtime: number }
type LoadedFile = { filePath: string; revision: Promise<FileRevision | null> }

const loadedFiles = new WeakMap<Electron.WebviewTag, LoadedFile>()

async function readFileRevision(
  filePath: string,
  access: LocalFileAccess = documentResourceAccess(filePath)
): Promise<FileRevision | null> {
  try {
    const stat = await window.api.fs.stat({
      filePath,
      access
    })
    return stat.isDirectory ? null : { size: stat.size, mtime: stat.mtime }
  } catch {
    return null
  }
}

export function recordLocalHtmlPreviewNavigation(
  webview: Electron.WebviewTag,
  event: Pick<Electron.DidStartNavigationEvent, 'isMainFrame' | 'isInPlace' | 'url'>
): void {
  if (!event.isMainFrame || event.isInPlace) {
    return
  }
  const filePath = browserFileUrlToAbsolutePath(event.url)
  if (!filePath || !isHtmlFilePath(filePath)) {
    loadedFiles.delete(webview)
    return
  }
  const previous = loadedFiles.get(webview)
  const previousRevision =
    previous &&
    normalizeRuntimePathForComparison(previous.filePath) ===
      normalizeRuntimePathForComparison(filePath)
      ? previous.revision
      : null
  loadedFiles.set(webview, {
    filePath,
    revision: readFileRevision(filePath).then((revision) => revision ?? previousRevision)
  })
}

/** Explicit file opens refresh changed disk contents while unchanged pages keep their UI state. */
export async function refreshLocalHtmlPreview(
  webview: Electron.WebviewTag,
  filePath: string
): Promise<void> {
  const loaded = loadedFiles.get(webview)
  if (
    !loaded ||
    normalizeRuntimePathForComparison(loaded.filePath) !==
      normalizeRuntimePathForComparison(filePath)
  ) {
    return
  }
  const [previous, current] = await Promise.all([
    loaded.revision,
    readFileRevision(filePath, userNamedFileAccess())
  ])
  if (
    loadedFiles.get(webview) !== loaded ||
    !current ||
    (previous && previous.size === current.size && previous.mtime === current.mtime)
  ) {
    return
  }
  const refreshed = { filePath, revision: Promise.resolve(current) }
  loadedFiles.set(webview, refreshed)
  if (
    reloadBrowserPageWebview(webview, { ignoreCache: true }) !== 'reloaded' &&
    loadedFiles.get(webview) === refreshed
  ) {
    loadedFiles.set(webview, loaded)
  }
}
