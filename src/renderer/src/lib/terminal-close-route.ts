import { parseExecutionHostId } from '../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../shared/terminal-execution-host'
import type { AppState } from '@/store/types'
import { collectPtyIdsForTab } from '@/store/slices/terminal-tab-retirement'
import { resolveTerminalWorktreeRoute, type TerminalWorktreeRoute } from './terminal-worktree-route'

function routeForHost(hostId: string | null | undefined): TerminalWorktreeRoute | null {
  const host = parseExecutionHostId(hostId)
  if (host?.kind === 'runtime') {
    return { runtimeEnvironmentId: host.environmentId }
  }
  return host ? { runtimeEnvironmentId: null } : null
}

/**
 * Which host a terminal tab's close goes to: the worktree catalog's route, else the one host the
 * tab's own PTY ids name, else the host recorded on its unified tab. Null when nothing names one,
 * e.g. before the catalog hydrates (#11308); per-PTY teardown still fails closed then.
 */
export function resolveTerminalCloseRoute(
  state: AppState,
  worktreeId: string,
  terminalTabId: string
): TerminalWorktreeRoute | null {
  const catalogRoute = resolveTerminalWorktreeRoute(state, worktreeId)
  if (catalogRoute) {
    return catalogRoute
  }
  const row = state.tabsByWorktree?.[worktreeId]?.find((tab) => tab.id === terminalTabId)
  const ptyHosts = new Set(
    collectPtyIdsForTab(state, terminalTabId, row?.ptyId ?? null)
      .map(getPtyExecutionHost)
      .filter((host) => host !== null)
  )
  if (ptyHosts.size > 0) {
    // Why: an id that names no host ('foreign') or two hosts proves only that it is not local.
    const [host] = ptyHosts
    return ptyHosts.size === 1 && host !== 'foreign' ? routeForHost(host) : null
  }
  const unified = state.unifiedTabsByWorktree?.[worktreeId]?.find(
    (tab) =>
      tab.contentType === 'terminal' && (tab.entityId === terminalTabId || tab.id === terminalTabId)
  )
  return routeForHost(unified?.executionHostId)
}
