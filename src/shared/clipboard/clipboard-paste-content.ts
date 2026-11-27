import type { ReadClipboardTextOptions } from './clipboard-text'
import { textOnlyLabelsCopiedFiles } from '../native-chat/input/composer/native-chat-clipboard-event'

export type ReadClipboardPasteContentOptions = ReadClipboardTextOptions & {
  /** Also return the HTML flavor when it may carry links. */
  linkHtml?: boolean
  /** Skip the copied-file list when the paste event already supplied it. */
  skipFilePaths?: boolean
  /** When to check for an image: always, only with no text, or only for copied files with no text. Omitted: never. */
  imageProbe?: ClipboardPasteImageProbe
}

export type ClipboardPasteImageProbe = 'always' | 'without-text' | 'files-without-text'

/** Copied files whose text, if any, only names them: they attach as files, not prompt text. */
export function clipboardCopiesOnlyFiles(text: string, filePaths: readonly string[]): boolean {
  return filePaths.length > 0 && (text === '' || textOnlyLabelsCopiedFiles(text, filePaths))
}

/** Copied-file pastes skip the image check, except a text-less macOS copy that may be a screenshot tool's picture. */
export function shouldProbeClipboardPasteImage(
  probe: ClipboardPasteImageProbe | undefined,
  text: string,
  filePaths: readonly string[],
  filesOnly: boolean,
  platform: NodeJS.Platform
): boolean {
  if (probe === undefined) {
    return false
  }
  if (probe === 'files-without-text') {
    return text === '' && filePaths.length > 0
  }
  if (filesOnly) {
    return text === '' && platform === 'darwin'
  }
  return probe === 'always' || text === ''
}

/** Everything one paste needs, read from a single clipboard snapshot. */
export type ClipboardPasteContent = {
  text: string
  /** Empty if no files were copied or the host cannot list them. */
  filePaths: string[]
  /** `clipboardCopiesOnlyFiles` for this text and file list, computed once per paste. */
  filesOnly: boolean
  /** Empty unless requested and the HTML may carry links. */
  linkHtml: string
  /** False when `imageProbe` skipped the check. */
  hasImage: boolean
  /** Why the image check failed; text and files are still usable. */
  imageProbeError?: string
}
