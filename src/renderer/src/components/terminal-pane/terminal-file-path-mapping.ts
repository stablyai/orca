import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { buildWorkspaceFileContext } from '@/lib/workspace-file-host-routing'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWslUncPath, toWindowsWslPath } from '../../../../shared/wsl-paths'
import { terminalFileSourceHost } from './terminal-worktree-path-link'

export type TerminalFileContext = RuntimeFileOperationArgs & {
  /** False when no single owner names the terminal's host; file operations must refuse, not go local. */
  sourceHostResolved: boolean
}

// Why its own module: resolving a link's host path must not load the open flow (worktree activation).
export function getTerminalFileContext(
  worktreeId: string,
  worktreePath: string,
  runtimeEnvironmentId?: string | null
): TerminalFileContext {
  const context = buildWorkspaceFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
  const state = useAppStore.getState()
  const sourceHost = terminalFileSourceHost(state, context)
  if (!sourceHost) {
    // Why: the connection lookup ignores detected rows, so its local `null` must not override an
    // owner the full resolver found ambiguous; only a missing route may defer to it.
    const ambiguous =
      Boolean(worktreeId) &&
      resolveWorktreeOperationRouteResult(state, worktreeId).kind === 'ambiguous'
    return {
      ...context,
      sourceHostResolved: !ambiguous && getConnectionId(worktreeId || null) === null
    }
  }
  // Why: same-id rows on several hosts leave connectionId unset, which reads downstream as local;
  // the resolved owner names the direct SSH host. A paired runtime keeps its own transport.
  const sshHost =
    getActiveRuntimeTarget(context.settings).kind === 'environment'
      ? null
      : parseExecutionHostId(sourceHost)
  return sshHost?.kind === 'ssh' && !context.connectionId
    ? { ...context, connectionId: sshHost.targetId, sourceHostResolved: true }
    : { ...context, sourceHostResolved: true }
}

/** The WSL distro a workspace's paths live in; `null` from the pane runtime means none. */
export function terminalPathWslDistro(
  worktreePath: string,
  wslDistro?: string | null
): string | null {
  return wslDistro === null
    ? null
    : wslDistro?.trim() || parseWslUncPath(worktreePath)?.distro || null
}

// Why: a WSL-runtime pane prints POSIX paths even when the worktree lives on a
// Windows drive, so the distro must come from the pane runtime, not the path shape.
export function mapTerminalFilePath(
  filePath: string,
  worktreePath: string,
  wslDistro?: string | null
): string {
  const distro = terminalPathWslDistro(worktreePath, wslDistro)
  if (!distro || !filePath.startsWith('/')) {
    return filePath
  }
  // Why: only a proven local WSL pane may reinterpret this POSIX-looking path; SSH/runtime paths stay literal.
  const alreadyUnc = parseWslUncPath(filePath)
  if (alreadyUnc) {
    return toWindowsWslPath(alreadyUnc.linuxPath, alreadyUnc.distro)
  }
  if (filePath.startsWith('//')) {
    return filePath
  }
  // Why: /mnt/<drive> is a Windows drive mounted into WSL — reach it directly
  // instead of routing a native file back through the 9P share.
  return toWindowsWslPath(filePath, distro)
}

// Why: remote-runtime panes print the remote host's POSIX paths; the local WSL
// distro must never rewrite them.
export function terminalLinkWslDistro(
  wslDistro: string | null | undefined,
  runtimeEnvironmentId: string | null | undefined
): string | null | undefined {
  return runtimeEnvironmentId ? null : wslDistro
}
