import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'

/**
 * A layout-owner build's drag-out: main moves the pane under the desktop's move rules and names the
 * new tab. Today's move runs instead when main cannot act on it (a paired server's workspace, or a
 * tab or pane main's copy lacks, such as a legacy tab whose tab-bar id differs from its terminal's).
 */
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
        apply: (result) =>
          resolve(
            result.tabId
              ? { status: 'moved', ptyId: result.ptyId ?? null, tabId: result.tabId }
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
