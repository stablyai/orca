import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { useAppStore } from '@/store'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'

/** Ask the layout-owning main to move the pane and name its tab; use paired main only when its frames draw the workspace. Fall back to window moves for unowned or legacy tab/pane identities main lacks. */
export function moveLeafThroughLayoutOwner(
  request: TerminalLeafMoveRequest,
  placement: { groupId: string; index: number | undefined },
  /** The pane's folder, where main starts an unbound pane's new shell. */
  paneCwd?: string
): Promise<TerminalLeafMoveResult> {
  const asToday = (): Promise<TerminalLeafMoveResult> => window.api.pty.moveLeafToNewTab(request)
  return new Promise((resolve, reject) => {
    const fallBack = (): void => void asToday().then(resolve, reject)
    const sent = sendLayoutCommandToOwner(
      request.worktreeId,
      {
        type: 'movePaneToNewTab',
        tabId: request.sourceTabId,
        leafId: request.leafId,
        groupId: placement.groupId,
        ...(placement.index !== undefined ? { index: placement.index } : {}),
        windowDetach: { ptyId: request.ptyId, ...(paneCwd ? { startupCwd: paneCwd } : {}) }
      },
      {
        apply: (result, origin) =>
          resolve(
            result.tabId
              ? {
                  status: 'moved',
                  // Server IDs are not client bindings; prefer the preceding frame’s mapped terminal, then the client’s existing one.
                  ptyId: origin.routed
                    ? (drawnBinding(result.tabId, request.leafId) ??
                      (result.ptyId ? request.ptyId : null))
                    : (result.ptyId ?? null),
                  tabId: result.tabId
                }
              : { status: 'refused', reason: 'invalid_request' }
          ),
        asToday: fallBack,
        refused: (code) =>
          resolve({
            status: 'refused',
            reason:
              code === 'pty_mismatch'
                ? 'pty_mismatch'
                : code === 'pane_in_other_tab'
                  ? 'leaf_in_other_tab'
                  : 'invalid_request'
          })
      }
    )
    if (!sent) {
      fallBack()
    }
  })
}

/** The terminal a server's frame bound the moved pane to, in this desktop's ids. */
function drawnBinding(tabId: string, leafId: string): string | null {
  return useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ?? null
}
