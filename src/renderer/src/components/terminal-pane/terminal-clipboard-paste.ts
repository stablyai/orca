import {
  isClipboardTextTooLargeError,
  type ReadClipboardTextOptions
} from '../../../../shared/clipboard-text'
import {
  clipboardTextIsCopiedFileNames,
  couldClipboardTextBeCopiedFileNames
} from '../../../../shared/clipboard-file-paths'
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
  readClipboardFilePaths?: () => Promise<string[]>
  pasteFilePaths?: (paths: string[]) => Promise<boolean | void> | boolean | void
  saveClipboardImageAsTempFile: SaveClipboardImageAsTempFile
  pasteText: (
    text: string,
    options?: TerminalPasteTextOptions
  ) => boolean | void | Promise<boolean | void>
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  forceBracketedMultilineTextPaste?: boolean
  protectedMultilineTextPasteOptions?: TerminalPasteTextOptions
  onTextPasteError?: (error: unknown) => void
  onImagePasteError?: (error: unknown) => void
}

export type TerminalClipboardPasteResult =
  | { status: 'pasted'; kind: 'file-path' | 'image-path' | 'text' }
  | {
      status: 'skipped'
      reason:
        | 'empty'
        | 'file-paste-rejected'
        | 'image-paste-failed'
        | 'image-paste-rejected'
        | 'text-paste-failed'
        | 'text-paste-rejected'
        | 'text-too-large'
    }

/**
 * Resolve the files an OS file manager copied, but only for clipboard text that
 * could be their display names — every other paste skips the extra IPC round
 * trip. Returns an empty list when the clipboard carries real text or no files.
 */
async function readCopiedFilePathsForPaste(
  text: string,
  readClipboardFilePaths: (() => Promise<string[]>) | undefined
): Promise<string[]> {
  if (!readClipboardFilePaths || !couldClipboardTextBeCopiedFileNames(text)) {
    return []
  }
  let paths: string[]
  try {
    paths = await readClipboardFilePaths()
  } catch {
    return []
  }
  // Why: an older paired host or web client may answer without a path list.
  if (!Array.isArray(paths) || paths.length === 0 || !clipboardTextIsCopiedFileNames(text, paths)) {
    return []
  }
  return paths
}

export async function pasteTerminalClipboard({
  readClipboardText,
  readClipboardFilePaths,
  pasteFilePaths,
  saveClipboardImageAsTempFile,
  pasteText,
  connectionId,
  runtimeEnvironmentId,
  forceBracketedMultilineTextPaste = false,
  protectedMultilineTextPasteOptions,
  onTextPasteError,
  onImagePasteError
}: PasteTerminalClipboardDeps): Promise<TerminalClipboardPasteResult> {
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
  // Why: a Finder/Explorer file copy reaches the text flavor as the display
  // name only, so the file flavors decide the paste before the text does —
  // matching the drop pipeline, which resolves and shell-escapes full paths.
  if (pasteFilePaths) {
    const filePaths = await readCopiedFilePathsForPaste(text, readClipboardFilePaths)
    if (filePaths.length > 0) {
      const result = await pasteFilePaths(filePaths)
      if (result === false) {
        return { status: 'skipped', reason: 'file-paste-rejected' }
      }
      return { status: 'pasted', kind: 'file-path' }
    }
  }

  if (text) {
    try {
      const textOptions =
        protectedMultilineTextPasteOptions ??
        (forceBracketedMultilineTextPaste ? { forceBracketedPasteForMultiline: true } : undefined)
      const result = await (textOptions ? pasteText(text, textOptions) : pasteText(text))
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
