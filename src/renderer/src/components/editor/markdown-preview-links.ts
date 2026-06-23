import {
  filesystemPathHrefToFileUri,
  filesystemPathToFileUri,
  fileUriToFilesystemPath
} from '../../../../shared/file-uri-path'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { OpenHttpLinkOptions } from '@/lib/http-link-routing'

function toFileUrl(filePath: string): string {
  return filesystemPathToFileUri(filePath)
}

export function resolveMarkdownPreviewHref(rawUrl: string, filePath: string): URL | null {
  if (!rawUrl || rawUrl.startsWith('#')) {
    return null
  }

  try {
    if (isWindowsAbsolutePathLike(rawUrl)) {
      // Why: URL treats `C:\...` as a custom `c:` scheme unless we first
      // normalize the drive path into the file URL form markdown previews use.
      return new URL(filesystemPathHrefToFileUri(rawUrl))
    }
    return new URL(rawUrl, toFileUrl(filePath))
  } catch {
    return null
  }
}

export function getMarkdownPreviewLinkTarget(
  rawHref: string | undefined,
  filePath: string
): string | null {
  if (!rawHref) {
    return null
  }

  const resolved = resolveMarkdownPreviewHref(rawHref, filePath)
  if (!resolved) {
    return null
  }

  if (
    resolved.protocol === 'http:' ||
    resolved.protocol === 'https:' ||
    resolved.protocol === 'file:'
  ) {
    return resolved.toString()
  }

  return null
}

export function getMarkdownPreviewImageSrc(
  rawSrc: string | undefined,
  filePath: string
): string | undefined {
  if (!rawSrc) {
    return rawSrc
  }

  const resolved = resolveMarkdownPreviewHref(rawSrc, filePath)
  if (!resolved) {
    return rawSrc
  }

  if (
    resolved.protocol === 'http:' ||
    resolved.protocol === 'https:' ||
    resolved.protocol === 'file:'
  ) {
    return resolved.toString()
  }

  return rawSrc
}

export function getMarkdownPreviewImageOpenTarget(
  rawSrc: string | undefined,
  filePath: string
): URL | null {
  if (!rawSrc) {
    return null
  }

  const resolved = resolveMarkdownPreviewHref(rawSrc, filePath)
  if (!resolved) {
    return null
  }

  if (
    resolved.protocol === 'http:' ||
    resolved.protocol === 'https:' ||
    resolved.protocol === 'file:'
  ) {
    return resolved
  }

  return null
}

export function isMarkdownPreviewOpenModifier(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>,
  isMac: boolean
): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function isMarkdownPreviewSystemBrowserModifier(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  isMac: boolean
): boolean {
  return event.shiftKey && (isMac ? event.metaKey : event.ctrlKey)
}

// Why: Cmd/Ctrl+Shift-click is the escape hatch that forces the OS default
// browser; every other click routes through openHttpLink so the "open links in
// Orca" setting (and remote-runtime state) decides the destination. Mac uses
// metaKey, Linux/Windows use ctrlKey per AGENTS.md.
export function resolveMarkdownPreviewHttpOpenOptions(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  isMac: boolean,
  worktreeId: string | null
): OpenHttpLinkOptions {
  if (isMarkdownPreviewSystemBrowserModifier(event, isMac)) {
    return { forceSystemBrowser: true }
  }
  return { worktreeId }
}

/**
 * Resolves a relative image src against the markdown file path to produce an
 * absolute filesystem path. Returns null for external URLs (http, https, data,
 * blob) that don't need local file loading.
 */
export function resolveImageAbsolutePath(
  rawSrc: string | undefined,
  filePath: string
): string | null {
  if (!rawSrc) {
    return null
  }

  const resolved = resolveMarkdownPreviewHref(rawSrc, filePath)
  if (!resolved || resolved.protocol !== 'file:') {
    return null
  }

  return fileUriToFilesystemPath(resolved)
}

export function fileUrlToAbsolutePath(fileUrl: URL): string | null {
  if (fileUrl.protocol !== 'file:') {
    return null
  }

  return fileUriToFilesystemPath(fileUrl)
}
