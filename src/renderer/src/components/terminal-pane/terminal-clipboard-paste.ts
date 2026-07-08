import {
  isClipboardTextTooLargeError,
  type ReadClipboardTextOptions
} from '../../../../shared/clipboard-text'
import { shellEscapePath } from './pane-helpers'
import {
  TERMINAL_PASTE_MAX_BYTES,
  type TerminalPasteTextOptions
} from './terminal-paste-coordinator'

type SaveClipboardImageAsTempFile = (args?: {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
}) => Promise<string | null>

type PasteTerminalClipboardDeps = {
  readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  readClipboardFilePaths: () => Promise<string[]>
  saveClipboardImageAsTempFile: SaveClipboardImageAsTempFile
  pasteText: (
    text: string,
    options?: TerminalPasteTextOptions
  ) => boolean | void | Promise<boolean | void>
  // The shell receiving the paste, so copied-file paths are quoted the same way
  // drops are (a Windows client onto a POSIX SSH worktree still needs POSIX
  // quoting). Mirrors terminal-drop-path-writer's shellEscapePath call.
  targetShell: 'posix' | 'windows'
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  forceBracketedMultilineTextPaste?: boolean
  onTextPasteError?: (error: unknown) => void
  onImagePasteError?: (error: unknown) => void
}

export type TerminalClipboardPasteResult =
  | { status: 'pasted'; kind: 'image-path' | 'text' | 'file-path' }
  | {
      status: 'skipped'
      reason:
        | 'empty'
        | 'image-paste-failed'
        | 'image-paste-rejected'
        | 'text-paste-failed'
        | 'text-paste-rejected'
        | 'text-too-large'
    }

export async function pasteTerminalClipboard({
  readClipboardText,
  readClipboardFilePaths,
  saveClipboardImageAsTempFile,
  pasteText,
  targetShell,
  connectionId,
  runtimeEnvironmentId,
  forceBracketedMultilineTextPaste = false,
  onTextPasteError,
  onImagePasteError
}: PasteTerminalClipboardDeps): Promise<TerminalClipboardPasteResult> {
  // Why: an OS-copied file also puts its display name on the clipboard as text,
  // so the text branch below would paste the bare name. Reading the real file
  // reference first makes paste behave like drop — full shell-escaped paths.
  // Only take this branch when a file is actually present; ordinary text and
  // image copies fall through unchanged.
  let filePaths: string[] = []
  try {
    filePaths = await readClipboardFilePaths()
  } catch {
    // Best-effort: a failed file-reference read must not block text/image paste.
  }
  if (filePaths.length > 0) {
    const escaped = `${filePaths.map((path) => shellEscapePath(path, targetShell)).join(' ')} `
    try {
      const result = await pasteText(escaped)
      if (result === false) {
        return { status: 'skipped', reason: 'text-paste-rejected' }
      }
      return { status: 'pasted', kind: 'file-path' }
    } catch (error) {
      onTextPasteError?.(error)
      return { status: 'skipped', reason: 'text-paste-failed' }
    }
  }

  let text = ''
  try {
    text = await readClipboardText({ maxBytes: TERMINAL_PASTE_MAX_BYTES })
  } catch (error) {
    if (isClipboardTextTooLargeError(error)) {
      onTextPasteError?.(error)
      return { status: 'skipped', reason: 'text-too-large' }
    }
    // Why: browser clipboard text reads can fail for image-only clipboards.
    // Still try the image path so Cmd/Ctrl+V works for screenshots.
  }
  if (text) {
    try {
      const result = await (forceBracketedMultilineTextPaste
        ? pasteText(text, { forceBracketedPasteForMultiline: true })
        : pasteText(text))
      if (result === false) {
        return { status: 'skipped', reason: 'text-paste-rejected' }
      }
      return { status: 'pasted', kind: 'text' }
    } catch (error) {
      onTextPasteError?.(error)
      return { status: 'skipped', reason: 'text-paste-failed' }
    }
  }

  try {
    const filePath = await saveClipboardImageAsTempFile({ connectionId, runtimeEnvironmentId })
    if (!filePath) {
      return { status: 'skipped', reason: 'empty' }
    }
    const result = await pasteText(filePath, {
      // Why: a generated clipboard-image path is terminal image injection, not
      // ordinary one-line text. Keep it off the Ctrl+C stale-text paste path.
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
    })
    if (result === false) {
      return { status: 'skipped', reason: 'image-paste-rejected' }
    }
    return { status: 'pasted', kind: 'image-path' }
  } catch (error) {
    onImagePasteError?.(error)
    return { status: 'skipped', reason: 'image-paste-failed' }
  }
}
