import { useAppStore } from '@/store'
import {
  isPathInsideWorktree,
  resolveTerminalFileLink,
  type ParsedTerminalFileLink,
  type ResolvedTerminalFileLink
} from '../../../../shared/terminal/links/terminal-links'
import { normalizeAbsolutePath } from '../../../../shared/file-links/file-link-path-normalization'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { isRemoteRuntimeFileOperation } from '@/runtime/runtime-file-routing'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  terminalLinkWslDistro,
  terminalPathWslDistro,
  type TerminalFileContext
} from './terminal-file-path-mapping'
import type { createTerminalPathExistenceBatch } from './terminal-path-existence-batch'
import {
  getTerminalPathExistsCacheKey,
  readTerminalPathExistence,
  writeTerminalPathExistence,
  startTerminalPathExistsProbe,
  type TerminalPathExistsCache
} from './terminal-path-exists-cache'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import {
  hostFileLinkTargetExists,
  isHostPathOutsideWorkspace
} from './terminal-host-file-link-existence'

/** Where detected path text resolves and is checked: a terminal pane's or a chat's folder. */
export type FileLinkHost = {
  cwd: string | null
  homePath?: string | null
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  /** A terminal's host expands its own `~`; chats still resolve it here. */
  homeOnHost?: boolean
}

export type FileLinkTarget = {
  /** The host path after WSL mapping; both the existence check and the open use it. */
  absolutePath: string
  line: number | null
  column: number | null
  fileContext: TerminalFileContext
  isRemoteRuntimePath: boolean
  cacheKey: string
  isKnownWorktreeRoot: boolean
  /** A folder link only its host can expand, such as `~/proj/`: it links only to a workspace root. */
  hostWorkspaceRootOnly?: true
}

export type FileLinkPathExistence = ReturnType<typeof createTerminalPathExistenceBatch>

/** Without the pane's own HOME, a paired server's home beats a guess from the cwd, which can name another user's file. WSL and SSH homes stay client-expanded: the server knows neither. */
function hostExpandsTilde(
  pathText: string,
  host: FileLinkHost,
  connectionId: string | null | undefined
): boolean {
  return (
    /^~[\\/]/.test(pathText) &&
    host.homeOnHost === true &&
    !host.homePath &&
    Boolean(host.runtimeEnvironmentId) &&
    !connectionId &&
    !parseWslUncPath(host.worktreePath)
  )
}

/** Detected path text to the path to check; a paired terminal's `~` stays for its host to expand. */
export function resolveFileLinkPath(
  parsed: ParsedTerminalFileLink,
  host: FileLinkHost,
  connectionId = getTerminalFileContext(
    host.worktreeId,
    host.worktreePath,
    host.runtimeEnvironmentId
  ).connectionId
): ResolvedTerminalFileLink | null {
  if (hostExpandsTilde(parsed.pathText, host, connectionId)) {
    // Why: hosts join what follows `~/` onto home, so a doubled separator would make it absolute.
    const homeRelative = parsed.pathText.replace(/^(~[\\/])[\\/]+/, '$1')
    return { absolutePath: homeRelative, line: parsed.line, column: parsed.column }
  }
  return host.cwd ? resolveTerminalFileLink(parsed, host.cwd, host.homePath) : null
}

/** Detected path text to the host path it names; null when it cannot be a link. */
export function resolveFileLinkTarget(
  parsed: ParsedTerminalFileLink,
  host: FileLinkHost
): FileLinkTarget | null {
  const fileContext = getTerminalFileContext(
    host.worktreeId,
    host.worktreePath,
    host.runtimeEnvironmentId
  )
  const expandsOnHost = hostExpandsTilde(parsed.pathText, host, fileContext.connectionId)
  const resolved = resolveFileLinkPath(parsed, host, fileContext.connectionId)
  if (!resolved) {
    return null
  }
  const absolutePath = mapTerminalFilePath(
    resolved.absolutePath,
    host.worktreePath,
    terminalLinkWslDistro(host.wslDistro, host.runtimeEnvironmentId)
  )
  const isKnownWorktreeRoot = Boolean(
    resolveKnownWorktreeRootPathLink(absolutePath, useAppStore.getState(), fileContext)
  )
  const folderText = /[\\/]$/.test(parsed.pathText) && !isKnownWorktreeRoot
  if (folderText && !expandsOnHost) {
    return null
  }
  const isRemoteRuntimePath = isRemoteRuntimeFileOperation(fileContext, absolutePath)
  return {
    absolutePath,
    line: resolved.line,
    column: resolved.column,
    fileContext,
    isRemoteRuntimePath,
    cacheKey: getTerminalPathExistsCacheKey({
      absolutePath,
      connectionId: fileContext.connectionId,
      isRemoteRuntimePath,
      runtimeEnvironmentId: host.runtimeEnvironmentId
    }),
    isKnownWorktreeRoot,
    ...(folderText ? { hostWorkspaceRootOnly: true as const } : {})
  }
}

/** Unprompted external-share stats can send credentials over SMB on local or SSH Windows hosts; permit the workspace’s own WSL distro. */
export function mayCheckFileLinkTargetUnprompted(
  target: FileLinkTarget,
  host: FileLinkHost
): boolean {
  const { absolutePath } = target
  if (
    target.isKnownWorktreeRoot ||
    target.isRemoteRuntimePath ||
    !/^[\\/]{2}/.test(absolutePath) ||
    isPathInsideWorktree(absolutePath, host.worktreePath)
  ) {
    return true
  }
  const ownDistro = terminalPathWslDistro(
    host.worktreePath,
    terminalLinkWslDistro(host.wslDistro, host.runtimeEnvironmentId)
  )
  // Why normalized: `..` must not stand in for a distro name.
  const wsl = parseWslUncPath(normalizeAbsolutePath(absolutePath)?.normalized ?? absolutePath)
  return Boolean(ownDistro && wsl && wsl.distro.toLowerCase() === ownDistro.toLowerCase())
}

/** Rejects when the host cannot answer, so callers never mistake an outage for a missing file. */
export async function fileLinkTargetExists(
  target: FileLinkTarget,
  cache: TerminalPathExistsCache,
  pathExists: FileLinkPathExistence,
  terminalHandle?: string | null
): Promise<boolean> {
  // Known workspace roots remain clickable even when SSH/stale local probing reports missing.
  if (target.isKnownWorktreeRoot) {
    return true
  }
  if (!target.fileContext.sourceHostResolved) {
    // Why: no owner means no host to ask; a local stat would answer for the wrong machine.
    throw new Error('The terminal workspace host could not be determined')
  }
  if (isHostPathOutsideWorkspace(target)) {
    // Why: a local stat here would answer for this computer, not the server that printed the path.
    return hostFileLinkTargetExists(target, cache, terminalHandle)
  }
  const cached = readTerminalPathExistence(cache, target.cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const probe = startTerminalPathExistsProbe()
  const exists = await pathExists(
    target.fileContext,
    target.absolutePath,
    target.isRemoteRuntimePath
  )
  writeTerminalPathExistence(cache, target.cacheKey, exists, probe)
  return exists
}
