import type { TerminalTab, TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { isWebRuntimeSessionActive } from './web-runtime-session-environment'
import { setWebRuntimeTabProps } from './web-runtime-terminal-actions'

/**
 * Why: a remote server's tab name lives on that server, where `orca terminal rename`, phones and
 * other desktops read it. A rename kept only here diverged from all of them (#29975).
 */
export function renameWebRuntimeTerminal(
  ptyId: string | null | undefined,
  title: string | null
): boolean {
  const remote = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'terminal.rename',
      params: { terminal: remote.handle, title },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response)
    })
    .catch((error) => {
      console.warn(
        '[web-runtime-session] failed to rename terminal:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}

type RenameStoreState = {
  tabsByWorktree: Record<string, TerminalTab[] | undefined>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
}

/** Any remote pane of the tab names it on the host; the active one is only the first choice. */
function boundRemotePtyId(state: RenameStoreState, tab: TerminalTab): string | null {
  const candidates = [
    tab.ptyId,
    ...Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
  ]
  return candidates.find((ptyId) => ptyId && parseRemoteRuntimePtyId(ptyId)) ?? null
}

/**
 * Sends a desktop rename to the host that owns the tab. Always by tab id, which reaches a pane
 * that is asleep, starting, or bound to a handle the host has since forgotten; plus by handle when
 * one is bound, which is all a host older than tab-id renames understands.
 */
export function renameHostTerminalTab(
  state: RenameStoreState,
  tabId: string,
  title: string | null
): void {
  const entry = Object.entries(state.tabsByWorktree)
    .map(([worktreeId, tabs]) => ({ worktreeId, tab: tabs?.find((tab) => tab.id === tabId) }))
    .find((candidate) => candidate.tab)
  if (!entry?.tab) {
    return
  }
  renameWebRuntimeTerminal(boundRemotePtyId(state, entry.tab), title)
  if (isWebTerminalSurfaceTabId(tabId)) {
    setWebRuntimeTabProps({ worktreeId: entry.worktreeId, tabId, customTitle: title })
  }
}
