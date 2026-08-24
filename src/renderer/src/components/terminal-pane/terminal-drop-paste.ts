import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { captureTerminalDropTarget } from './terminal-drop-target'
import { getCurrentTerminalDropTransport } from './terminal-drop-target'
import type { resolveNativeTerminalDropPane } from './terminal-drop-pane-resolution'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'
import { showTerminalDropWriteFailure } from './terminal-drop-write-failure'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'

/** Everything a drop flow needs to reach the terminal it was dropped on. */
export type NativeDropFlowArgs = {
  dataPaths: string[]
  dropTarget: ReturnType<typeof captureTerminalDropTarget>
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  pane: ReturnType<typeof resolveNativeTerminalDropPane> & {}
  tabId: string
  worktreePath: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  assertCurrent?: () => void
}

export async function pasteResolvedDropPaths(
  args: NativeDropFlowArgs & { paths: string[]; targetShell: 'posix' | 'windows' }
): Promise<void> {
  // Why: pane may have unmounted during upload/resolution (tab closed,
  // worktree switched). Re-check before writing so we do not call sendInput
  // on a torn-down PTY.
  const liveTransport = getCurrentTerminalDropTransport(
    args.manager,
    args.paneTransports,
    args.dropTarget
  )
  if (!liveTransport) {
    return
  }
  const writeResult = await writeTerminalDropPathsToCapturedTarget({
    dropTarget: args.dropTarget,
    manager: args.manager,
    paneTransports: args.paneTransports,
    paths: args.paths,
    targetShell: args.targetShell
  })
  showTerminalDropWriteFailure(writeResult.failureReason)
  if (writeResult.sentAnyPath) {
    recordTerminalUserInputForLeaf(args.tabId, args.pane.leafId)
  }
  if (writeResult.targetCurrent) {
    args.pane.terminal.focus()
  }
}
