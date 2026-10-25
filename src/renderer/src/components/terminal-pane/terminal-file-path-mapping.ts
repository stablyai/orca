import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import {
  buildWorkspaceFileContext,
  canClientOsOpenWorkspaceFile
} from '@/lib/workspace-file-host-routing'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/file-owner-runtime-target'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWslUncPath, toWindowsWslPath } from '../../../../shared/wsl-paths'
import { terminalFileSourceHost } from './terminal-worktree-path-link'

export type TerminalFileContext = RuntimeFileOperationArgs & {
  /** False when no single owner names the terminal's host; file operations must refuse, not go local. */
  sourceHostResolved: boolean
}

export function shouldOpenTerminalFileWithSystemDefault(fileContext: TerminalFileContext): boolean {
  // Why: an unresolved owner has no connectionId either, which would otherwise read as local.
  return fileContext.sourceHostResolved && canClientOsOpenWorkspaceFile(fileContext)
}

// Why its own module: resolving a link's host path must not load the open flow (worktree activation).
export function getTerminalFileContext(
  worktreeId: string,
  worktreePath: string,
  runtimeEnvironmentId?: string | null
): TerminalFileContext {
  const state = useAppStore.getState()
  if (
    runtimeEnvironmentId === undefined &&
    worktreeId &&
    !getRuntimeTargetForWorktreeOwner(state, worktreeId)
  ) {
    // Why: rows disagree on the owner; the local target is a placeholder every caller refuses.
    return {
      target: { kind: 'local' },
      worktreeId,
      worktreePath,
      sourceHostResolved: false
    }
  }
  const context = buildWorkspaceFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
  const sourceHost = terminalFileSourceHost(state, context)
  if (!sourceHost) {
    // Connection lookup ignores detected rows; its null cannot turn ambiguous ownership into local access.
    const ambiguous =
      Boolean(worktreeId) &&
      resolveWorktreeOperationRouteResult(state, worktreeId).kind === 'ambiguous'
    return {
      ...context,
      sourceHostResolved: !ambiguous && getConnectionId(worktreeId || null) === null
    }
  }
  // Shared IDs can hide connectionId; use the resolved SSH owner while paired runtimes keep their transport.
  const sshHost = context.target.kind === 'environment' ? null : parseExecutionHostId(sourceHost)
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

// WSL panes print POSIX paths even for Windows-drive worktrees; use the pane’s distro, not path shape.
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
  // Reach /mnt/<drive> directly as a Windows drive instead of through the WSL 9P share.
  return toWindowsWslPath(filePath, distro)
}

// Remote-runtime POSIX paths must never be rewritten through the client’s WSL distro.
export function terminalLinkWslDistro(
  wslDistro: string | null | undefined,
  runtimeEnvironmentId: string | null | undefined
): string | null | undefined {
  return runtimeEnvironmentId ? null : wslDistro
}
