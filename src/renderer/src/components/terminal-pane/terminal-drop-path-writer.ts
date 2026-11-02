import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { separateImagePasteFromFollowingText } from '../../../../shared/image-paste-following-text'
import { shellEscapePath } from './pane-helpers'
import type { PtyTransport } from './pty-transport-types'
import { wrapTerminalBracketedPasteText } from './terminal-bracketed-paste'
import {
  canPasteImageDropPathRaw,
  formatImageDropPasteText,
  isImageDropPath
} from './terminal-drop-image-path'
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
  for (const [index, path] of paths.entries()) {
    // Async writes can outlive the targeted pane or PTY; preserve the captured identity.
    const liveTransport = getCurrentTerminalDropTransport(manager, paneTransports, dropTarget)
    if (!liveTransport) {
      return { sentAnyPath, targetCurrent: false, pathsWritten, failureReason: 'target-stale' }
    }
    // TUIs detect image attachments from bracketed paths (like clipboard screenshots). Paste safe paths raw and shell-sensitive paths escaped; agents undo escapes. Control-byte paths that framing would alter, and non-images, stay typed and shell-escaped.
    // Separate adjacent paths unless both are raw image frames: TUIs self-delimit those, but shells ignore frame boundaries and need a separator for escaped paths.
    const imagePasteText = isImageDropPath(path)
      ? formatImageDropPasteText(path, targetShell)
      : null
    const pathIsRawPasteImage = imagePasteText === path
    const nextPath = paths[index + 1]
    const nextPathIsRawPasteImage =
      nextPath !== undefined &&
      isImageDropPath(nextPath) &&
      canPasteImageDropPathRaw(nextPath, targetShell)
    const needsSeparatorAfterImage =
      nextPath !== undefined && !(pathIsRawPasteImage && nextPathIsRawPasteImage)
    const payload =
      imagePasteText !== null
        ? separateImagePasteFromFollowingText(
            wrapTerminalBracketedPasteText(imagePasteText),
            needsSeparatorAfterImage
          )
        : `${shellEscapePath(path, targetShell)} `
    const writeResult = await runTerminalPasteOperationWithTimeout(
      (signal) => writeTerminalPastePtyInput(liveTransport, payload, 'driving', signal),
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
