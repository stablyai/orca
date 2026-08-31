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
  onClipboardReadUnavailable?: (error: unknown) => void
}

export type TerminalClipboardPasteResult =
  | { status: 'pasted'; kind: 'image-path' | 'text' }
  | {
      status: 'skipped'
      reason:
        | 'empty'
        | 'clipboard-read-failed'
        | 'image-paste-failed'
        | 'image-paste-rejected'
        | 'text-paste-failed'
        | 'text-paste-rejected'
        | 'text-too-large'
    }

export async function pasteTerminalClipboard({
  readClipboardText,
  saveClipboardImageAsTempFile,
  pasteText,
  connectionId,
  runtimeEnvironmentId,
  forceBracketedMultilineTextPaste = false,
  protectedMultilineTextPasteOptions,
  onTextPasteError,
  onImagePasteError,
  onClipboardReadUnavailable
}: PasteTerminalClipboardDeps): Promise<TerminalClipboardPasteResult> {
  let text = ''
  // Why: a failed read is `unavailable`, never `empty`. Holding the error keeps
  // the image path reachable for image-only clipboards without letting a real
  // read failure be reported to the user as "you copied nothing".
  let readFailure: { error: unknown } | null = null
  try {
    text = await readClipboardText({ maxBytes: TERMINAL_PASTE_MAX_BYTES })
  } catch (error) {
    if (isClipboardTextTooLargeError(error)) {
      onTextPasteError?.(error)
      return { status: 'skipped', reason: 'text-too-large' }
    }
    // Why: browser clipboard text reads can fail for image-only clipboards.
    // Still try the image path so Cmd/Ctrl+V works for screenshots.
    readFailure = { error }
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
      if (readFailure) {
        onClipboardReadUnavailable?.(readFailure.error)
        return { status: 'skipped', reason: 'clipboard-read-failed' }
      }
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
