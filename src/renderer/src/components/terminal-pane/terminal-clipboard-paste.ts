type PasteTextOptions = {
  forceBracketedPaste?: boolean
  recoverImagePasteWebglAtlas?: boolean
}

type SaveClipboardImageAsTempFile = (args?: {
  connectionId?: string | null
}) => Promise<string | null>

type PasteTerminalClipboardDeps = {
  readClipboardText: () => Promise<string>
  saveClipboardImageAsTempFile: SaveClipboardImageAsTempFile
  pasteText: (text: string, options?: PasteTextOptions) => void
  connectionId?: string | null
  forceBracketedMultilineTextPaste?: boolean
  onImagePasteError?: (error: unknown) => void
}

const MULTILINE_TEXT_RE = /[\r\n]/

export async function pasteTerminalClipboard({
  readClipboardText,
  saveClipboardImageAsTempFile,
  pasteText,
  connectionId,
  forceBracketedMultilineTextPaste = false,
  onImagePasteError
}: PasteTerminalClipboardDeps): Promise<void> {
  let text = ''
  try {
    text = await readClipboardText()
  } catch {
    // Why: browser clipboard text reads can fail for image-only clipboards.
    // Still try the image path so Cmd/Ctrl+V works for screenshots.
  }
  if (text) {
    if (forceBracketedMultilineTextPaste && MULTILINE_TEXT_RE.test(text)) {
      pasteText(text, { forceBracketedPaste: true })
    } else {
      pasteText(text)
    }
    return
  }

  try {
    const filePath = await saveClipboardImageAsTempFile({ connectionId })
    if (!filePath) {
      return
    }
    pasteText(filePath, {
      // Why: a generated clipboard-image path is terminal image injection, not
      // ordinary one-line text. Keep it off the Ctrl+C stale-text paste path.
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
    })
  } catch (error) {
    onImagePasteError?.(error)
  }
}
