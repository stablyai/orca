import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { parseWslUncPath } from '../../../../shared/wsl-paths'

type PaneWslDistroState = Parameters<typeof getLocalProjectExecutionRuntimeContext>[0]

/** Match pty-connection’s runtime distro: local WSL panes print POSIX paths even when the worktree is on a Windows drive. */
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
