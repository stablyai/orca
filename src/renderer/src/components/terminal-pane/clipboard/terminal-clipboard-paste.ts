import { isClipboardTextTooLargeError } from '../../../../../shared/clipboard/clipboard-text'
import type {
  ClipboardPasteContent,
  ReadClipboardPasteContentOptions
} from '../../../../../shared/clipboard/clipboard-paste-content'
import { textOnlyLabelsCopiedFiles } from '../../../../../shared/native-chat/input/composer/native-chat-clipboard-event'
import { TERMINAL_PASTE_MAX_BYTES } from '../input/paste/terminal-paste-limits'
import type { TerminalPasteTextOptions } from '../input/paste/terminal-paste-model'

type SaveClipboardImageAsTempFile = (args?: {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
}) => Promise<string | null>

export type TerminalClipboardCopiedFiles = {
  /** Asked only when the clipboard read skipped its image check. */
  hasImage: () => Promise<boolean | null>
  /** Reports its own failures, like a drop. */
  paste: (paths: string[]) => Promise<void>
}

type PasteTerminalClipboardDeps = {
  readClipboardContent: (
    options: ReadClipboardPasteContentOptions
  ) => Promise<ClipboardPasteContent>
  saveClipboardImageAsTempFile: SaveClipboardImageAsTempFile
  copiedFiles?: TerminalClipboardCopiedFiles
  /** Paths from a DOM paste event; Chromium reads CF_HDROP-only copies (e.g. Zoom) that main cannot. */
  eventCopiedFilePaths?: string[]
  pasteText: (text: string, options?: TerminalPasteTextOptions) => boolean | Promise<boolean>
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  protectedMultilineTextPasteOptions?: TerminalPasteTextOptions
  onTextPasteError?: (error: unknown) => void
  onImagePasteError?: (error: unknown) => void
  onLocalImagePasted?: (filePath: string) => void
}

export type TerminalClipboardPasteResult =
  | { status: 'pasted'; kind: 'file-paths' | 'image-path' | 'text' }
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
  readClipboardContent,
  saveClipboardImageAsTempFile,
  copiedFiles,
  eventCopiedFilePaths = [],
  pasteText,
  connectionId,
  runtimeEnvironmentId,
  protectedMultilineTextPasteOptions,
  onTextPasteError,
  onImagePasteError,
  onLocalImagePasted
}: PasteTerminalClipboardDeps): Promise<TerminalClipboardPasteResult> {
  // File-manager copies carry the file names as text; one read returns the file list beside it.
  let content: ClipboardPasteContent = {
    text: '',
    filePaths: [],
    linkHtml: '',
    hasImage: null
  }
  try {
    content = await readClipboardContent({
      maxBytes: TERMINAL_PASTE_MAX_BYTES,
      imageProbe: 'files-without-text'
    })
  } catch (error) {
    if (isClipboardTextTooLargeError(error)) {
      onTextPasteError?.(error)
      return { status: 'skipped', reason: 'text-too-large' }
    }
    // Image-only clipboards can reject text reads; still try the screenshot path.
  }
  const { text } = content
  const copiedFilePaths = content.filePaths.length > 0 ? content.filePaths : eventCopiedFilePaths
  // Unlabelled files beside a picture (screenshot tools, Windows image files) keep the image path.
  if (
    copiedFiles &&
    copiedFilePaths.length > 0 &&
    (text
      ? textOnlyLabelsCopiedFiles(text, copiedFilePaths)
      : !(content.hasImage ?? (await copiedFiles.hasImage().catch(() => false))))
  ) {
    await copiedFiles.paste(copiedFilePaths)
    return { status: 'pasted', kind: 'file-paths' }
  }
  if (text) {
    try {
      const result = await (protectedMultilineTextPasteOptions
        ? pasteText(text, protectedMultilineTextPasteOptions)
        : pasteText(text))
      if (result !== true) {
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
      // Generated image paths must bypass the Ctrl+C stale-text path.
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
    })
    if (result !== true) {
      return { status: 'skipped', reason: 'image-paste-rejected' }
    }
    if (!connectionId && !runtimeEnvironmentId) {
      onLocalImagePasted?.(filePath)
    }
    return { status: 'pasted', kind: 'image-path' }
  } catch (error) {
    onImagePasteError?.(error)
    return { status: 'skipped', reason: 'image-paste-failed' }
  }
}
