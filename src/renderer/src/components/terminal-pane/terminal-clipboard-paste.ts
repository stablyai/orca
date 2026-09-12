import {
  isClipboardTextTooLargeError,
  type ReadClipboardTextOptions
} from '../../../../shared/clipboard-text'
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
  pasteFilePaths?: (paths: string[]) => Promise<void>
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
        | 'image-paste-failed'
        | 'image-paste-rejected'
        | 'text-paste-failed'
        | 'text-paste-rejected'
        | 'text-too-large'
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
  // Why: a file copied in Finder/Explorer exposes only its display name as text,
  // so copied files must be resolved before the text flavor is consulted.
  if (readClipboardFilePaths && pasteFilePaths) {
    let filePaths: string[] = []
    try {
      filePaths = await readClipboardFilePaths()
    } catch {
      // Why: an unreadable file flavor must not block ordinary text paste.
    }
    if (filePaths.length > 0) {
      await pasteFilePaths(filePaths)
      return { status: 'pasted', kind: 'file-path' }
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
