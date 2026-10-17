import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { separateImagePasteFromFollowingText } from '../../../../shared/image-paste-following-text'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { PtyTransport } from './pty-transport-types'
import { wrapTerminalBracketedPasteText } from './terminal-bracketed-paste'
import { formatTerminalImageDropPasteText, isImageDropPath } from './terminal-drop-image-path'
import {
  type CapturedTerminalDropTarget,
  getCurrentTerminalDropTransport
} from './terminal-drop-target'
import type { TerminalTargetShell } from './terminal-drop-shell'
import { hasTerminalDropControlByte, quoteTerminalDropPath } from './terminal-drop-path-quoting'
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
  inputShell,
  operationTimeoutMs = TERMINAL_PASTE_OPERATION_TIMEOUT_MS
}: {
  dropTarget: CapturedTerminalDropTarget
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  paths: readonly string[]
  /** Path conventions of `paths`; picks the image-paste spelling. */
  targetShell: TerminalTargetShell
  /** Grammar of the shell reading the pane; quotes typed paths. */
  inputShell: AgentStartupShell
  operationTimeoutMs?: number
}): Promise<TerminalDropPathWriteResult> {
  // Why refuse the whole drop: typed control bytes act as editing keys (C-u
  // drops the open quote, LF submits), and skipping one path would silently
  // change the argument list the user dropped.
  if (paths.some(hasTerminalDropControlByte)) {
    return {
      sentAnyPath: false,
      targetCurrent: Boolean(getCurrentTerminalDropTransport(manager, paneTransports, dropTarget)),
      pathsWritten: 0,
      failureReason: 'control-character-path'
    }
  }
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
    // plain text. Non-image drops, and Windows image paths a shell would expand
    // inside double quotes, are typed shell-quoted and space-separated.
    //
    // Image payloads carry no trailing space of their own, so when an image is
    // immediately followed by another path the two would otherwise collide
    // (`<bracketed-paste>/repo/a.ts`). Add a single separating space unless
    // both are raw image pastes — those are self-delimiting for TUIs, and a
    // stray space between them would land in the TUI input. Keep it when
    // either side is escaped: a shell ignores paste boundaries, so
    // `/a\ \(1\).png/b\ \(2\).png` would otherwise become one argument.
    const imagePasteText = isImageDropPath(path)
      ? formatTerminalImageDropPasteText(path, targetShell)
      : null
    const pathIsRawPasteImage = imagePasteText === path
    const nextPath = paths[index + 1]
    const nextPathIsRawPasteImage =
      nextPath !== undefined &&
      isImageDropPath(nextPath) &&
      formatTerminalImageDropPasteText(nextPath, targetShell) === nextPath
    const needsSeparatorAfterImage =
      nextPath !== undefined && !(pathIsRawPasteImage && nextPathIsRawPasteImage)
    const payload =
      imagePasteText !== null
        ? separateImagePasteFromFollowingText(
            wrapTerminalBracketedPasteText(imagePasteText),
            needsSeparatorAfterImage
          )
        : `${quoteTerminalDropPath(path, inputShell)} `
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
