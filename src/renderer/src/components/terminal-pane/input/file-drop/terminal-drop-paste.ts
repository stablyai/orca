import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import type { captureTerminalDropTarget } from './terminal-drop-target'
import { getCurrentTerminalDropTransport } from './terminal-drop-target'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'
import { showTerminalDropWriteFailure } from './terminal-drop-write-failure'
import { recordTerminalUserInputForLeaf } from '../terminal-input-activity'
import { recordRecentTerminalImage } from '../recent-terminal-images'

/** Everything a drop flow needs to reach the terminal it was dropped on. */
export type NativeDropFlowArgs = {
  dataPaths: string[]
  dropTarget: ReturnType<typeof captureTerminalDropTarget>
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  pane: { id: number; leafId: string }
  tabId: string
  worktreePath: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  assertCurrent?: () => void
}

export async function pasteResolvedDropPaths(
  args: NativeDropFlowArgs & {
    paths: string[]
    previewPaths?: readonly string[]
    targetShell: 'posix' | 'windows'
  }
): Promise<void> {
  args.assertCurrent?.()
  // Upload/resolution can outlive the pane; recheck before writing to its PTY.
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
    if (
      args.previewPaths &&
      getCurrentTerminalDropTransport(args.manager, args.paneTransports, args.dropTarget)
    ) {
      const pane = args.manager
        .getPanes()
        .find((candidate) => candidate.leafId === args.pane.leafId)
      if (pane) {
        for (const path of args.previewPaths.slice(0, writeResult.pathsWritten)) {
          recordRecentTerminalImage(pane.terminal, path)
        }
      }
    }
  }
}
