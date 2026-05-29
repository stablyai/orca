type PasteTextOptions = {
  forceBracketedPaste?: boolean
}

type SaveClipboardImageAsTempFile = (args?: {
  connectionId?: string | null
}) => Promise<string | null>

type PasteTerminalClipboardDeps = {
  readClipboardText: () => Promise<string>
  saveClipboardImageAsTempFile: SaveClipboardImageAsTempFile
  pasteText: (text: string, options?: PasteTextOptions) => void
  connectionId?: string | null
  onImagePasteError?: (error: unknown) => void
}

export async function pasteTerminalClipboard({
  readClipboardText,
  saveClipboardImageAsTempFile,
  pasteText,
  connectionId,
  onImagePasteError
}: PasteTerminalClipboardDeps): Promise<void> {
  const text = await readClipboardText()
  if (text) {
    pasteText(text)
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
      forceBracketedPaste: true
    })
  } catch (error) {
    onImagePasteError?.(error)
  }
}
