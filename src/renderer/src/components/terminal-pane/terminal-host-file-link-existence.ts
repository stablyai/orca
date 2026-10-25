import { hasRemoteRuntimeOwner } from '@/runtime/runtime-file-routing'
import type { FileLinkTarget } from './terminal-file-link-target'
import { HostFileRefusal, resolveHostWorkspaceFile } from './terminal-host-workspace-file'
import {
  readTerminalPathExistence,
  writeTerminalPathExistence,
  startTerminalPathExistsProbe,
  type TerminalPathExistsCache
} from './terminal-path-exists-cache'

/** A paired-server path outside the terminal's workspace: only its host can say whether it opens. */
export function isHostPathOutsideWorkspace(target: FileLinkTarget): boolean {
  return !target.isRemoteRuntimePath && hasRemoteRuntimeOwner(target.fileContext)
}

/**
 * Asks the host the same question a click asks, so a link shows exactly when a click can open it.
 * Rejects when the host cannot answer, so callers never mistake an outage for a missing file.
 */
export async function hostFileLinkTargetExists(
  target: FileLinkTarget,
  cache: TerminalPathExistsCache,
  terminalHandle: string | null | undefined
): Promise<boolean> {
  // Why: an unprompted stat of a network share can send the user's credentials to its server.
  if (/^[\\/]{2}/.test(target.absolutePath)) {
    return false
  }
  const cached = readTerminalPathExistence(cache, target.cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const probe = startTerminalPathExistsProbe()
  let exists: boolean
  try {
    exists =
      (await resolveHostWorkspaceFile(target.fileContext, target.absolutePath, terminalHandle)) !==
      null
  } catch (error) {
    if (!(error instanceof HostFileRefusal)) {
      throw error
    }
    exists = false
  }
  writeTerminalPathExistence(cache, target.cacheKey, exists, probe)
  return exists
}
