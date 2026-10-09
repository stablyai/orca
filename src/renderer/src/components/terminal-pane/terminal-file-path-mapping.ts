import { buildWorkspaceFileContext } from '@/lib/workspace-file-host-routing'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { parseWslUncPath, toWindowsWslPath } from '../../../../shared/wsl-paths'

// Why its own module: resolving a link's host path must not load the open flow (worktree activation).
export function getTerminalFileContext(
  worktreeId: string,
  worktreePath: string,
  runtimeEnvironmentId?: string | null
): RuntimeFileOperationArgs {
  return buildWorkspaceFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
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
