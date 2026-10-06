import { separateImagePasteFromFollowingText } from '../../../../shared/image-paste-following-text'
import { shellEscapePath } from './pane-helpers'
import type { TerminalDropSurface, TerminalDropTransport } from './terminal-drop-surface'
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
  manager: TerminalDropSurface
  paneTransports: Map<number, TerminalDropTransport>
  paths: readonly string[]
  targetShell: TerminalTargetShell
  operationTimeoutMs?: number
}): Promise<TerminalDropPathWriteResult> {
  let sentAnyPath = false
  let pathsWritten = 0
  for (const [index, path] of paths.entries()) {
    // Why: acknowledged PTY writes are async, so a multi-path drop can outlive
    // the pane or PTY it originally targeted.
    const liveTransport = getCurrentTerminalDropTransport(manager, paneTransports, dropTarget)
    if (!liveTransport) {
      return { sentAnyPath, targetCurrent: false, pathsWritten, failureReason: 'target-stale' }
    }
    // Why: image drops are attachment payloads for terminal TUIs, which detect
    // them from a bracketed paste of the path — mirroring the clipboard
    // screenshot flow (terminal-clipboard-paste.ts, issue #2842). Safe image
    // paths are pasted raw, because escaping would corrupt the file-existence
    // check those tools run on the pasted path. Image paths with spaces or shell
    // metacharacters (`download (1).png`) are pasted escaped so a shell still
    // gets one argument; agent TUIs undo that escaping before the check.
    // Unframed, the escaped text reaches the TUI as typed keystrokes and stays
    // plain text. Paths a paste frame would alter (control bytes) and non-image
    // drops keep the original shell-escaped, space-separated typed input.
    //
    // Image payloads carry no trailing space of their own, so when an image is
    // immediately followed by another path the two would otherwise collide
    // (`<bracketed-paste>/repo/a.ts`). Add a single separating space unless
    // both are raw image pastes — those are self-delimiting for TUIs, and a
    // stray space between them would land in the TUI input. Keep it when
    // either side is escaped: a shell ignores paste boundaries, so
    // `/a\ \(1\).png/b\ \(2\).png` would otherwise become one argument.
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
      () => writeTerminalPastePtyInput(liveTransport, payload, 'driving'),
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
