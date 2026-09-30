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
  saveClipboardImageAsTempFile: SaveClipboardImageAsTempFile
  saveCopiedClipboardImageFileAsTempFile?: SaveClipboardImageAsTempFile
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
  | { status: 'pasted'; kind: 'image-path' | 'text' }
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

async function pasteClipboardImagePath(
  filePath: string,
  pasteText: PasteTerminalClipboardDeps['pasteText']
): Promise<TerminalClipboardPasteResult> {
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
}

export async function pasteTerminalClipboard({
  readClipboardText,
  saveClipboardImageAsTempFile,
  saveCopiedClipboardImageFileAsTempFile,
  pasteText,
  connectionId,
  runtimeEnvironmentId,
  forceBracketedMultilineTextPaste = false,
  protectedMultilineTextPasteOptions,
  onTextPasteError,
  onImagePasteError
}: PasteTerminalClipboardDeps): Promise<TerminalClipboardPasteResult> {
  if (saveCopiedClipboardImageFileAsTempFile) {
    // Why: a macOS Finder-copied image also carries its filename as text, which
    // would otherwise win and paste only "Screenshot ….png".
    try {
      const filePath = await saveCopiedClipboardImageFileAsTempFile({
        connectionId,
        runtimeEnvironmentId
      })
      if (filePath) {
        return await pasteClipboardImagePath(filePath, pasteText)
      }
    } catch (error) {
      onImagePasteError?.(error)
      return { status: 'skipped', reason: 'image-paste-failed' }
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
    return await pasteClipboardImagePath(filePath, pasteText)
  } catch (error) {
    onImagePasteError?.(error)
    return { status: 'skipped', reason: 'image-paste-failed' }
  }
}
