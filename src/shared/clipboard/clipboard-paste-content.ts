import type { ReadClipboardTextOptions } from './clipboard-text'

export type ReadClipboardPasteContentOptions = ReadClipboardTextOptions & {
  /** Also return the HTML flavor when it may carry links. */
  linkHtml?: boolean
  /** Skip the copied-file list when the paste event already supplied it. */
  skipFilePaths?: boolean
  /** When to check for an image: always, only with no text, or only for copied files with no text. Omitted: never. */
  imageProbe?: ClipboardPasteImageProbe
}

export type ClipboardPasteImageProbe = 'always' | 'without-text' | 'files-without-text'

export function shouldProbeClipboardPasteImage(
  probe: ClipboardPasteImageProbe | undefined,
  text: string,
  filePaths: readonly string[]
): boolean {
  switch (probe) {
    case 'always':
      return true
    case 'without-text':
      return text === ''
    case 'files-without-text':
      return text === '' && filePaths.length > 0
    default:
      return false
  }
}

/** Everything one paste needs, read from a single clipboard snapshot. */
export type ClipboardPasteContent = {
  text: string
  /** Empty if no files were copied or the host cannot list them. */
  filePaths: string[]
  /** Empty unless requested and the HTML may carry links. */
  linkHtml: string
  /** False when `imageProbe` skipped the check. */
  hasImage: boolean
  /** Why the image check failed; text and files are still usable. */
  imageProbeError?: string
}
