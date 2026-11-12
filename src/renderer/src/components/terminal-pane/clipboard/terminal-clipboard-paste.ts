import {
  isClipboardTextTooLargeError,
  type ReadClipboardTextOptions
} from '../../../../../shared/clipboard-text'
import { textOnlyLabelsCopiedFiles } from '../../../../../shared/native-chat/input/native-chat-clipboard-event'
import { TERMINAL_PASTE_MAX_BYTES } from '../input/paste/terminal-paste-limits'
import type { TerminalPasteTextOptions } from '../input/paste/terminal-paste-model'

type SaveClipboardImageAsTempFile = (args?: {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
}) => Promise<string | null>

export type TerminalClipboardCopiedFiles = {
  readPaths: () => Promise<string[]>
  hasImage: () => Promise<boolean | null>
  /** Reports its own failures, like a drop. */
  paste: (paths: string[]) => Promise<void>
}

type PasteTerminalClipboardDeps = {
  readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  saveClipboardImageAsTempFile: SaveClipboardImageAsTempFile
  copiedFiles?: TerminalClipboardCopiedFiles
  pasteText: (
    text: string,
    options?: TerminalPasteTextOptions
  ) => boolean | void | Promise<boolean | void>
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  protectedMultilineTextPasteOptions?: TerminalPasteTextOptions
  onTextPasteError?: (error: unknown) => void
  onImagePasteError?: (error: unknown) => void
  /** Fires when the image upload starts, before its path can be pasted (#41502). */
  onImagePasteUploadStart?: () => void
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
  readClipboardText,
  saveClipboardImageAsTempFile,
  copiedFiles,
  pasteText,
  connectionId,
  runtimeEnvironmentId,
  protectedMultilineTextPasteOptions,
  onTextPasteError,
  onImagePasteError,
  onImagePasteUploadStart
}: PasteTerminalClipboardDeps): Promise<TerminalClipboardPasteResult> {
  let text = ''
  // File-manager copies carry the file names as text; read the file list beside it.
  const copiedFilePathsRead = copiedFiles?.readPaths().catch(() => []) ?? Promise.resolve([])
  try {
    text = await readClipboardText({ maxBytes: TERMINAL_PASTE_MAX_BYTES })
  } catch (error) {
    if (isClipboardTextTooLargeError(error)) {
      onTextPasteError?.(error)
      return { status: 'skipped', reason: 'text-too-large' }
    }
    // Image-only clipboards can reject text reads; still try the screenshot path.
  }
  const copiedFilePaths = await copiedFilePathsRead
  // Unlabelled files beside a picture (screenshot tools, Windows image files) keep the image path.
  if (
    copiedFiles &&
    copiedFilePaths.length > 0 &&
    (text
      ? textOnlyLabelsCopiedFiles(text, copiedFilePaths)
      : !(await copiedFiles.hasImage().catch(() => false)))
  ) {
    await copiedFiles.paste(copiedFilePaths)
    return { status: 'pasted', kind: 'file-paths' }
  }
  if (text) {
    try {
      const result = await (protectedMultilineTextPasteOptions
        ? pasteText(text, protectedMultilineTextPasteOptions)
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
    onImagePasteUploadStart?.()
    const filePath = await saveClipboardImageAsTempFile({ connectionId, runtimeEnvironmentId })
    if (!filePath) {
      return { status: 'skipped', reason: 'empty' }
    }
    const result = await pasteText(filePath, {
      // Generated image paths must bypass the Ctrl+C stale-text path.
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
