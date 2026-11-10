import { routeNativeChatHref } from '../../../../../../shared/native-chat/native-chat-href-routing'
import type { NativeChatHrefRoute } from '../../../../../../shared/native-chat/native-chat-href-routing'
import { WINDOWS_DRIVE_PATH_PREFIX } from '../../../../../../shared/file-links/file-uri-path'
import { normalizeAbsolutePath } from '../../../../../../shared/file-links/file-link-path-normalization'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget,
  resolveExplicitFileLinkTargetPath
} from '../../../../../../shared/file-links/explicit-file-link-target'
import type { NativeChatFileLinkContext } from './native-chat-file-link-context'

export type NativeChatResolvedFileLink = {
  absolutePath: string
  line: number | null
  column: number | null
}

function resolvePathText(
  pathText: string,
  fallbackLine: number | null,
  context: NativeChatFileLinkContext
): NativeChatResolvedFileLink | null {
  const parsed = parseExplicitFileLinkTarget(pathText, { allowRelativeDirectoryPath: true })
  if (!parsed) {
    return null
  }
  // Explicit agent-authored hrefs bypass automatic terminal-detection filename filters.
  const resolved = resolveExplicitFileLinkTarget(parsed, context.worktreePath)
  if (!resolved) {
    return null
  }
  return {
    absolutePath: resolved.absolutePath,
    line: resolved.line ?? fallbackLine,
    column: resolved.column
  }
}

// Chats open a drive-letter workspace as native Windows (no WSL mapping), so URL-style /D:/… there is D:.
function routeNativeChatFileHref(
  href: string | undefined,
  worktreePath: string
): NativeChatHrefRoute {
  const route = routeNativeChatHref(href)
  return route.kind === 'file' &&
    WINDOWS_DRIVE_PATH_PREFIX.test(route.pathText) &&
    normalizeAbsolutePath(worktreePath)?.rootKind === 'windows'
    ? { ...route, pathText: route.pathText.slice(1) }
    : route
}

export function resolveNativeChatFileLink(
  href: string | undefined,
  context: NativeChatFileLinkContext | null
): NativeChatResolvedFileLink | null {
  if (!context) {
    return null
  }
  const route = routeNativeChatFileHref(href, context.worktreePath)
  if (route.kind !== 'file') {
    return null
  }
  if (route.pathKind === 'literal') {
    const absolutePath = resolveExplicitFileLinkTargetPath(route.pathText, context.worktreePath)
    return absolutePath ? { absolutePath, line: null, column: null } : null
  }
  return resolvePathText(route.pathText, route.line, context)
}
