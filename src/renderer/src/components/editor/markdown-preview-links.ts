import {
  filesystemPathHrefToFileUri,
  filesystemPathToFileUri,
  fileUriToFilesystemPath
} from '../../../../shared/file-uri-path'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { HttpLinkSourceOwner, OpenHttpLinkOptions } from '@/lib/http-link-routing'

function toFileUrl(filePath: string): string {
  return filesystemPathToFileUri(filePath)
}

export function resolveMarkdownPreviewHref(rawUrl: string, filePath: string): URL | null {
  if (!rawUrl || rawUrl.startsWith('#')) {
    return null
  }

  try {
    if (isWindowsAbsolutePathLike(rawUrl)) {
      // Convert Windows drive paths to file URLs before URL treats the drive letter as a scheme.
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

// Pass platform-modifier + Shift intent to openHttpLink so it applies settings and runtime routing consistently.
export function resolveMarkdownPreviewHttpOpenOptions(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  isMac: boolean,
  worktreeId: string | null,
  sourceOwner: HttpLinkSourceOwner
): OpenHttpLinkOptions {
  if (isMarkdownPreviewSystemBrowserModifier(event, isMac)) {
    return { worktreeId, modifierHeld: true, sourceOwner }
  }
  return { worktreeId, sourceOwner }
}

/** Resolve filesystem image paths relative to the document; external URLs need no local loading. */
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
