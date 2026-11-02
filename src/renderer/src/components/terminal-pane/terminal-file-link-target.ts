import { useAppStore } from '@/store'
import {
  isPathInsideWorktree,
  resolveTerminalFileLink,
  type ParsedTerminalFileLink
} from '../../../../shared/terminal-links'
import { normalizeAbsolutePath } from '../../../../shared/terminal-path-normalization'
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
}

export type FileLinkPathExistence = ReturnType<typeof createTerminalPathExistenceBatch>

/** Detected path text to the host path it names; null when it cannot be a link. */
export function resolveFileLinkTarget(
  parsed: ParsedTerminalFileLink,
  host: FileLinkHost
): FileLinkTarget | null {
  const resolved = host.cwd ? resolveTerminalFileLink(parsed, host.cwd, host.homePath) : null
  if (!resolved) {
    return null
  }
  const absolutePath = mapTerminalFilePath(
    resolved.absolutePath,
    host.worktreePath,
    terminalLinkWslDistro(host.wslDistro, host.runtimeEnvironmentId)
  )
  const fileContext = getTerminalFileContext(
    host.worktreeId,
    host.worktreePath,
    host.runtimeEnvironmentId
  )
  const isKnownWorktreeRoot = Boolean(
    resolveKnownWorktreeRootPathLink(absolutePath, useAppStore.getState(), fileContext)
  )
  if (/[\\/]$/.test(parsed.pathText) && !isKnownWorktreeRoot) {
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
    isKnownWorktreeRoot
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
