import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { separateImagePasteFromFollowingText } from '../../../../shared/image-paste-following-text'
import { shellEscapePath } from './pane-helpers'
import type { PtyTransport } from './pty-transport'
import { wrapTerminalBracketedPasteText } from './terminal-bracketed-paste'
import { canPasteImageDropPathRaw, isImageDropPath } from './terminal-drop-image-path'
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
    // Why: acknowledged PTY writes are async, so a multi-path drop can outlive
    // the pane or PTY it originally targeted.
    const liveTransport = getCurrentTerminalDropTransport(manager, paneTransports, dropTarget)
    if (!liveTransport) {
      return { sentAnyPath, targetCurrent: false, pathsWritten, failureReason: 'target-stale' }
    }
    // Why: image drops are attachment payloads for terminal TUIs, which detect
    // them from a bracketed paste of the raw (un-escaped) path — mirroring the
    // clipboard screenshot flow (terminal-clipboard-paste.ts, issue #2842).
    // Shell-escaping would corrupt the file-existence check those tools run on
    // the pasted path, so safe image paths bypass it. Unsafe image paths and
    // non-image drops keep the original shell-escaped, space-separated
    // behaviour for use in shell commands.
    //
    // Image payloads carry no trailing space of their own, so when an image is
    // immediately followed by a non-image path the two would otherwise collide
    // (`<bracketed-paste>/repo/a.ts`). Add a single separating space in that
    // case only — back-to-back image pastes are self-delimiting and a stray
    // space between them would land in the TUI input.
    const pathIsRawPasteImage = isImageDropPath(path) && canPasteImageDropPathRaw(path, targetShell)
    const nextPath = paths[index + 1]
    const nextPathIsRawPasteImage =
      nextPath !== undefined &&
      isImageDropPath(nextPath) &&
      canPasteImageDropPathRaw(nextPath, targetShell)
    const needsSeparatorAfterImage = nextPath !== undefined && !nextPathIsRawPasteImage
    const pathPayload = pathIsRawPasteImage
      ? separateImagePasteFromFollowingText(
          wrapTerminalBracketedPasteText(path),
          needsSeparatorAfterImage
        )
      : `${shellEscapePath(path, targetShell)} `
    // Why: the first path always opens with a separator rather than guessing
    // whether a draft precedes it (#22777). The screen can be read, but the cell
    // left of the cursor is the TUI's own frame (border, padding, wrap column,
    // CJK continuation cell), not the draft, and a remote write lands seconds
    // after any such read. It sits outside the bracketed paste so image
    // attachment detection still sees a bare path (#12715); later paths inherit
    // the previous payload's trailing space.
    const payload = index === 0 ? ` ${pathPayload}` : pathPayload
    const writeResult = await runTerminalPasteOperationWithTimeout(
      () => writeTerminalPastePtyInput(liveTransport, payload),
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
