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

/** Copied-file pastes skip the image check, except a text-less macOS copy that may be a screenshot tool's picture; the renderer checks files beside real prompt text itself. */
export function shouldProbeClipboardPasteImage(
  probe: ClipboardPasteImageProbe | undefined,
  text: string,
  filePaths: readonly string[],
  platform: NodeJS.Platform
): boolean {
  if (probe === undefined) {
    return false
  }
  if (probe === 'files-without-text') {
    return text === '' && filePaths.length > 0
  }
  if (filePaths.length > 0) {
    return text === '' && platform === 'darwin'
  }
  return probe === 'always' || text === ''
}

/** Everything one paste needs, read from a single clipboard snapshot. */
export type ClipboardPasteContent = {
  text: string
  /** Empty if no files were copied or the host cannot list them. */
  filePaths: string[]
  /** Empty unless requested and the HTML may carry links. */
  linkHtml: string
  /** Null when `imageProbe` skipped the check. */
  hasImage: boolean | null
  /** Why the image check failed; text and files are still usable. */
  imageProbeError?: string
}
