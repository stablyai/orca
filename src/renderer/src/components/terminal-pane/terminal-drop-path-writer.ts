import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { shellEscapePath } from './pane-helpers'
import type { PtyTransport } from './pty-transport'
import {
  type CapturedTerminalDropTarget,
  getCurrentTerminalDropTransport
} from './terminal-drop-target'
import type { TerminalTargetShell } from './terminal-drop-shell'
import { TERMINAL_PASTE_OPERATION_TIMEOUT_MS } from './terminal-paste-limits'
import { runTerminalPasteOperationWithTimeout } from './terminal-paste-operation-timeout'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import type { TerminalDropWriteFailureReason } from './terminal-drop-write-failure'

type TerminalDropPathWriteResult = {
  sentAnyPath: boolean
  targetCurrent: boolean
  pathsWritten: number
  failureReason?: TerminalDropWriteFailureReason
}

export async function writeTerminalDropPathsToCapturedTarget({
  dropTarget,
  manager,
  paneTransports,
  paths,
  targetShell,
  operationTimeoutMs = TERMINAL_PASTE_OPERATION_TIMEOUT_MS
}: {
  dropTarget: CapturedTerminalDropTarget
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  paths: readonly string[]
  targetShell: TerminalTargetShell
  operationTimeoutMs?: number
}): Promise<TerminalDropPathWriteResult> {
  let sentAnyPath = false
  let pathsWritten = 0
  for (const path of paths) {
    // Why: acknowledged PTY writes are async, so a multi-path drop can outlive
    // the pane or PTY it originally targeted.
    const liveTransport = getCurrentTerminalDropTransport(manager, paneTransports, dropTarget)
    if (!liveTransport) {
      return { sentAnyPath, targetCurrent: false, pathsWritten, failureReason: 'target-stale' }
    }
    const writeResult = await runTerminalPasteOperationWithTimeout(
      () => writeTerminalPastePtyInput(liveTransport, `${shellEscapePath(path, targetShell)} `),
      operationTimeoutMs
    )
    if (writeResult.timedOut) {
      return { sentAnyPath, targetCurrent: false, pathsWritten, failureReason: 'operation-timeout' }
    }
    if (!writeResult.value) {
      return { sentAnyPath, targetCurrent: false, pathsWritten, failureReason: 'write-rejected' }
    }
    pathsWritten += 1
    sentAnyPath = true
  }
  return {
    sentAnyPath,
    targetCurrent: Boolean(getCurrentTerminalDropTransport(manager, paneTransports, dropTarget)),
    pathsWritten
  }
}
