import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { parseWslUncPath } from '../../../../shared/wsl-paths'

type PaneWslDistroState = Parameters<typeof getLocalProjectExecutionRuntimeContext>[0]

/**
 * Distro whose POSIX paths a local pane prints. Mirrors the runtime resolution
 * `pty-connection` uses to decide whether the pane shell runs inside WSL, so a
 * worktree on a Windows drive with a WSL project runtime is still recognized.
 */
export function resolvePaneWslDistro(
  state: PaneWslDistroState,
  worktreeId: string,
  worktreePath: string
): string | null {
  const capabilities = hasCachedWindowsTerminalCapabilities()
    ? getCachedWindowsTerminalCapabilities()
    : null
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId, undefined, {
    wslAvailable: capabilities?.wslAvailable,
    availableWslDistros: capabilities?.wslDistros ?? null
  })
  if (projectRuntime?.status === 'resolved') {
    return projectRuntime.runtime.kind === 'wsl' ? projectRuntime.runtime.distro : null
  }
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.distro
  }
  return parseWslUncPath(worktreePath)?.distro ?? null
}
