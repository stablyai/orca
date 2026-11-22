import { agentImageSourceContext } from '../../../../../../shared/native-chat/input/composer/agent-image-paste'
import {
  captureTerminalAgentImageTarget,
  prepareTerminalAgentImagePaths
} from '@/runtime/files/agent-image-preparation'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { separateImagePasteFromFollowingText } from '../../../../../../shared/terminal/input/image-paste-following-text'
import { shellEscapePath } from '../../../../../../shared/shell/launch/shell-path-quoting'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import '../paste/terminal-bracketed-paste'
import { wrapTerminalBracketedPasteText } from '../../../../../../shared/terminal/input/terminal-bracketed-paste-text'
import {
  canPasteImageDropPathRaw,
  formatImageDropPasteText,
  isImageDropPath
} from '../../../../../../shared/terminal/input/image-path-paste'
import {
  type CapturedTerminalDropTarget,
  getCurrentTerminalDropTransport
} from './terminal-drop-target'
import type { TerminalTargetShell } from './terminal-drop-shell'
import { TERMINAL_PASTE_OPERATION_TIMEOUT_MS } from '../paste/terminal-paste-limits'
import { runTerminalPasteOperationWithTimeout } from '../paste/terminal-paste-operation-timeout'
import { writeTerminalPastePtyInput } from '../paste/terminal-pty-paste-writer'
import type { TerminalDropWriteFailureReason } from './terminal-drop-write-failure'

type TerminalDropPathWriteResult = {
  sentAnyPath: boolean
  targetCurrent: boolean
  pathsWritten: number
  failureReason?: TerminalDropWriteFailureReason
}

export async function writeTerminalDropPathsToCapturedTarget({
  dropTarget,
  tabId,
  manager,
  paneTransports,
  paths,
  targetShell,
  operationTimeoutMs = TERMINAL_PASTE_OPERATION_TIMEOUT_MS
}: {
  dropTarget: CapturedTerminalDropTarget
  tabId?: string
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  paths: readonly string[]
  targetShell: TerminalTargetShell
  operationTimeoutMs?: number
}): Promise<TerminalDropPathWriteResult> {
  const originalPaths = paths
  const imageTarget =
    tabId && paths.some(isImageDropPath)
      ? captureTerminalAgentImageTarget(tabId, dropTarget.leafId)
      : null
  if (tabId && paths.some(isImageDropPath)) {
    try {
      paths = await prepareTerminalAgentImagePaths(
        tabId,
        dropTarget.leafId,
        dropTarget.ptyId,
        paths,
        dropTarget.transport.getRuntimeEnvironmentId?.(),
        {
          executionHostId: dropTarget.transport.getExecutionHostId?.(),
          cwd: dropTarget.transport.getLocalSessionMetadata?.()?.cwd,
          isCurrent: () =>
            imageTarget?.isCurrent() !== false &&
            paneTransports.get(dropTarget.paneId) === dropTarget.transport &&
            dropTarget.transport.isConnected() &&
            dropTarget.transport.getPtyId() === dropTarget.ptyId
        }
      )
    } catch {
      return {
        sentAnyPath: false,
        targetCurrent: true,
        pathsWritten: 0,
        failureReason: 'write-rejected'
      }
    }
  }
  let sentAnyPath = false
  let pathsWritten = 0
  for (const [index, path] of paths.entries()) {
    // Async writes can outlive the targeted pane or PTY; preserve the captured identity.
    const liveTransport = getCurrentTerminalDropTransport(manager, paneTransports, dropTarget)
    if (!liveTransport || imageTarget?.isCurrent() === false) {
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
    const sourceContext = agentImageSourceContext([originalPaths[index]], [path])
    const payload =
      imagePasteText !== null
        ? separateImagePasteFromFollowingText(
            wrapTerminalBracketedPasteText(imagePasteText),
            needsSeparatorAfterImage
          )
        : `${shellEscapePath(path, targetShell)} `
    const writeResult = await runTerminalPasteOperationWithTimeout(async (signal) => {
      if (imageTarget?.isCurrent() === false) {
        return false
      }
      if (!(await writeTerminalPastePtyInput(liveTransport, payload, 'driving', signal))) {
        return false
      }
      if (imageTarget?.isCurrent() === false) {
        return false
      }
      return sourceContext
        ? writeTerminalPastePtyInput(
            liveTransport,
            wrapTerminalBracketedPasteText(` ${sourceContext} `),
            'driving',
            signal
          )
        : true
    }, operationTimeoutMs)
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
