/**
 * The WSL host's key for a renderer-stored entry of a moved local workspace, or null when the entry
 * is not one: another host's, another distro's, or a project the move did not take.
 */
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { PythonEnvironment } from '../../../shared/notebook-kernel-types'
import type { WslMoveRendererRewriteScope } from '../../../shared/wsl-move/wsl-move-renderer-rewrite-scope'

function parseArray(value: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** `[route, worktreeId, comparison-form root]`, as quick-open-file-history.ts keys a history. */
export function hostQuickOpenHistoryScope(
  scope: string,
  move: WslMoveRendererRewriteScope
): string | null {
  const parsed = parseArray(scope)
  if (!parsed || parsed.length !== 3) {
    return null
  }
  const [route, worktreeId, root] = parsed
  if (
    typeof route !== 'object' ||
    route === null ||
    !('executionHostId' in route) ||
    route.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    typeof worktreeId !== 'string' ||
    typeof root !== 'string'
  ) {
    return null
  }
  const hostWorktreeId = move.hostWorktreeId(worktreeId)
  const hostRoot = move.hostPath(root)
  return hostWorktreeId !== null && hostRoot !== null
    ? JSON.stringify([move.hostRoute, hostWorktreeId, normalizeRuntimePathForComparison(hostRoot)])
    : null
}

/** `[worktreeId, environment, sshTarget, filePath]`, as buildFileViewPreferenceKey writes it. */
export function hostFileViewPreferenceKey(
  fileKey: string,
  move: WslMoveRendererRewriteScope
): string | null {
  const parsed = parseArray(fileKey)
  if (!parsed || parsed.length !== 4) {
    return null
  }
  const [worktreeId, environment, sshTarget, filePath] = parsed
  if (
    typeof worktreeId !== 'string' ||
    environment !== 'local' ||
    sshTarget !== null ||
    typeof filePath !== 'string'
  ) {
    return null
  }
  const hostWorktreeId = move.hostWorktreeId(worktreeId)
  const hostFilePath = move.hostPath(filePath)
  return hostWorktreeId !== null && hostFilePath !== null
    ? JSON.stringify([hostWorktreeId, move.hostRoute.runtimeEnvironmentId, null, hostFilePath])
    : null
}

/** CSV widths are keyed by `[file key, delimiter]` around the file-view key. */
export function hostCsvColumnWidthsKey(
  storedKey: string,
  move: WslMoveRendererRewriteScope
): string | null {
  const parsed = parseArray(storedKey)
  if (!parsed || parsed.length !== 2 || typeof parsed[0] !== 'string') {
    return null
  }
  const hostFileKey = hostFileViewPreferenceKey(parsed[0], move)
  return hostFileKey === null ? null : JSON.stringify([hostFileKey, parsed[1]])
}

/**
 * A notebook's interpreter choice, keyed by its host path. A Windows interpreter cannot run on the
 * host, so only an interpreter inside the distro carries over; the host picks again otherwise.
 */
export function hostNotebookEnvironment(
  filePath: string,
  environment: PythonEnvironment,
  move: WslMoveRendererRewriteScope
): [string, PythonEnvironment] | null {
  const hostFilePath = move.hostPath(filePath)
  if (hostFilePath === null || !move.inMovedRoot(hostFilePath)) {
    return null
  }
  const interpreter = move.hostPath(environment.path)
  return interpreter === null ? null : [hostFilePath, { ...environment, path: interpreter }]
}
