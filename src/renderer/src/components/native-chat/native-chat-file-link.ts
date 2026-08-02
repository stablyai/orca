import { fileUriToFilesystemPath } from '../../../../shared/file-uri-path'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { Worktree } from '../../../../shared/types'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget
} from '@/lib/explicit-file-link-target'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'

export type NativeChatFileLinkContext = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
}

export type NativeChatResolvedFileLink = {
  absolutePath: string
  line: number | null
  column: number | null
}

type NativeChatFileLinkState = Pick<
  AppState,
  | 'folderWorkspaces'
  | 'getKnownWorktreeById'
  | 'projectGroups'
  | 'repos'
  | 'settings'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
>

export function findTerminalTabWorktreeId(
  tabsByWorktree: NativeChatFileLinkState['tabsByWorktree'],
  terminalTabId: string
): string | null {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    // Why: tabsByWorktree stores TerminalTab records; unified tabs carry
    // entityId, but the terminal owner lookup must use the backing tab id.
    if (tabs.some((tab) => tab.id === terminalTabId)) {
      return worktreeId
    }
  }
  return null
}

function findWorktreeFallback(
  worktreesByRepo: NativeChatFileLinkState['worktreesByRepo'],
  worktreeId: string
): Pick<Worktree, 'id' | 'path'> | null {
  for (const worktrees of Object.values(worktreesByRepo)) {
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    if (worktree) {
      return worktree
    }
  }
  return null
}

export function resolveNativeChatFileLinkContext(
  state: NativeChatFileLinkState,
  terminalTabId: string
): NativeChatFileLinkContext | null {
  const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  if (!worktreeId) {
    return null
  }

  const knownWorktree = state.getKnownWorktreeById(worktreeId)
  const worktree = knownWorktree?.path
    ? knownWorktree
    : findWorktreeFallback(state.worktreesByRepo, worktreeId)
  if (!worktree?.path) {
    return null
  }

  return {
    worktreeId,
    worktreePath: worktree.path,
    runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  }
}

function maybeDecodeHrefPath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stripQueryAndHash(value: string): { pathText: string; line: number | null } {
  const hashIndex = value.indexOf('#')
  const queryIndex = value.indexOf('?')
  const suffixIndex =
    hashIndex === -1 ? queryIndex : queryIndex === -1 ? hashIndex : Math.min(hashIndex, queryIndex)
  const pathText = suffixIndex === -1 ? value : value.slice(0, suffixIndex)
  const hash =
    hashIndex === -1
      ? ''
      : value.slice(hashIndex + 1, queryIndex > hashIndex ? queryIndex : undefined)
  const line = parseLineFragment(hash)
  return { pathText, line }
}

function parseLineFragment(hash: string): number | null {
  if (!hash) {
    return null
  }
  let decoded = hash
  try {
    decoded = decodeURIComponent(hash)
  } catch {
    decoded = hash
  }
  const match = /^(?:L|line-?)([1-9]\d*)\b/i.exec(decoded)
  return match ? Number.parseInt(match[1], 10) : null
}

function hasNonFileUriProtocol(value: string): boolean {
  if (isWindowsAbsolutePathLike(value)) {
    return false
  }
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(value)
  return Boolean(match && match[0].toLowerCase() !== 'file:')
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
  // Native chat hrefs are explicit agent-authored links, so avoid the terminal
  // detector's conservative extension/filename filters.
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

function resolveFileUriLink(
  href: string,
  context: NativeChatFileLinkContext
): NativeChatResolvedFileLink | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'file:') {
    return null
  }
  const filePath = fileUriToFilesystemPath(url)
  if (!filePath) {
    return null
  }
  return resolvePathText(filePath, parseLineFragment(url.hash.replace(/^#/, '')), context)
}

export function resolveNativeChatFileLink(
  href: string | undefined,
  context: NativeChatFileLinkContext | null
): NativeChatResolvedFileLink | null {
  const rawHref = href?.trim()
  if (!rawHref || rawHref.startsWith('#') || !context) {
    return null
  }

  if (rawHref.toLowerCase().startsWith('file:')) {
    return resolveFileUriLink(rawHref, context)
  }
  if (hasNonFileUriProtocol(rawHref)) {
    return null
  }

  const { pathText, line } = stripQueryAndHash(rawHref)
  const decodedPathText = maybeDecodeHrefPath(pathText)
  return resolvePathText(decodedPathText, line, context)
}
