import { useAppStore } from '@/store'
import {
  isPathInsideWorktree,
  resolveTerminalFileLink,
  type ParsedTerminalFileLink
} from '@/lib/terminal-links'
import { normalizeAbsolutePath } from '@/lib/terminal-path-normalization'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { isRemoteRuntimeFileOperation } from '@/runtime/runtime-file-client'
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
  readTerminalPathExistsCache,
  writeTerminalPathExistsCache
} from './terminal-path-exists-cache'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'

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

/**
 * Whether this target may be checked with no click or hover. A network share outside the workspace
 * may not, on any host: on Windows (this machine or an SSH host) that stat opens SMB to the named
 * server and can send the user's credentials. The workspace's own WSL distro is not a share.
 */
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
  cache: Map<string, boolean>,
  pathExists: FileLinkPathExistence
): Promise<boolean> {
  // Why: exact known workspace roots must stay clickable for SSH or
  // stale local paths even when filesystem probing says "missing".
  if (target.isKnownWorktreeRoot) {
    return true
  }
  if (!target.fileContext.sourceHostResolved) {
    // Why: no owner means no host to ask; a local stat would answer for the wrong machine.
    throw new Error('The terminal workspace host could not be determined')
  }
  const exists =
    readTerminalPathExistsCache(cache, target.cacheKey) ??
    (await pathExists(target.fileContext, target.absolutePath, target.isRemoteRuntimePath))
  writeTerminalPathExistsCache(cache, target.cacheKey, exists)
  return exists
}
